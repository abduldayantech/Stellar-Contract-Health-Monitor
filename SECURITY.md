# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately through
[GitHub security advisories](https://github.com/abduldayantech/Stellar-Contract-Health-Monitor/security/advisories/new).

Include what you found, how to reproduce it and the impact you expect. You'll get an
acknowledgement within 3 working days and a plan or fix timeline within 10.

## Supported versions

Security fixes are made on `main` and released in the next version tag. Run the latest release.

## Scope

In scope:

- The API, worker and dashboard in this repository and the published Docker images
- Authentication, authorization (token roles), the audit log and secret handling
- Webhook signing and the SSRF protections for webhook delivery

Out of scope:

- Vulnerabilities in Stellar RPC providers, Stellar Core or third-party services
- Denial of service through very large numbers of contracts or events on your own deployment
- Findings that need an already-compromised admin token or database

## Hardening checklist for operators

- Set `ADMIN_API_TOKEN` and `SECRETS_ENCRYPTION_KEY` to long random values and keep them secret.
- Give people and integrations their own tokens with the least role they need.
- Serve the dashboard over HTTPS and set `SESSION_COOKIE_SECURE=true`.
- Keep `WEBHOOK_BLOCK_PRIVATE_IPS=true` unless webhooks must reach internal hosts.
- Review **Settings → Audit log** regularly.
