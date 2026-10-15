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
| Identity | Keycloak OIDC, confidential client `snowfall-bff`, PKCE S256 + PAR, ID token validated by `openid-client` (signature, iss, aud, exp, nonce, state). UI language relayed with `ui_locales` (closed list). |
| Sessions | BFF pattern: no token in the browser. Opaque session cookie `HttpOnly`, `SameSite=Strict`, `__Host-`/`Secure` over HTTPS. Server-side store (SHA-256 of token), 30 min idle, 10 h absolute, revalidated with Keycloak every 4 min (refresh-token rotation). OIDC Back-Channel Logout: Keycloak's `logout_token` (signature via JWKS, iss, aud, age ≤ 5 min, event claim, no nonce, `jti` replay cache) closes the matching session (`sid`) immediately. |
| Accounts | Password policy (12+ chars, history 5), brute-force lockout after 5 failures, verified e-mail, mandatory TOTP enrolment, no self-registration, no offline tokens. SMTP configured (Mailpit in development, authenticated STARTTLS/TLS required in production) for e-mail verification and password reset. |
| Provisioning | No open sign-up. An unknown identity is linked only through a pending invitation matching its Keycloak-verified e-mail, or through SSO: the ID token's `organization` claim must carry the alias of a Keycloak organization linked by an owner (Entra ID / Google Workspace brokered by Keycloak). An e-mail already bound to another identity is never relinked. Done by `snowfall_provision_identity` (SECURITY DEFINER). |
| Organization governance | Member roles changed and members removed only through SECURITY DEFINER functions scoped to the tenant context: owner/admin only, nobody changes their own role, only an owner touches or appoints an owner, SSO linking reserved to owners. The application role still has no write access to `organization_members`. Removing a member deletes their conversations in the organization (right to erasure). |
| Quotas and providers | Per-organization allow-list of AI providers (enforced on generation, agent creation and the catalog) and monthly token limits (organization-wide and per provider), checked before every generation. Usage aggregated per month, provider and member; interrupted answers counted (estimated when the provider reports nothing). Refusals audited. |
| Authorization | Deny-by-default `onRequest` hook (routes must opt into `public`), role check on writes, tenant resolved from DB memberships only. |
| CSRF | `Origin` must equal `APP_ORIGIN` on every non-GET request, plus `SameSite=Strict`. |
| Tenant isolation | Explicit `(organization_id, user_id)` filters + composite FKs + PostgreSQL RLS (`FORCE`) driven by a transaction-scoped tenant context. |
| Database privileges | Separate roles: superuser (setup only), `snowfall_migrator` (schema owner), `snowfall_app` (minimal per-table grants, `NOBYPASSRLS`, statement timeout). Keycloak in its own database and role. |
| Encryption at rest | Message contents, titles, project names, agent profiles and attachments (name, content, extracted text) encrypted with AES-256-GCM using a per-organization key (DEK). DEKs wrapped by a KMS: HashiCorp Vault / OpenBao Transit (`KMS_PROVIDER=vault`, derived key bound to organization and version) or, in development, a KEK derived from `SNOWFALL_MASTER_KEY`. AAD binds every ciphertext to its tenant/row. DB constraints reject plaintext. Session secrets encrypted too. |
| Key rotation | `npm run keys:rotate -- --kek` rewraps every DEK with the active KEK (Transit `rewrap` after a Vault key rotation, or migration from the local KEK to the KMS); `--dek [--org] [--reencrypt]` creates a new DEK version used immediately for writes and optionally re-encrypts existing data. Verified end-to-end against OpenBao 2.6.3. |
| Transport | `sslmode=verify-full` enforced for PostgreSQL in production; HTTPS required for `APP_ORIGIN`/issuer in production; TLS 1.3 on PostgreSQL in `compose.prod.yaml`. |
| Audit | Keycloak user and admin events (180 days). Application `audit_events` table: logins, provisioning, logouts, back-channel and session revocations, denied writes, cross-tenant access attempts, CSRF rejections, CSP violations, quota refusals, conversation, project, attachment, member, invitation, settings and SSO changes. Append-only (INSERT-only grant + trigger). No message content, e-mail address, tokens or secrets. |
| Audit retention and SIEM | Each event is also emitted as one JSON line on the API output (`AUDIT_STDOUT`, for Vector/Fluent Bit) and, optionally, batched to a SIEM over HTTPS (`SIEM_WEBHOOK_URL`, JSON or Splunk HEC, bounded queue, retries, dropped events reported). Retention `AUDIT_RETENTION_DAYS` (default 365): `npm run audit:purge` (migration role only) archives to JSONL then deletes; the trigger refuses any deletion younger than 90 days or without `snowfall.audit_purge`, and each purge is itself audited. |
| Logging | Authorization/cookie headers redacted, query strings never logged. |
| Rate limiting | 300 req/min per IP, 20 login attempts/min per IP, 20 messages/min per user; Redis store for multi-instance; explicit `TRUST_PROXY`. |
| Agents | Org-shared agents (provider + model + instructions + avatar). Name, avatar and instructions encrypted per organization; RLS on `agents`; composite FK forbids linking a conversation to another organization's agent. Only the author or an owner/admin can edit or delete. Model allow-list: a provider must be configured server-side and the model must appear in its live catalog. Avatar images: PNG/JPEG/WebP only, verified by magic bytes, ≤150 KB, re-encoded client-side (strips EXIF/GPS); SVG refused. Agent instructions are wrapped after the platform rules, which they cannot replace. |
| AI provider | Mistral, OpenAI, Anthropic (official SDK, server-side refusal fallback), Google Gemini (REST API without SDK to limit dependencies; key sent in the `x-goog-api-key` header, never in the URL; provider error bodies discarded; safety blocks mapped to a refusal) and OpenAI-compatible local servers (base URL from config only, never from users). Only the current message and the last 20 turns of the same conversation are sent, with a fixed system prompt. Output capped (`LLM_MAX_OUTPUT_TOKENS`), hard timeout (`LLM_TIMEOUT_MS`), generation aborted when the client disconnects, nothing persisted on failure. Model id and token counts audited, never content. The local `echo` model is refused in production. |
| Output rendering | Assistant answers rendered as Markdown by an in-house parser (no third-party dependency) producing React elements only: no `dangerouslySetInnerHTML`, raw HTML shown as text. Links limited to `https`/`http`/`mailto`, opened with `noopener noreferrer`. Images are never loaded (blocks prompt-injection exfiltration through image URLs). Parser regexes reviewed for catastrophic backtracking; tests in `apps/web/tests`. |
| Attachments | PDF, DOCX, text, CSV, JSON, PNG, JPEG, WebP only, identified by magic bytes (never by extension or declared type); 10 MB (5 MB images), 10 pending per conversation, upload rate-limited. Images re-encoded in the browser (EXIF/GPS stripped). Text extracted in an isolated worker thread (256 MB heap cap, 20 s timeout, ZIP-bomb ceiling, pdf.js without code evaluation). Extracted text is sent to models inside `<document>` tags declared untrusted by the system prompt, with per-request budgets. Downloads served as `attachment` with `nosniff` and `sandbox` CSP; unsent files purged after 24 h. |
| Content-Security-Policy | nginx (`infra/nginx`) serves the UI with a strict CSP (`default-src 'none'`, scripts and styles from self only, no inline code, Trusted Types enforced, `frame-ancestors 'none'`), HSTS, COOP/COEP/CORP, Permissions-Policy and reports to `/api/security/csp-report` (audited, blocked origin only). TLS 1.3 only. |
| Supply chain | CI actions pinned by commit SHA, least-privilege tokens, CodeQL (`security-extended`), CycloneDX SBOM (`npm sbom`), Trivy scans of both images and of Docker/compose configuration, gitleaks, `npm audit`. Dependabot with a 14-day cooldown for npm, actions, Dockerfiles and compose. Base images pinned by digest, system packages upgraded at build, both containers run as non-root, read-only, all capabilities dropped. |
| Backups | `pg_dump` piped to `age` (never plaintext on disk), checksum, restore script. |

## 12. Known gaps

- `SNOWFALL_MASTER_KEY` still protects session secrets and the login transaction
  cookie (short-lived data), even with the KMS: inject it from the secret manager.
- The Vault token is static: prefer AppRole or Kubernetes auth with short TTLs.
- SSO federation (Entra ID, Google Workspace) is configured in Keycloak by an
  operator; it has been verified with a Keycloak organization, not yet against a
  real Entra ID or Google Workspace tenant.
- Search decrypts the user's 200 most recent conversations on the server: fine for
  current volumes, a blind index will be needed at scale.
- AI providers: sign each provider's DPA (Mistral, OpenAI, Anthropic, Google), confirm data
  location and retention (request zero data retention where eligible), list them as
  subprocessors.
- Monitoring, alerting, incident response and periodic restore tests require
  owners and evidence.

## 13. Change control

Any security-sensitive change must document its purpose, risks, tests, rollback plan,
and evidence. Database migrations require explicit review and approval.
