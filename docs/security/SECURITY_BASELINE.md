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
| Key rotation | `npm run keys:rotate -- --kek` rewraps every DEK with the active KEK (Transit `rewrap` after a Vault key rotation, or migration from the local KEK to the KMS); `--dek [--org] [--reencrypt]` creates a new DEK version used immediately for writes and optionally re-encrypts existing data; `--verify` counts, table by table, the values still encrypted with an older version (exit code 2 if any). Re-encryption covers **every** column encrypted with the organization key, from a single inventory (`src/crypto/rotation.ts`) whose AADs are imported from the modules that write them; a test fails if a column the database requires to be encrypted is missing from it. Organization data, each member's data and former members' remaining data (found through the audit trail) are processed under their own RLS context; idempotent. Integration test: a new key version, re-encryption, zero stale value, everything readable through the usual stores. Verified end-to-end against OpenBao 2.6.3. |
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
| Agent quality | Retrieval evaluation in CI; agent evaluation harness running the production loop on a fictitious corpus (RAG, write tools, prompt-injection and exfiltration cases, web); technical errors excluded from rates; regression detection against a baseline. 13 injection cases cover documents, attachments, web pages, memory (poisoned facts), fake tags, fake consent, Markdown-image and search-query exfiltration, a foreign language; one control case checks that a legitimate « remember that… » still works. Attachments go through the production formatter. Last run (Gemini 3.5 Flash-Lite, 2 trials): 50/50. |
| Exfiltration policy (« rule of two ») | A response may not combine, without the user's approval, (1) untrusted content (web page or search results, MCP result, attachment), (2) internal data (knowledge base passages, attachment) and (3) an outbound call (web search, page read, MCP call). Once (1) and (2) are both present, every outbound call becomes an action to approve, showing exactly what would leave (query, URL, arguments). Exposure is computed from the **provenance** of the transcript's content, never from its text: a paraphrased injection does not bypass it. It is computed at the start of each step from turns already written and carried with each tool call, so a response resumed after a pause replays the same decision (durable-execution test). Rendered answers cannot load remote images (CSP `img-src 'self' data: blob:`), which closes the Markdown-image channel. Bench: no extra approval on 50 normal trials; a model scripted to obey the trap is stopped before the secret leaves. |
| Untrusted-content marking (spotlighting) | Web pages, web results and MCP/API results are *datamarked*: every space becomes `ˆ`, and the platform prompt states that marked text was written by a stranger and is never an instruction. Unlike tags, the marking is present throughout the text, so an instruction hidden mid-page stays visibly « from the page ». Internal knowledge passages are not marked (citation quality). A grader check on every bench case ensures the marker never leaks into answers. The detector reads marked text as normal text. |
| Links in answers | Images are never rendered (Markdown images become links). A link is clickable only if its domain already appeared in the conversation (typed by the user or cited as a source) or is Snowfall itself; any other domain is shown with its name, flagged « unverified », and opens only on a second click (no `href` in the page). Subdomains do not inherit trust. Closes the « click here » exfiltration channel. |
| External tools: per-user OAuth (MCP) | A connector can use either one organization token or **each user's own account** (OAuth 2.1, per the MCP authorization spec): protected-resource metadata (RFC 9728) then authorization-server metadata (RFC 8414) discovered from the MCP server itself, issuer checked against the one queried, S256 PKCE required, resource indicator (RFC 8707) binding the token to that server, every discovered endpoint checked (HTTPS, public address, egress proxy). State: 32 random bytes, stored hashed, bound to the user who started, single use, 10 minutes; verifier encrypted. The provider returns to an application page (`/mcp/callback`) which posts code and state same-site (session cookie and origin check unchanged, code removed from the URL). User tokens: encrypted (AAD per organization, user and server), FORCE RLS on owner (administrators included), composite FKs so a token can never point to another organization's server, refreshed on expiry with the resource indicator, deleted if refresh fails, never returned to the UI or audit. Each call is made with the caller's token: actions are attributed to them on the remote service. Administrators review and approve tools with their own connected account. |
| External tools: OpenAPI connectors | An internal API described by an OpenAPI 3 specification (JSON, ≤ 1 MB, provided and frozen by an administrator: nothing is downloaded at run time) becomes a connector in the same chain as MCP: review and fingerprinted approval per operation, per-agent selection, approval of writes, rule of two, marking, audit. Only internal `#/` references are resolved (external references refused); operations needing a header or cookie parameter, or a non-JSON body, are not offered. Path parameters are percent-encoded and the final URL must keep the declared origin; no redirects, 20 s, 50 000 characters. Organization token only (Bearer). Specification encrypted at rest. |
| Agent teams (delegation) | An agent may delegate a real task to up to 5 agents of the organization (`delegate` tool, enabled by the organization), which may delegate in turn: depth 2 at most. Each sub-agent runs with its own model, instructions and knowledge base, but with the **intersection** of its tools and its caller's (never more rights than the agent that delegates, nor than the user). Its writes and outbound calls are approved by the user, with the line « for <agent> » (approvals bubble up through every level; nothing is approved on its behalf). One token budget for the whole team (the response's), 15 minutes per delegation; quota checked before, tokens counted after. Each sub-agent is a durable run in a sub-thread (`runId~key`) with its own encrypted checkpoints, deleted with the parent run, so a resumed response never repeats an approved write. The caller's exposure (rule of two) is inherited by the sub-agent; a delegation counts as untrusted and internal. Nothing confidential crosses to an external model: refused if the conversation is confidential and the delegate's model is external, or if the delegate's base is confidential and the caller's model is external (audited). The answer comes back in `<agent_result>` tags declared as data. Audit records caller, delegate and steps, never content. |
| Model routing (local decision service) | Optional, per organization: a conversation **without an agent or chosen model** goes to a « fast » model for a simple question and a « strong » one otherwise. Both models must be published and from allowed providers (checked on save and again at each use; otherwise the default model). The decision combines a heuristic (attachments, code, length, analysis vocabulary) and a local decision model (Laya multilingual, Apache 2.0, revision and SHA-256 fixed at build): « complex » if either says so; service absent, slow (3 s) or failing → heuristic. The service has no network, a read-only file system, a dedicated user, and a Unix socket open to the API's group only (10012); it sees the question (≤ 4,000 characters) and never logs it. The decision model alone, measured once on a held-out set: 22/24 (every simple question routed right, 2 complex ones judged simple); CI replays that set in the image and fails below 21/24. The combined figure is not reported: the heuristic was written knowing that set. The API logs only the decision (label, source). |
| Agent quality (continuous improvement) | A 👎 can be shared with the agent's author only by explicit opt-in (unchecked box): the question and the comment, never the answer nor the user's name; refused for temporary conversations or with a confidential base active. Withdrawing the 👎 deletes the case; deleting the account or the agent deletes it too (cascade). Cases and instruction versions are encrypted per organization, under FORCE RLS, tied to the agent of their own organization (composite FK); versions are immutable for the application role (only their score can change). « Improve » (author or administrator, ≥ 2 accepted cases, ≤ 30 cases, one run at a time, 10 min): the current instructions are measured (answers in read-only mode: the agent's base only, no write or outbound tool), a model proposes new instructions from the cases it may see, and the proposal is measured on all cases. It is offered only if it passes more seen cases and loses none (seen or held out: one case in three from 4 cases is never shown to the optimizer); a noisy measurement therefore leans towards rejection. Nothing is applied without the author's click, on the very proposal the server measured, and only if the instructions did not change meanwhile. Cases are user data: tagged as data for the judge and optimizer, which are told never to copy an instruction, address or link from them, and the author reviews the full text before applying. Judge: the organization's « strong » routing model if permitted, otherwise the agent's own model (shown with the result); a confidential base keeps everything on a local model. Every call checks quotas first and is metered. Audit: counts and outcome, never content. |
| Training workshop (administrators) | Administrators write labelled examples by hand (never taken from conversations; no personal data, as the screen states); each example is assigned once and for all to the training or the test part (≈ 30 %) when added, and that part cannot be rewritten by the application role. Training runs locally in the decision service (no network): a logistic head on the frozen Laya embeddings, settings chosen by cross-validation on the training part only, then one measurement of the head AND of the decider in place (trained head, or base Laya) on the test part. A model is deployable only if it makes more right decisions than the reference and recognises at least as many complex questions; this is checked on save, again on activation, and by a database constraint (an active model is always deployable). One active model per organization and task (unique index); returning to the base decider is one click. Heads are bound to the model revision they were trained on (the service refuses any other), encrypted per organization, immutable except their status. Audit: counts and outcome, never text. |
| Scheduled agents and triggers | A user schedules an instruction to an agent (daily or weekly at a local hour, with daylight saving handled, or whenever a document becomes ready in the agent's base). It runs as its author, in the author's own conversation, through the same message route (quotas, routing, rule of two, injection guard, audit): nothing is duplicated. No one approves on the author's behalf: a write or gated outbound call waits for the author's approval in the conversation, then expires as refused. The scheduler claims due tasks through a SECURITY DEFINER function over a content-free queue kept by trigger (the application role has no right on it), with a lease so that a single instance runs each task; editing a task during its run does not release the lease; a task whose author left the organization never runs, a reader's task is skipped. The internal request carries a random 256-bit single-use token valid 30 s, created in memory for that request only; nginx strips the header from the network. Limits: 5 tasks per person, at most daily, triggers checked every 5 minutes, disabled after 3 consecutive failures. Document names added to the instruction are bounded, single-line data. Name and instruction encrypted; tasks are private to their author (RLS). |
| Sensitive data before any external call | Local, deterministic detection (no model, no network) of French social security numbers (NIR, key checked), IBANs (official length per country, mod 97), card numbers (network prefix, Luhn) and health information about a person (precise medical term AND a person in the same sentence), in the message and its attached documents, BEFORE routing and quotas. If found (organization setting, on by default), the conversation is marked sensitive (one-way flag enforced by a database trigger) and is answered by a local model from then on; it is treated as confidential: no content in traces, no web search, no external specialist, no memory, not shareable, not proposed as an evaluation case. Without a local model the message is refused before anything is sent or stored, with the category only. Audit records categories and action, never values; conversation titles never keep a valid identifier (masked). The memory never stores sensitive data. Measured once on a held-out set written after the rules were frozen: 8/8 detected, 1/8 false alarm (a lot number that is a genuinely valid card number). Turning the protection off is a separately audited administrator decision. |
| Reversible pseudonymization (optional, per organization, off by default) | When enabled and the model is external, every model call (answers, sub-agents, summaries, query rewriting, quality runs) goes through a wrapper: emails, phone numbers, postal addresses, valid identifiers and person names (civility + name, known first name + surname, then those surnames alone) are replaced by stable tokens ([PERSONNE_1], [EMAIL_1]…) in instructions, history, tool results, memory and summary; the provider is told to reuse tokens as they are. Real values are restored in the streamed answer (a token split across chunks is awaited), in the model's reasoning and in tool arguments before local execution; signed provider data is never altered. The mapping lives for one call, in memory: never stored or sent; it is rebuilt identically on the next call since the transcript only grows. Token-like strings already present in a text are neutralized so they cannot be restored as someone else. Measured once on a held-out set written after the rules: 14/15 personal values masked (missed: a surname alone with no civility or first name), 0/16 ordinary words damaged. Linear time (a 260 KB adversarial text in 37 ms). Turning it on or off is audited. |
| Local voice | Dictation and read-aloud through self-hosted services with an OpenAI-compatible audio API (e.g. Speaches). Audio is never stored; its declared type must match its signature (WebM, Ogg, MP4, MP3, WAV), 25 MB, rate-limited; the synthesized audio must be MP3. Read-aloud strips Markdown and code. The microphone is allowed for the application only (`Permissions-Policy: microphone=(self)`), still blocked in artifacts; audio playback via `media-src 'self' blob:`. Off unless `STT_URL`/`TTS_URL` are configured. Audit: size and format only. |
| Local image generation | `generate_image` tool backed by a self-hosted model (OpenAI-compatible images API): the description never leaves the platform (allowed in confidential conversations). Output must be a PNG ≤ 10 MB, goes through antivirus, is stored encrypted as a generated file, 4 per answer and a monthly `image` quota. Off unless `IMAGE_URL` is configured. |
| Prompt-injection detection | A **heuristic** layer (`security/injection.ts`): named, weighted signals (override, text addressed to the assistant, fake platform tags, tool push, exfiltration, secrecy, fake consent, credential requests, standing orders), French and English, accent- and case-insensitive, bounded time, negation-aware. On a suspicious tool result, passage or attachment: a platform notice is prepended (content kept: a false alarm must not break an answer), `agent.injection_suspected` is audited (tool, signals, score; no content), and any write requested afterwards shows a warning on its approval card. Memory refuses links, e-mail addresses, secrets and suspicious facts at save time (before asking for approval) and drops them at injection time. **Measured honestly**: 100 % on the bench traps and on a first held-out set, but both served for tuning; on a second held-out set of paraphrased attacks, **0/12 detected** (0/12 false positives). It catches copy-pasted injections only; an adaptive attacker bypasses it. The structural controls remain the defence. |
| Conversation branches | Editing a message or regenerating an answer adds a sibling version instead of deleting history. Integrity: a parent must belong to the same conversation (composite foreign key), branch selection is owner-scoped (RLS) and refused during a running response; only the displayed branch is decrypted and sent to the model. Legacy conversations were chained in order by a migration that lifts FORCE RLS only inside its own transaction. |
| Answer feedback | 👍/👎 per answer, by the conversation owner only (FORCE RLS, composite FKs to the message and the conversation, assistant messages only). Optional comment encrypted with the organization DEK (CHECK refuses plaintext). Audit records the rating and whether a comment exists, never its text. The trace receives the rating only (Langfuse score with a stable id, upsert/delete), via a trace id derived from the run (`sha256(run id)`), never the comment. |
| Internal sharing | Read-only link to a frozen snapshot of the displayed branch, readable by members of the same organization only (RLS), for 1, 7 or 30 days. The token (32 random bytes) is looked up by its SHA-256 hash; the token itself, the title and the snapshot are encrypted with the organization DEK. The token travels in the URL fragment and the request body (`POST /shares/open`), never in a path or query string (no proxy or log leak); opening is rate-limited (30/min) and audited (`share.view`). Sources are reduced to number and name. Refused (409, audited) for conversations using a confidential base and for temporary conversations. The author lists and revokes links. |
| Export and import | Export of one conversation (Markdown or JSON, displayed branch, built in the browser) and of all personal data (`GET /me/export`: conversations, prompts, memory, preferences — GDPR access right). Import of ChatGPT, LibreChat or Snowfall files: format detected from the structure, 25 MB, rate-limited (5/min), bounded conversations/messages/lengths, a single branch kept, content encrypted like any message; a partial failure deletes the half-imported conversation. Audit records counts and format, never content. |
| Model parameters | Per-agent response settings (creativity, length) mapped server-side to bounded values (temperature 0.1/0.5/0.9; length capped by the platform output limit). Not sent to reasoning models that reject them. No free-form parameter reaches the provider. |
| Per-conversation settings and presets | A conversation may override the agent's creativity and length (same bounded enums, CHECK constraints) and add its own instructions (≤ 1,500 characters, encrypted with an AAD bound to the conversation, refused when they contain sensitive data or look like an injection — same checks as custom instructions). They travel in the `<user_preferences>` block, after the user's own instructions, under the rule that they never override platform rules; pseudonymization masks them. Presets are private (FORCE RLS on owner, membership FK), name and instructions encrypted, 50 per user (advisory lock against concurrent creation), checked like instructions at save time. Audit records which settings changed, never their content. |
| Continue an answer | Adapters report a length cut-off (`max_tokens`, `length`, `MAX_TOKENS`, `model_length`); cut or stopped answers are flagged `incomplete`. « Continuer » only applies to the last answer of the displayed branch when it is incomplete; same admission, quota and sensitive-data checks as a regeneration; no new retrieval. The continuation is appended to the same message, re-encrypted under its own AAD. The application role gets `UPDATE (content, incomplete)` on `messages` only (column grant), still owner-scoped by RLS. |
| Fork | A new conversation copies the displayed branch up to the chosen message (content, sources, authors, settings), re-encrypted under the new conversation's identifiers; tags, archive state and attachments stay with the original. A sensitive conversation stays sensitive in its copy (local model for life); temporary conversations cannot be forked. Rate-limited (20/min), audited (`conversation.fork`, source id only); someone else's conversation answers 404 and is logged as a cross-tenant attempt. |
| Archive and tags | Archived conversations leave the history (still searchable and exported). Tags: ≤ 10, ≤ 30 characters, no control or format characters (no bidi spoofing), case-insensitive de-duplication, stored as one encrypted JSON value (a label can be telling). Temporary conversations can be neither archived nor tagged (CHECK constraint). |
| File library | « Mes fichiers » lists the user's sent attachments (not drafts, never temporary conversations). Reuse is a copy: decrypted under the source's AAD, re-encrypted under the copy's, pending in the target conversation (same 10-pending limit, upload rate limit); no row is shared between conversations. A file from a sensitive conversation makes the target sensitive. Text of the copy goes through the send-time sensitive-data check like any attachment. Deletion removes the file even once sent (the message keeps its text). Audit without file names. |
| Exports | Text, PDF and PNG exports are built in the browser (nothing more goes to the server). PDF uses the browser's print dialog with a dedicated print stylesheet; PNG is drawn on a canvas (text only, ≤ 16,000 px, cut with a notice) — no capture library, no injected styles or `data:` images, so the strict CSP stays untouched. |
| Model comparison | « Comparer avec… » regenerates the last answer with another allowed model as a new version (same agent and instructions, signed by the compared model). Refused (409 `local_only`, audited `conversation.compare_denied`) when the conversation is sensitive or uses a confidential base and the model is external — never silently rerouted. |
| Agent skills | Reusable know-how (description, instructions ≤ 20,000 characters, ≤ 10 reference files kept as extracted text) loaded on demand: the model first sees only names and descriptions (in the `use_skill` tool description, one line each, no line breaks from user text); `use_skill` returns the instructions and `read_skill_file` a file (≤ 20,000 characters), both read-only and limited to skills attached to the agent (unknown ids refused by the tool schema). Results count as internal data for the rule of two and go through the injection guard like any tool result. Saving refuses injection-like text; sensitive data (text or file) only in a **confidential** skill, which is never offered to an external model and forces its agent onto a local model (409 `agent_requires_local`, also when only the model changes). Reading (RLS): the author, a grant (person, group, organization), or anyone who can see an agent the skill is attached to; the skill library only lists one's own and shared skills. Attaching (RLS) requires seeing the agent and owning or being granted the skill; an agent editor who cannot see an attached skill keeps it (diff update) but cannot re-add it. Editors modify, only the author deletes, shares or lifts confidentiality. Every change of description or instructions is a new version (append-only history, author of the change kept). Name, description, instructions, files and versions are encrypted (CHECK refuses plaintext), included in key rotation and in the personal-data export. Files go through the antivirus. Audit without content. |
| Connector catalog | 50+ known remote MCP servers (Google Workspace, Microsoft 365, Atlassian, Notion, GitHub, Slack, Figma, HubSpot, Stripe…) listed with their constraints (vendor preview, OAuth app required, vendor allowlist, Microsoft tenant, licence) and the provenance of each address (vendor documentation or public directory, to be confirmed by the review). Only Streamable HTTP endpoints are listed (no deprecated SSE). An administrator adds one in a click: the address comes from the catalog, never from the request (only a GUID-validated Microsoft tenant is inserted); it then goes through the same path as a manual server (SSRF checks, OAuth discovery, pending until each tool is reviewed and approved read/write). Members only see approved connectors and connect with their own account. OAuth: Dynamic Client Registration (RFC 7591) when the vendor offers it — public client, PKCE S256, a single redirect URI (ours), registration endpoint checked like any third-party address; otherwise the administrator provides a client created at the vendor. Audit: host, auth mode and catalog id, never tokens. Logos: Simple Icons (CC0) drawn as React SVG (CSP unchanged), loaded with the panel only; brands that asked Simple Icons to remove their logo get an initial-letter tile instead. |
| Skill import (zip) | Anthropic-format folder (`SKILL.md` with `name`/`description` front matter + reference files), ≤ 20 MB, ZIP signature checked, antivirus on the archive, then streamed decompression with caps on bytes actually produced (10 MB per file, 30 MB total, 100 entries) — declared sizes are ignored (zip bombs). Nothing is written to disk; paths are cleaned (no `..`, control characters), macOS metadata and hidden files dropped. Same checks as a manual skill (injection, sensitive data only if confidential); scripts and unsupported files are set aside and reported; a failure midway deletes the half-imported skill. Audit: counts only. |
| Fine-grained sharing | Agents and prompts can be shared with a person, a group or the whole organization, read or edit. Grants live in `resource_grants`; reading is enforced by RLS on `agents` and `prompts` through `snowfall_access()` and `snowfall_is_admin()` (SECURITY INVOKER: RLS applies inside them), not only by the API. Only the owner (or an administrator, for agents) changes grants — the INSERT/DELETE policies check it; editors modify content but neither delete nor share; prompt updates are limited to `name, content, updated_at` by column grant. New agents are private; existing agents and shared prompts were migrated to an organization-wide read grant (no visibility lost). Groups are managed by administrators (RLS), names encrypted. Grants of a deleted resource or group, or of a removed member, are deleted in the same transaction (a re-invited member gets nothing back). System tasks without a user (key rotation) still see every agent of the organization. Audit records the shape of a share (counts), never names or recipients. |
| Prompt library | Private prompts, or shared through fine-grained grants (see « Fine-grained sharing »). Name and content encrypted; ≤ 10 `{{variables}}`, filled in the browser and inserted into the input box: nothing is sent before the user submits. Automatic variables (`{{date}}`, `{{heure}}`, `{{jour}}`, `{{utilisateur}}`, `{{current_*}}`) are filled client-side at insertion, never re-interpreted. Audit without name or content. |
| Temporary conversations | Flag fixed at creation (immutable trigger), excluded from history, search, projects (CHECK constraint) and sharing; no content in traces (handled like a confidential base); memory neither read nor written. Deleted 24 h after creation by a purge: a queue of identifiers only, filled by trigger, no grant for the application role, read through a SECURITY DEFINER function; each deletion runs under the author's RLS and is audited (`conversation.purge`). Not included in the personal-data export. |
| User memory | Off by default; enabled by each user in « Mon compte ». Facts (≤ 50 × 500 characters) are private to their owner — administrators included — (FORCE RLS on owner), encrypted (AAD binds organization, user and fact; CHECK refuses plaintext), listed and deletable one by one or all at once. Added only through the `save_memory` write tool, which requires the user's approval of the exact text, or by the user. Injected into the system prompt inside `<user_memory>` tags declared untrusted, closing tags stripped, one line per fact. Never read nor offered in temporary or confidential conversations. Audit records size and origin (user/agent), never content. |
| Local OCR | Scanned PDFs (no usable text layer) and images in knowledge bases are read by Tesseract and Poppler in a dedicated container, never by a third party. The container has no network (`network_mode: none`), is reached by a Unix socket restricted to the API's group, runs read-only with 4 capabilities, gVisor by default; each read uses a dedicated UID, a fresh tmpfs directory, rlimits (CPU, 1 GB, processes, file size), an empty environment, at most 30 pages rendered at a bounded size and 180 s in total. Media type checked against the file signature; antivirus runs before. If OCR fails, a PDF keeps its original text and an image is marked `ocr_failed`. Image and packages pinned, scanned by Trivy, functional and isolation checks run in CI. |
| Agent rating | Catalog cards show the share of 👍 answers for an agent, as an organization aggregate only, and only once **5 distinct people** have rated it (one user cannot fabricate a rate; a small count would point at individuals). Feedback rows stay readable by their author only: a counting table (message, agent, author, rating — no comment) is maintained by trigger, has no grant, and is read through a SECURITY DEFINER function limited to the caller's organization. Removed with the feedback, the conversation or the agent. |
| UI verification | Browser tests (Playwright, desktop and mobile) on key journeys: settings by role, sending from the welcome screen, streamed answer, artifact auto-open in preview mode inside the sandboxed frame, download, branches, feedback, sharing, export/import, prompt library with « / », temporary conversation, memory settings, agent catalog, switching model mid-conversation, code highlighting and math under the production CSP, light/system theme, custom instructions, conversation settings and presets, continue, fork, archive and tags, file library, text/PDF/image export, model comparison, fine-grained sharing and groups. The light theme is generated from the stylesheets; `npm test` fails if it is stale. |

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
  are not indexed yet; images and scanned PDFs need the OCR profile (`ocr`).
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
  content, approvals, URL allow-list for page reads, MCP fingerprints). The
  detection layer is heuristic and does **not** generalize to paraphrased attacks
  (0/12 on the second held-out set); the exfiltration policy (rule of two) does
  not depend on it. Residual paths: knowledge-base content counts as internal
  data, not as untrusted, so a poisoned internal document can still steer the
  *first* outbound call of a response; text typed by the user and memory facts
  are not counted as internal data; links in answers are clickable (the user must
  click). A learned classifier was measured (local Laya model, threshold chosen
  on the bench and v1, measured once on v2): 11/12 attacks caught but 6/12
  legitimate texts flagged. Not deployed: that false-positive rate would push
  users to ignore warnings. To retry with a model trained on our own cases.
- MCP servers in token mode share one token for the whole organization: actions
  on the remote service are not attributed to the individual user there. Prefer
  OAuth mode (each user's own account) for servers that write.
- gVisor detection relies on its fixed simulated kernel version; it must be
  verified on the production host (`SANDBOX_RUNTIME=runsc scripts/sandbox-attack.sh`
  must report `Isolation : gvisor`). If the check fails, the sandbox refuses to
  start (fail-closed). CI runs the attack battery with `runc`.
- Tool quotas are soft under concurrency (checked, then counted).
- Voice and image services are wired and tested against fakes; their containers
  are not yet in `compose.prod.yaml` (images to pin by digest, model licences to
  choose, GPU to size). OCR, voice and images run without a learned injection
  classifier: their output is treated like any other content.
- OpenAPI connectors support an organization token only (no per-user OAuth yet).
- Agent teams: a sub-agent's answer is untrusted data for its caller; a
  compromised delegate can still mislead the caller's answer (not its rights).
  The team budget is shared, so one greedy delegate can starve its siblings.
- Pseudonymization is not anonymization: a name the rules miss (surname alone,
  rare first name, name in another script) leaves in clear, and images are not
  pseudonymized. The quality impact on real models is not yet measured (`npm
  run agent:eval -- --pseudonymize` compares with and without). Data that must
  not leave the platform belongs on a local model (sensitive-data routing).
- Sensitive data detection prevents accidental disclosure, not a determined
  insider: spelled-out or obfuscated numbers, images (including photos of
  documents sent to vision models) and the other GDPR art. 9 categories
  (opinions, religion, orientation…) are not detected. Knowledge-base passages
  retrieved during a run are not rescanned: mark bases holding personal data as
  confidential. Messages sent before the feature existed are not rescanned. The
  held-out set (16 cases) is small and written by the same author as the rules.
- Training workshop: the test part is reused by every training; an administrator
  who retrains many times on the same examples ends up selecting for that test
  set (add fresh examples regularly). An administrator writes both parts, so a
  decider can be deliberately skewed by its own administrators (they are trusted
  for the organization's settings). The routing gain measured on our bench is 2
  cases out of 24: real but small.
- Scheduled agents: pending approvals of an unattended run expire as refused
  after the usual delay; schedules created before a member leaves remain in
  the database (encrypted, never executed) until the account is deleted.
- Agent quality: the judge is a language model; an agent answer crafted to sway
  it could inflate a score (the answer is tagged as data; residual). When no
  routing « strong » model is set, the agent's model judges itself (self-bias,
  displayed). Pending proposals live in the memory of one API instance (lost on
  restart: run again). With fewer than 4 cases there is no held-out check.
- Key rotation: an old key version is retired by hand once
  `npm run keys:rotate -- --verify` reports zero (no automatic deletion of key versions). Sessions use
  the master key, not the organization key: they expire within hours.
- Model routing: the heuristic routing keywords were written knowing the test
  set (24/24 on it, a biased figure); the decision model's 22/24 is the honest
  measurement. A question misjudged « simple » gets the fast model's answer.
- Agent ratings are aggregates: someone who watches the rate before and after a
  colleague's vote can infer that vote (inherent to any live aggregate; the
  5-person threshold limits it, it does not remove it).
- Memory facts are sent to the answering model's provider like the rest of the
  prompt (the user opted in); they are not filtered for sensitive data beyond
  the tool's instruction to refuse secrets.
- OCR runs synchronously during an attachment upload (up to ~3 minutes for a
  long scan); two reads at a time, further requests fall back to the text layer.
- Debian packages of the OCR image are pinned to exact versions: a Debian
  security update requires bumping them (Trivy flags it in CI).
- Browser tests mostly use a mocked API; one real-stack journey runs in CI
  (`npm run e2e:real`): a throwaway Keycloak, API and Postgres (separate compose
  project, generated secrets, its own environment file), login with mandatory
  TOTP enrolment, a message and its answer, then database checks (ciphertext at
  rest, application role sees nothing without tenant context, audit without
  content), sensitive-data marking, and a logout revoked server-side. It covers
  one journey, not every feature against the real stack.
- No external penetration test yet; the DPIA (`AIPD.md`) is a draft to be
  completed and signed by the data controller.

### Known gaps added by connectors and skill import (2026-10-25)

- Catalog addresses from public directories are not vendor-confirmed; the
  review (tool discovery) is what proves an address works.
- Several vendors only accept clients they approved (e.g. Figma) or require a
  pre-registered OAuth app (Google, Microsoft, GitHub, Slack, HubSpot): a
  self-hosted Snowfall must be registered with them.
- Connectors send data to the vendor's service (often outside the EU): the
  organization decides per connector; confidential conversations never call them.
- No YouTube or Gmail-sending connector: Google publishes none.
- One dependency advisory remains open until its fix is 14 days old
  (fast-uri 3.1.9 / 4.2.3 on 2026-11-02; moderate, URI parsing inside
  fastify's schema compiler). fastify 5.12.6 and mermaid 12.2.0 were applied on
  2026-10-27; every changed package in the lockfile was checked against the
  14-day rule.
- Adversarial review (2026-10-25), two findings fixed and tested:
  connector results now count as private data for the rule of two (a planted
  ticket could previously trigger an outbound call without consent), and a tool
  the vendor marks read-only but whose name says otherwise is never treated as a
  read. Remaining: the name check is a heuristic, and imported skills are trusted
  like internal documents.
- Skill scripts (Python) run only in the code sandbox, only for agents allowed to
  run code, under the same per-answer and monthly quotas as model-written code
  (a quota bypass found in review was fixed). A script is third-party code: it
  cannot reach the network, but it can still produce misleading output or files
  (antivirus-scanned, served with a sandboxing CSP). Other languages are not run.
- Skill templates (DOCX, XLSX, PDF, PNG, JPEG, up to 2 MiB) keep their original
  bytes, encrypted, for scripts only. Workbook cells are checked for sensitive
  data; images and scanned PDFs are not read, so they are not checked.
- A script receives the user's files only by name, from the current
  conversation (never the file library), under `inputs/`.
- Review finding: two encryption-at-rest assertions in the skills integration
  test passed vacuously (a raw read without tenant context returns no row under
  FORCE RLS), and that test file was in no test list. Both fixed: the read runs
  in the organization context and asserts one row; the file now runs with the suite.

### Public API (2026-10-27)

- API keys are stored as SHA-256 hashes only, shown once, scoped to listed
  agents, valid at most 365 days, revocable, and act on behalf of their creator
  only while that creator is still an administrator. `/v1` routes accept keys
  only; UI routes accept sessions only. Writes are never approved through the API.
- Known gaps: no IP allowlist per key; no finer scopes than "agents"; a key name
  is a plaintext label; no CORS by design (server-to-server only); keys are not
  rotated automatically (create a new one, then revoke the old one).

### SCIM provisioning (2026-10-27)

- The company directory pushes accounts (SCIM 2.0, Users). Once a SCIM key
  exists, the organization is directory-managed: only an active SCIM account can
  join, SSO included, so a deactivated person cannot come back by signing in.
  Deactivation removes membership, grants and pending invitations; membership is
  re-read on every request, so open sessions stop working at once.
- Known gaps: no SCIM Groups (roles stay manual); roles are not driven by the
  directory; a failed deprovisioning (owner, key creator) is reported to the
  directory and audited, but still needs a human.

### Agent catalog (2026-10-27)

- Ready-made agents (HR, contracts, GDPR, purchasing, support, project, writing,
  sales, general assistant with a team) install through the ordinary routes:
  same permissions, sensitive-data checks, quotas and audit as a manual
  creation. Every template ships its own evaluation set, including at least one
  prompt-injection case, and the quality shown in the catalog is measured.
- Fixed while building it: `runTool` overwrote tool-reported errors as successes.
- `run_code` can read attachments of the current conversation (copied under
  `inputs/`, never executed), so figures are computed on the file instead of
  being retyped by the model. Same sandbox, same limits.
- A Gemini 429 body is read for one thing only: the quota identifier
  (`[A-Za-z0-9-]{1,100}`, e.g. per-minute vs per-day), kept on the error and
  shown in evaluation reports, never to users. The rest of the body, which can
  echo the request, is discarded (test in `google.test.ts`).
- Known gaps: quality is measured on one model (the cheapest available); a
  template's legal content reflects French law at the measurement date and must
  be reviewed by the organization; no automatic update of an installed agent
  when its template changes.

### Administration and overview (2026-10-28)

- Organization administration moved out of Settings into its own space
  (sidebar › Administration, admins only): Overview, Members and access, Models
  and quotas, Knowledge, Tools and integrations. Settings only holds the user's
  own account.
- Overview = organization totals only: active people (7 days, 30 days, period),
  messages per day, most used agents with their helpful rate, tokens per month
  against the quota, tool calls this month. No per-person figure, no ranking;
  an agent appears only once 5 distinct people use it.
- Messages stay readable by their author only. Activity is counted by a
  trigger into `member_activity` (organization, day, person, agent, count; no
  content), which the application role cannot read or write. Only
  `snowfall_admin_overview(days)` returns totals, after checking in the
  database that the caller is owner/admin of the context organization. The API
  route checks the role too and audits refusals (`admin.overview`).
- Retention: 400 days. Copies (fork) and imports are not counted.
- Known gaps: scheduled tasks and public-API calls count as their author's
  activity; no cost in euros yet (tokens only, no price table); no audit-log
  viewer in Administration yet (the log is insert-only for the application).

### Conversation titles and empty conversations (2026-10-28)

- A conversation enters the history at its first message. An empty one is
  hidden, then deleted after 24 hours when its author lists the history
  (under the author's RLS; a scheduled task's conversation is kept).
- The title is a short rephrasing of the first request, produced during the
  answer by the same model and rules (sensitive data stays local,
  pseudonymization unchanged, temporary conversations excluded, nothing
  traced). The request is tagged as data, the output cleaned to one plain line
  of 60 characters and redacted. It only replaces the provisional title, never
  a title the user chose meanwhile. Its tokens count toward the quota.

### Organization identity (2026-10-29)

- Administration › Identity: an admin uploads the organization's logo, which
  replaces the Snowfall logo everywhere (background, sidebar, avatars, browser
  tab); without one, the Snowfall logo. The organization may also choose the
  interface color: every blue or lavender of the stylesheets (accents, but
  also the navy backgrounds, panels and slate texts, so the whole look follows)
  is re-expressed from two variables (hue shift, saturation factor) in a
  generated stylesheet (`theme-accent.css`, checked by `npm test`), lightness
  kept so text contrast is unchanged; status colors (green, orange, red) and
  agent colors stay. The default logo follows the same color. The
  organization's name is shown next to Snowfall.
- Upload: PNG or JPEG recognized by content, 512 KB and 16–1024 px at most,
  antivirus, admin-only (route and RLS), audited (`branding.*`). Served with
  its exact type, `nosniff` and a sandbox CSP. Never SVG.
- The Keycloak login page keeps the Snowfall logo: it is shown before the
  organization is known.

### Administration › Security (2026-10-30)

- Audit log viewer for admins: their organization only, newest first, 50 per
  page, filters by family and "denials and failures only", event detail, CSV
  export (5,000 rows max, formula cells neutralized, export audited). The
  application role still has INSERT only on `audit_events`; reads go through
  `snowfall_audit_log()`, which checks the admin role in the database.
- Conversation retention: 30 days to 3 years, or unlimited (default). A
  background job deletes conversations inactive for that long, for every
  member, under each author's RLS, and audits each deletion
  (`conversation.purge`, reason `retention`). It reads only a content-free
  queue (`conversation_activity`) maintained by trigger.
- GDPR data subject rights stay self-service (Settings › My account): admins
  cannot read members' conversations by design.
- Known gaps: an inactive scheduled task's conversation is purged with its
  task; the audit log itself has no retention setting (kept, append-only).

### Known gaps added by the LibreChat parity phase (2026-10-25)

- A fork does not copy attachments: the copy's model no longer sees their content.
- An agent shared then revoked disappears for the people who used it: their
  conversations fall back to the default model without warning.
- The sharing directory shows every member's e-mail to every member (needed to
  pick a recipient); acceptable inside one organization, to be stated in the AIPD.
- Editors of an agent cannot manage its knowledge base (owner or administrator
  only) — deliberate, the documents may be confidential.
- The PNG export is a text rendering, not a pixel capture (tables and formulas
  become plain text).

## 13. Change control

Any security-sensitive change must document its purpose, risks, tests, rollback plan,
and evidence. Database migrations require explicit review and approval.
