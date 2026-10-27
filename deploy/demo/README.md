# Public testnet demo

Runs the full stack (dashboard, API, worker, Postgres, Redis) on one server, with automatic HTTPS
from Caddy. It monitors busy Stellar **testnet** contracts and includes sample alert rules. Visitors
sign in with a read-only viewer token.

## Server

- Ubuntu 22.04 or 24.04, 2 vCPU, 4 GB RAM recommended (2 GB works; the script adds swap for the build)
- Ports 80 and 443 open
- For example: Hetzner CX22, DigitalOcean Basic 4 GB

## Install or update

```bash
ssh root@<server-ip>
curl -fsSL https://raw.githubusercontent.com/abduldayantech/Stellar-Contract-Health-Monitor/main/deploy/demo/setup.sh | bash
```

Without a domain, the demo is served at `https://<server-ip>.sslip.io`. To use your own domain,
point an A record at the server and run the script with `DEMO_DOMAIN=demo.example.com`.

The script prints a **read-only token** at the end. Put it in the main README next to the demo
link. Viewers can browse everything but cannot change anything. Token management and the audit
log are admin-only. The admin token stays in `/opt/stellar-health/.env`.

Re-run the same command to deploy the latest `main`. Data and secrets are kept between runs.

## What the seed adds

| Item      | Details                                                                            |
| --------- | ---------------------------------------------------------------------------------- |
| Contracts | Native XLM and USDC Stellar Asset Contracts on testnet                             |
| Rules     | XLM transfer burst, USDC inactivity, storage expiring within 7 days, WASM upgraded |
| Token     | `Public demo (read-only)`, role `VIEWER`                                           |

Event retention is 7 days to keep the database small.

## Testnet resets

Stellar resets testnet every few months. After a reset, the old contracts and history disappear.
Re-run `setup.sh` once the asset contracts exist again, or add other contracts from the dashboard
as admin. To start from scratch: `docker compose -f docker-compose.yml -f deploy/demo/docker-compose.demo.yml down -v`.
