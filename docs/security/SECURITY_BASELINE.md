# Snowfall — Security Baseline

Status: Baseline with implemented controls (§11, last extended 2026-10-17) — each control still needs an owner and a review date.
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
| Knowledge bases | One base per agent (shared in the organization, managed by the agent's author or an admin) and one per project (private to its owner), usable together or separately per conversation. Source names, URLs, original files, extracted passages and embedding vectors are all encrypted with the organization DEK (AAD per base/source/passage); search runs in memory after decryption (BM25 keywords + cosine on vectors, fused by RRF), never inside the database, with a bounded, revision-checked cache. RLS (`FORCE`) on bases, sources and passages; visibility (`user_id`) is copied from the base by database triggers, never supplied by the application; passages are immutable for the application role; the import queue (`knowledge_jobs`, identifiers only) has no grant at all and is read through a SECURITY DEFINER function. Formats detected by signature and internal structure (PDF, Word, Excel, PowerPoint, OpenDocument, EPUB, HTML, Markdown, CSV, JSON, code), 25 MB, 200 sources and 50 000 passages per base; extraction in the isolated worker (heap cap, 90 s timeout, ZIP-bomb ceiling, linear HTML parser). Embeddings: none by default (keywords only, nothing leaves); an admin may pick a configured and allowed provider, metered against quotas. **Confidential** bases never send anything outside the platform: embeddings local only, generation refused (409, audited) unless the answering model is local, and an agent with a confidential base cannot move to an external model. Passages are injected inside `<knowledge>` tags declared untrusted by the system prompt, with closing tags neutralized and a 20 000-character budget; cited sources are stored encrypted with the answer. |
| Retrieval quality | Evaluated, not assumed: a fixed French evaluation set (`retrieval.eval.test.ts`, fictitious corpus, paraphrased and follow-up questions) fails CI on regression. Pipeline: structure-aware chunking (headings from Markdown, Word styles, HTML, OpenDocument; PDF/slide page numbers), contextual headers (document + section) indexed and embedded with each passage, Savoy light French stemmer (as in Lucene), follow-up questions rewritten into standalone queries by the conversation's own model (no new data recipient; local for confidential bases) with a heuristic fallback, optional cross-encoder reranking on a platform-hosted service (an external reranker is never used for confidential bases), citations carrying section and page. |
| Malware scanning | Every received file (chat attachments, knowledge-base files, content fetched from links) is scanned by ClamAV (clamd INSTREAM, in memory, never written to disk) before any parsing or storage. Fail-closed: infected → 422, scanner unreachable/timeout/limit exceeded → 503, both audited (`security.malware_detected` with signature name, `security.scan_unavailable`). clamd flags encrypted archives, Office macros, broken executables and anything beyond scan limits. Runs non-root, read-only, no capabilities, internal network only; signatures refreshed every 2 h through the egress proxy. Verified against ClamAV 1.5.4 with the EICAR file (raw and nested in a docx) and an encrypted ZIP. |
| Network egress | In production the API, database and ClamAV sit on an internal Docker network with no route to the Internet. Their only way out is a Squid egress proxy (non-root, read-only, no cache, no forwarding headers, every connection logged) that resolves names itself and denies internal/reserved destinations (blocks DNS rebinding at network level), allows only listed domains (AI providers, ClamAV mirrors, IdP, SIEM) plus an explicit list for knowledge links, standard ports only. Node's native proxy support (`NODE_USE_ENV_PROXY`) carries provider SDK traffic; link import tunnels HTTPS with CONNECT and verifies certificates end to end (expired and self-signed certificates refused in tests against the real proxy). nginx has a fixed internal address, the only trusted proxy. |
| Web links (SSRF) | http(s) only, standard ports, no credentials in URLs, internal names refused; every resolved address checked at connection time (custom DNS lookup: defeats DNS rebinding) against private, loopback, link-local/cloud metadata, CGNAT, multicast, reserved and IPv4-mapped IPv6 ranges; redirects followed manually and revalidated (max 3); 15 MB, 20 s, identity encoding only, no cookies, no shared connection pool. Optional per-organization domain allow-list, organization switch and platform kill switch (`KNOWLEDGE_LINKS=off`). Refused links audited without the URL. |
| Content-Security-Policy | nginx (`infra/nginx`) serves the UI with a strict CSP (`default-src 'none'`, scripts and styles from self only, no inline code, Trusted Types enforced, `frame-ancestors 'none'`), HSTS, COOP/COEP/CORP, Permissions-Policy and reports to `/api/security/csp-report` (audited, blocked origin only). TLS 1.3 only. |
| Supply chain | CI actions pinned by commit SHA, least-privilege tokens, CodeQL (`security-extended`), CycloneDX SBOM (`npm sbom`), Trivy scans of both images and of Docker/compose configuration, gitleaks, `npm audit`. Dependabot with a 14-day cooldown for npm, actions, Dockerfiles and compose. Base images pinned by digest, system packages upgraded at build, both containers run as non-root, read-only, all capabilities dropped. |
| KMS authentication | AppRole: the API holds a role ID and a secret ID mounted as a Docker secret (never an environment variable, re-read at each login so it can be rotated without restart); it obtains 1 h tokens (24 h max) bound to the internal network CIDR, renews them before expiry, re-authenticates on expiry or revocation (verified against OpenBao 2.6.4: TTL, max TTL, revocation, CIDR refusal, invalid secret). Static tokens are refused in production. Policy `snowfall-api`: encrypt/decrypt/rewrap on the `snowfall` Transit key only (no read, export, rotate or delete; deletion disabled on the key). OpenBao: Raft storage, TLS 1.3, audit device declared in configuration (cannot be disabled through the API), Shamir unseal keys split between people. |
| Backups | Daily scheduled service: `pg_dump` by a read-only `BYPASSRLS` role (complete dump despite RLS, no write access), encrypted in-stream with `age` for public keys only (offline key + restore-test key; no private key on the server), SHA-256 manifest with per-table row counts, optional immutable off-site copy (rclone, object lock) through the egress proxy, local retention, `backup_ok`/`backup_failed` alerts. Monthly restore test (`backup-verify`, no network): restores into a throwaway PostgreSQL inside the container and checks checksums, decryption, row counts per table, migrations and that messages remain ciphertext; reports duration (measured RTO). Verified: tampered file, tampered file with recomputed checksums (caught by age authentication), wrong key and incomplete backup are all detected with a precise reason. |
| Monitoring | Prometheus (API metrics on an internal port with a bearer token; bounded labels only: route templates, provider, audit event type; no user, tenant or content), PostgreSQL exporter with a `pg_monitor`-only role, Alertmanager (e-mail, secret from file), Loki fed by Grafana Alloy reading Docker log files read-only (no Docker socket), Grafana on loopback only (no anonymous access, no sign-up, no external snapshots, no telemetry). Alerts on availability, error rate, latency, model failures, malware, scanner outage, cross-tenant access bursts, CSRF, authentication failures, denied writes, SSRF attempts, confidential-knowledge misuse, missing or failed backups, egress denials and KMS refusals. All configurations validated with promtool, amtool, Loki and Alloy, and the pipeline verified live. |
| Local AI | Embeddings (`BAAI/bge-m3`) and reranking (`BAAI/bge-reranker-v2-m3`) served by Text Embeddings Inference on the internal network, models cached in a volume and served offline: required for confidential knowledge bases, nothing leaves the platform. Retrieval quality measured with `npm run knowledge:eval` through the production code path, on the evaluation set or the organization's own documents: recall@3 0.84 (keywords) → 0.96 (hybrid with bge-m3) → 1.00 (with reranking of 10 candidates) on the fictitious set. |

### Agent platform controls (2026-10-17)

Evidence: `apps/api/src/**/*.test.ts` (unit, route and PostgreSQL integration
tests, including attack paths), the sandbox attack battery
(`scripts/sandbox-attack.sh`, run in CI), browser tests (`apps/web/e2e`, desktop
and mobile, run in CI), the agent evaluation set (`npm run agent:eval`), and two
adversarial code reviews whose findings were all fixed and covered by tests
(see `docs/learning/09-mcp.md` and `10-evaluations.md`). Threat model:
[THREAT_MODEL.md](THREAT_MODEL.md). DPIA draft: [AIPD.md](AIPD.md).

| Control | Implementation |
|---|---|
| Tool authorization | Three layers, all deny-by-default: platform (a tool exists only if its service is configured), organization (admin enables it), agent (author selects it). A tool absent from one layer is never offered to the model. Write tools require a preview, and each call needs the user's approval *after* argument validation (what is approved is exactly what runs). |
| Untrusted content | Every tool result, retrieved passage, attachment, web page, MCP result and compaction summary is wrapped in a dedicated tag declared untrusted by the platform prompt. Tag stripping is repeated until stable (`security/neutralize.ts`): nested payloads such as `</sou<source>rce>` cannot rebuild a closing tag. Results cannot grant tools or rights. |
| Durable runs | A response is a run persisted in the database; HTTP connections only observe it (SSE). Graph checkpoints, pending writes, progress and approvals are encrypted with the organization DEK, under FORCE RLS. A lease (30 s, renewed) lets another instance resume after a crash; approvals expire after 24 h (refused). Only the run's owner can see or decide an approval. |
| Per-response limits | Steps (`AGENT_MAX_STEPS`), at most 8 tool calls per step, token budget across steps (`AGENT_MAX_TOKENS`; tools are withdrawn once exceeded and the model must conclude), active duration (`AGENT_MAX_SECONDS`; the run stops, the partial answer is kept with a notice, `agent.run_limit` audited). |
| Tool quotas | Monthly per-organization caps for code runs, web searches/page reads and MCP calls (`tool_limits`), counted in `tool_usage` (FORCE RLS, per member and month). A call over the cap is refused, returned to the model as a result, and audited (`quota.tool_exceeded`). Counted even when the tool fails. Soft cap under concurrency (a few calls may exceed). |
| Web search | Self-hosted SearXNG, reached only through the egress proxy and only towards listed engines. Not offered in confidential conversations; opt-in per organization. `read_webpage` only opens URLs returned by a search of the same response or typed by the user (prevents exfiltration through crafted URLs); safe fetch (SSRF rules, antivirus, isolated extraction). |
| Code interpreter | Dedicated container without network (`network_mode: none`), reached by a Unix socket restricted to the API's group. Each run: dedicated UID per slot, fresh private directory, rlimits (CPU, 1.5 GB, 64 processes, files), empty environment, `umask 077`, `/tmp` and `/dev/shm` closed, read-only system, 4 capabilities, `no-new-privileges`, `init`; every process of the slot UID killed at the end. Produced files: allow-listed types, size caps, no symlinks, antivirus, encrypted at rest; only PNG/JPEG displayed, everything else downloaded with a `sandbox` CSP. **gVisor (`runsc`) is required in production**: the server refuses to start without it (`SANDBOX_REQUIRE_GVISOR=true`). The 15-check attack battery (network, DNS, identity, secrets, API socket, writes outside the directory, `/work` listing, memory and fork bombs, infinite loop, detached process, leaks between runs, symlinks) runs in CI; the image is scanned by Trivy. |
| Artifacts | HTML, SVG and Mermaid rendered in an iframe `sandbox="allow-scripts"` without `allow-same-origin` (opaque origin: no cookies, storage, API or parent access), served with its own CSP (`connect-src 'none'`). Preview mode adds `script-src 'none'`; scripts run only on explicit user action, never inherited across artifacts (panel recreated per opening). Mermaid bundled into the frame (no network). The parent accepts only messages from its own frame; a rendered SVG is only downloaded, never displayed by the app. |
| MCP | Disabled by default (`MCP_ENABLED`); in production refused without the egress proxy, and each server domain must also be opened in `mcp-domains.txt`. Only admins add servers (HTTPS, public address; without proxy, every resolved address is checked). The admin reviews each tool (description, parameter descriptions) and approves the **fingerprint of what was reviewed** (SHA-256 of name, title, description and schema); a change between review and approval is refused (409, audited). The fingerprint is re-checked at every response: a changed tool is blocked (`mcp.tool_changed`). Read/write is decided by the admin; writes need user approval; tool names carry a server-id fragment (stable, no cross-server substitution after a pause); colliding names are all dropped; non-object schemas refused; results truncated then wrapped. URL, token and approved tools encrypted at rest (FORCE RLS); the token is never returned to the UI or audit. Never offered in confidential conversations. |
| Observability | OpenTelemetry GenAI spans exported to a self-hosted Langfuse on the internal network. Personal data masked; no content at all for confidential conversations (`TRACE_CONTENT=masked|none`); traces deleted after 30 days by the API (Langfuse retention is an enterprise feature). Reasoning is streamed but never persisted. |
| Agent quality | Retrieval evaluation in CI; agent evaluation harness running the production loop on a fictitious corpus (RAG, write tools, prompt-injection and exfiltration cases, web); technical errors excluded from rates; regression detection against a baseline. |
| UI verification | Browser tests (Playwright, desktop and mobile) on key journeys: settings by role, sending from the welcome screen, streamed answer, artifact auto-open in preview mode inside the sandboxed frame, download. |

## 12. Known gaps

- `SNOWFALL_MASTER_KEY` still protects session secrets and the login transaction
  cookie (short-lived data), even with the KMS: inject it from the secret manager.
- OpenBao runs as a single node: a 3-node Raft cluster (or a managed HSM-backed
  Vault) is needed for high availability; unseal is manual (Shamir).
- Grafana uses a local admin account: federate it with Keycloak (generic OAuth)
  before giving access to several operators.
- SSO federation (Entra ID, Google Workspace) is configured in Keycloak by an
  operator; it has been verified with a Keycloak organization, not yet against a
  real Entra ID or Google Workspace tenant.
- Search decrypts the user's 200 most recent conversations on the server: fine for
  current volumes, a blind index will be needed at scale.
- Knowledge bases are searched in memory after decryption (up to 50 000 passages
  per base): beyond that, an encrypted vector index will be needed. Audio, video
  and images (OCR) are not indexed yet.
- Retrieval was measured on a fictitious French set: it must be measured again on
  each organization's real documents (`npm run knowledge:eval -- --docs`).
- CPU reranking costs ~2 s per question: a GPU is recommended in production.
- ClamAV is signature-based: it does not replace sandbox detonation for targeted
  attacks; parsing of untrusted files stays isolated in worker threads.
- AI providers: sign each provider's DPA (Mistral, OpenAI, Anthropic, Google), confirm data
  location and retention (request zero data retention where eligible), list them as
  subprocessors.
- Monitoring, alerting, incident response and periodic restore tests require
  owners and evidence.
- Prompt injection: defences are structural (untrusted tags, no tool granted by
  content, approvals, URL allow-list for page reads, MCP fingerprints); there is
  **no detection layer** yet, and the evaluation set has only three injection cases.
- MCP uses one token per server for the whole organization, not per-user OAuth
  (decided limit for now): actions on the remote service are not attributed to
  the individual user there.
- gVisor detection relies on its fixed simulated kernel version; it must be
  verified on the production host (`SANDBOX_RUNTIME=runsc scripts/sandbox-attack.sh`
  must report `Isolation : gvisor`). If the check fails, the sandbox refuses to
  start (fail-closed). CI runs the attack battery with `runc`.
- Tool quotas are soft under concurrency (checked, then counted).
- Browser tests use a mocked API: end-to-end tests against a real Keycloak and
  API are manual.
- No external penetration test yet; the DPIA (`AIPD.md`) is a draft to be
  completed and signed by the data controller.

## 13. Change control

Any security-sensitive change must document its purpose, risks, tests, rollback plan,
and evidence. Database migrations require explicit review and approval.
