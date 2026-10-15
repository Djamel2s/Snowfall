import { createRemoteJWKSet, jwtVerify } from "jose";
import * as oidc from "openid-client";
import { deriveKey, open, seal } from "../crypto/envelope.js";
import type { OidcTokens, UserProfile } from "./session-store.js";

const LOGIN_TRANSACTION_SECONDS = 10 * 60;

export type LoginTransaction = {
  state: string;
  nonce: string;
  codeVerifier: string;
  createdAt: number;
};

export type CompletedLogin = {
  subject: string;
  tokens: OidcTokens;
  profile: UserProfile;
  /** Session Keycloak (claim sid), cible de la déconnexion back-channel. */
  sessionId?: string | undefined;
  emailVerified: boolean;
  /** Alias des organisations Keycloak du compte (claim "organization"). */
  organizations: string[];
};

export type LogoutTarget = { sid?: string; subject?: string };

export interface OidcClient {
  startLogin(options?: { locale?: string }): Promise<{ authorizationUrl: string; transaction: LoginTransaction }>;
  completeLogin(callbackUrl: URL, transaction: LoginTransaction): Promise<CompletedLogin>;
  refresh(refreshToken: string, expectedSubject: string): Promise<OidcTokens | null>;
  logoutUrl(idToken: string): Promise<string>;
  /** Vérifie un logout_token (OIDC Back-Channel Logout 1.0) ; null si invalide. */
  verifyLogoutToken?(token: string): Promise<LogoutTarget | null>;
}

const BACKCHANNEL_EVENT = "http://schemas.openid.net/event/backchannel-logout";

/** Claim "organization" de Keycloak : liste d'alias, ou objet { alias: {...} }. */
export function organizationAliases(claim: unknown): string[] {
  const aliases = Array.isArray(claim)
    ? claim
    : claim && typeof claim === "object"
      ? Object.keys(claim)
      : [];
  return aliases.filter((alias): alias is string => typeof alias === "string" && /^[a-z0-9][a-z0-9-]{1,62}$/.test(alias));
}

/**
 * Règles de la spécification Back-Channel Logout, une fois la signature, iss,
 * aud et l'âge vérifiés : événement présent, pas de nonce, sid ou sub, jti.
 */
export function logoutTargetFromClaims(claims: Record<string, unknown>): LogoutTarget | null {
  const events = claims.events;
  if (!events || typeof events !== "object" || !(BACKCHANNEL_EVENT in events)) return null;
  if ("nonce" in claims) return null;
  if (typeof claims.jti !== "string" || claims.jti === "") return null;

  const target: LogoutTarget = {};
  if (typeof claims.sid === "string" && claims.sid) target.sid = claims.sid;
  if (typeof claims.sub === "string" && claims.sub) target.subject = claims.sub;
  return target.sid || target.subject ? target : null;
}

/**
 * Transaction de connexion (state, nonce, PKCE) conservée dans un cookie
 * chiffré et authentifié : impossible à lire ou à forger côté navigateur.
 */
export class LoginTransactionCodec {
  private readonly key: Buffer;

  constructor(masterKey: Buffer) {
    this.key = deriveKey(masterKey, "login-transaction/v1");
  }

  encode(transaction: LoginTransaction) {
    return seal(this.key, JSON.stringify(transaction), "login-transaction");
  }

  decode(value: string | undefined, now = Date.now()): LoginTransaction | null {
    if (!value) return null;

    try {
      const parsed = JSON.parse(
        open(this.key, value, "login-transaction").toString("utf8"),
      ) as LoginTransaction;

      const age = (now - parsed.createdAt) / 1000;
      if (age < 0 || age > LOGIN_TRANSACTION_SECONDS) return null;

      return parsed;
    } catch {
      return null;
    }
  }

