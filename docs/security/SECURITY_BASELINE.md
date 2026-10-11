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

## 11. Initial known gaps

- Real identity provider and verified authentication are not yet integrated.
- Real session issuance, expiry, cookie security, and revocation are not implemented.
- Tenant authorization has not yet been enforced against persisted memberships.
- Security audit logging and retention controls are not yet implemented.
- AI provider data handling and contractual controls require formal review.
- Production monitoring, incident response, backup restoration, and CI security gates
  require implementation and verification.

## 12. Change control

Any security-sensitive change must document its purpose, risks, tests, rollback plan,
and evidence. Database migrations require explicit review and approval.
