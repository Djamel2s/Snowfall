# Snowfall — Security Baseline

Status: Initial baseline — controls require implementation and evidence.
Owner: Snowfall engineering
Review: Before production and after material architecture changes.

## 1. Objectives

- Security and privacy by design and by default.
- Least privilege and deny-by-default authorization.
- Strict tenant isolation.
- Data minimization and documented retention.
- Auditable security controls and incident response.
- No claim of certification without independent assessment.

## 2. Data classification

- Public: explicitly approved for public release.
- Internal: operational information not intended for public release.
- Confidential: customer data, business information, identifiers and conversations.
- Restricted: credentials, session tokens, cryptographic keys and highly sensitive data.

Never commit secrets. Never log credentials, tokens, or sensitive message contents.
Do not send confidential or restricted data to AI providers without an approved
purpose, data-flow review, contractual review, and appropriate technical controls.

## 3. Identity and access

- Use a managed identity provider for OIDC/SAML; do not implement protocols ourselves.
- Validate issuer, audience, signature, state, nonce, expiry and redirect URI as applicable.
- Use secure, HttpOnly cookies with an appropriate SameSite policy.
- Implement server-side session expiry and revocation.
- Require MFA for privileged accounts where supported and appropriate.
- Enforce authorization on every protected server-side operation.
- Never trust client-supplied user IDs, tenant IDs, or roles.

## 4. Tenant isolation

- Resolve tenant membership from trusted server-side identity and database records.
- Deny access when tenant membership or permissions cannot be verified.
- Test cross-tenant read, write, export, search, and administrative access.
- Apply tenant scope to database queries and background jobs.
- Review tenant isolation before introducing customer data.

## 5. Data protection

- Use TLS for network traffic and managed encryption at rest.
- Restrict production and support access using least privilege.
- Document purposes, legal bases where applicable, retention, deletion, and backups.
- Review data residency, subprocessors, international transfers, and contracts.
- Establish a process for data access and deletion requests.
- Assess whether a DPIA is required before high-risk personal-data processing.

## 6. Application and AI security

- Validate inputs and enforce request size limits.
- Apply rate limits and abuse controls to authentication and expensive endpoints.
- Protect browser session flows against CSRF where applicable.
- Keep dependencies patched and scan them continuously.
- Treat user content and retrieved documents as untrusted input.
- Prevent prompt injection from granting tools or access beyond explicit authorization.
- Minimize AI-provider payloads and prevent sensitive data from entering logs.
- Require explicit authorization for tools that read, modify, or export customer data.

## 7. Logging and monitoring

- Record security-relevant events, authentication outcomes, permission changes,
  administrative actions, and suspected tenant-isolation violations.
- Exclude passwords, tokens, keys, and unnecessary personal or message content.
- Restrict and monitor access to logs; protect integrity and define retention.
- Define alerting, incident ownership, escalation, and evidence preservation.

## 8. Infrastructure and recovery

- Keep secrets outside source control and use managed secret storage in production.
- Restrict database network exposure and use separate least-privilege credentials.
- Encrypt backups and test restoration periodically.
- Document recovery objectives and incident-response procedures.
- Separate development, test, and production environments.

## 9. Secure development and release

- Require review for security-sensitive changes.
- Run tests, type checks, linting, dependency and secret scans in CI.
- Maintain a threat model, asset inventory, risk register, and remediation tracking.
- Test authorization failures and cross-tenant access, not only successful paths.
- Do not deploy until critical security requirements have evidence and owners.

## 10. Certification and compliance

Potential targets to assess against business scope and customer requirements:
- GDPR obligations applicable to each processing activity.
- ISO/IEC 27001:2022 information security management system.
- ISO/IEC 27701 privacy information management, where appropriate.
- SOC 2, if required by target customers.

This baseline is not evidence of compliance or certification. Each control must have
an implementation status, an owner, verification evidence, and a review date.

## 11. Implemented controls (2026-10-14)

Evidence: automated tests (`apps/api/src/**/*.test.ts`) and an end-to-end run
against a real Keycloak (login with TOTP enrolment, encryption at rest, CSRF,
IdP-side revocation, logout).

| Control | Implementation |
|---|---|
| Identity | Keycloak OIDC, confidential client `snowfall-bff`, PKCE S256 + PAR, ID token validated by `openid-client` (signature, iss, aud, exp, nonce, state). |
| Sessions | BFF pattern: no token in the browser. Opaque session cookie `HttpOnly`, `SameSite=Strict`, `__Host-`/`Secure` over HTTPS. Server-side store (SHA-256 of token), 30 min idle, 10 h absolute, revalidated with Keycloak every 4 min (refresh-token rotation). |
| Accounts | Password policy (12+ chars, history 5), brute-force lockout after 5 failures, verified e-mail, mandatory TOTP enrolment, no self-registration, no offline tokens. |
| Authorization | Deny-by-default `onRequest` hook (routes must opt into `public`), role check on writes, tenant resolved from DB memberships only. |
| CSRF | `Origin` must equal `APP_ORIGIN` on every non-GET request, plus `SameSite=Strict`. |
| Tenant isolation | Explicit `(organization_id, user_id)` filters + composite FKs + PostgreSQL RLS (`FORCE`) driven by a transaction-scoped tenant context. |
| Database privileges | Separate roles: superuser (setup only), `snowfall_migrator` (schema owner), `snowfall_app` (minimal per-table grants, `NOBYPASSRLS`, statement timeout). Keycloak in its own database and role. |
| Encryption at rest | Message contents and titles encrypted with AES-256-GCM using a per-organization key (DEK), wrapped by a KEK derived from `SNOWFALL_MASTER_KEY`. AAD binds every ciphertext to its tenant/row. DB constraints reject plaintext. Session secrets encrypted too. |
| Transport | `sslmode=verify-full` enforced for PostgreSQL in production; HTTPS required for `APP_ORIGIN`/issuer in production; TLS 1.3 on PostgreSQL in `compose.prod.yaml`. |
| Audit | Keycloak user and admin events (180 days). Application `audit_events` table: logins, logouts, session revocations, denied writes, cross-tenant access attempts, CSRF rejections, conversation lifecycle. Append-only (INSERT-only grant + trigger). No message content, tokens or secrets. |
| Logging | Authorization/cookie headers redacted, query strings never logged. |
| Rate limiting | 300 req/min per IP, 20 login attempts/min per IP, 20 messages/min per user; Redis store for multi-instance; explicit `TRUST_PROXY`. |
| Backups | `pg_dump` piped to `age` (never plaintext on disk), checksum, restore script. |

## 12. Known gaps

- KEK is derived locally from an environment secret: move it to a KMS/HSM
  (`KeyEncryptionProvider` interface) before production. Key rotation is supported
  by the schema (`organization_keys.version`) but no rotation job exists yet.
- Keycloak back-channel logout is not consumed: IdP-side revocation takes up to 4 min.
- SMTP is not configured (required for e-mail verification and password reset).
- Audit log retention/purge procedure and log shipping to a SIEM are not defined.
- No Content-Security-Policy is defined for the production web server yet.
- CI: actions not pinned by SHA, no SAST, no SBOM, no container image scanning.
- AI provider data handling and contractual controls require formal review.
- Monitoring, alerting, incident response and periodic restore tests require
  owners and evidence.

## 13. Change control

Any security-sensitive change must document its purpose, risks, tests, rollback plan,
and evidence. Database migrations require explicit review and approval.