  static readonly maxAgeSeconds = LOGIN_TRANSACTION_SECONDS;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export class KeycloakOidcClient implements OidcClient {
  private configuration: Promise<oidc.Configuration> | undefined;
  private jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
  // Anti-rejeu des logout_token (jti vus récemment).
  private readonly seenLogoutTokens = new Map<string, number>();

  constructor(
    private readonly settings: {
      issuer: string;
      clientId: string;
      clientSecret: string;
      appOrigin: string;
      allowInsecureHttp: boolean;
      /** Scopes en plus de "openid profile email" (ex. "organization" pour le SSO). */
      extraScopes?: string[];
    },
  ) {}

  get redirectUri() {
    return `${this.settings.appOrigin}/api/auth/callback`;
  }

  private config() {
    this.configuration ??= oidc
      .discovery(
        new URL(this.settings.issuer),
        this.settings.clientId,
        this.settings.clientSecret,
        undefined,
        {
          timeout: 10,
          ...(this.settings.allowInsecureHttp
            ? { execute: [oidc.allowInsecureRequests] }
            : {}),
        },
      )
      .catch((error: unknown) => {
        this.configuration = undefined;
        throw error;
      });

    return this.configuration;
  }

  async startLogin(options: { locale?: string } = {}) {
    const config = await this.config();
    const transaction: LoginTransaction = {
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      codeVerifier: oidc.randomPKCECodeVerifier(),
      createdAt: Date.now(),
    };

    // PAR (RFC 9126) : les paramètres d'autorisation ne transitent pas par
    // le navigateur et ne peuvent pas être altérés.
    const url = await oidc.buildAuthorizationUrlWithPAR(config, {
      redirect_uri: this.redirectUri,
      scope: ["openid", "profile", "email", ...(this.settings.extraScopes ?? [])].join(" "),
      response_type: "code",
      // Langue de l'interface transmise à la page de connexion Keycloak.
      ...(options.locale ? { ui_locales: options.locale } : {}),
      state: transaction.state,
      nonce: transaction.nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(transaction.codeVerifier),
      code_challenge_method: "S256",
    });

    return { authorizationUrl: url.href, transaction };
  }

  async completeLogin(callbackUrl: URL, transaction: LoginTransaction) {
    const config = await this.config();

    // Vérifie state, PKCE, puis l'ID token : signature, iss, aud, exp, nonce.
    const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: transaction.codeVerifier,
      expectedState: transaction.state,
      expectedNonce: transaction.nonce,
      idTokenExpected: true,
    });

    const claims = tokens.claims();
    if (!claims || typeof claims.sub !== "string" || claims.sub === "") {
      throw new Error("ID_TOKEN_SUBJECT_MISSING");
    }
    if (!tokens.refresh_token || !tokens.id_token) {
      throw new Error("TOKENS_MISSING");
    }

    const profile: UserProfile = {};
    const name = optionalString(claims.name);
    const email = optionalString(claims.email);
    const username = optionalString(claims.preferred_username);
    if (name) profile.name = name;
    if (email) profile.email = email;
    if (username) profile.username = username;

    return {
      subject: claims.sub,
      tokens: { refreshToken: tokens.refresh_token, idToken: tokens.id_token },
      profile,
      sessionId: optionalString(claims.sid),
      emailVerified: claims.email_verified === true,
      organizations: organizationAliases(claims.organization),
    };
  }

  async verifyLogoutToken(token: string): Promise<LogoutTarget | null> {
    const config = await this.config();
    const metadata = config.serverMetadata();
    if (!metadata.jwks_uri) return null;
    this.jwks ??= createRemoteJWKSet(new URL(metadata.jwks_uri), { timeoutDuration: 5_000 });

    let claims: Record<string, unknown>;
    try {
      ({ payload: claims } = await jwtVerify(token, this.jwks, {
        issuer: metadata.issuer,
        audience: this.settings.clientId,
        algorithms: ["RS256", "PS256", "ES256"],
        maxTokenAge: "5 minutes",
        clockTolerance: 30,
      }));
    } catch {
      return null;
    }

    const target = logoutTargetFromClaims(claims);
    if (!target) return null;

    const now = Date.now();
    for (const [jti, expiry] of this.seenLogoutTokens) if (expiry < now) this.seenLogoutTokens.delete(jti);
    const jti = claims.jti as string;
    if (this.seenLogoutTokens.has(jti)) return null;
    this.seenLogoutTokens.set(jti, now + 10 * 60 * 1000);

    return target;
  }

  async refresh(refreshToken: string, expectedSubject: string) {
    const config = await this.config();

    try {
      const tokens = await oidc.refreshTokenGrant(config, refreshToken);
      const claims = tokens.claims();

      if (!tokens.refresh_token || !tokens.id_token || claims?.sub !== expectedSubject) {
        return null;
      }

      return { refreshToken: tokens.refresh_token, idToken: tokens.id_token };
    } catch (error) {
      if (error instanceof oidc.ResponseBodyError && error.error === "invalid_grant") {
        return null;
      }
      throw error;
    }
  }

  async logoutUrl(idToken: string) {
    const config = await this.config();
    return oidc
      .buildEndSessionUrl(config, {
        id_token_hint: idToken,
        post_logout_redirect_uri: `${this.settings.appOrigin}/`,
      })
      .toString();
  }
}
