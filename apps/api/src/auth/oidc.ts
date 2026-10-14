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
};

export interface OidcClient {
  startLogin(): Promise<{ authorizationUrl: string; transaction: LoginTransaction }>;
  completeLogin(callbackUrl: URL, transaction: LoginTransaction): Promise<CompletedLogin>;
  refresh(refreshToken: string, expectedSubject: string): Promise<OidcTokens | null>;
  logoutUrl(idToken: string): Promise<string>;
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

  constructor(
    private readonly settings: {
      issuer: string;
      clientId: string;
      clientSecret: string;
      appOrigin: string;
      allowInsecureHttp: boolean;
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

  async startLogin() {
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
      scope: "openid profile email",
      response_type: "code",
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
    };
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
