# WCN Cloud provisioner

HTTP trigger for `provision-customer.sh` / `deprovision-customer.sh`. The
console calls this; it forks the script and streams logs back over SSE.

## Install (on the host that already runs the scripts)

```bash
# 1. Drop the files
sudo install -d /opt/wcn-cloud/provisioner /etc/wcn-cloud /var/log/wcn-cloud/jobs
sudo cp server.js /opt/wcn-cloud/provisioner/
sudo cp wcn-provisioner.service /etc/systemd/system/

# 2. Generate the shared secret
TOKEN=$(openssl rand -hex 32)
sudo tee /etc/wcn-cloud/provisioner.env >/dev/null <<EOF
PROVISIONER_TOKEN=${TOKEN}
SCRIPTS_DIR=/opt/wcn-cloud/scripts
LOG_DIR=/var/log/wcn-cloud/jobs
# Inherit the env the scripts already need:
$(cat /etc/wcn-cloud/orchestrator.env)
EOF
sudo chmod 600 /etc/wcn-cloud/provisioner.env

# 3. Start it
sudo systemctl daemon-reload
sudo systemctl enable --now wcn-provisioner
sudo systemctl status wcn-provisioner
curl -sf http://127.0.0.1:9000/healthz   # → "ok"

# 4. Tell the console:
#    PROVISIONER_URL=http://<host>:9000
#    PROVISIONER_TOKEN=${TOKEN}
```

## API (all auth'd with `Authorization: Bearer $PROVISIONER_TOKEN`)

| Method | Path                  | Body              | Result                            |
| ------ | --------------------- | ----------------- | --------------------------------- |
| POST   | `/provision`          | `{slug}`          | `202 {jobId, status}`             |
| POST   | `/deprovision`        | `{slug, force?}`  | `202 {jobId, status}`             |
| GET    | `/jobs/:id`           |                   | `200 {status, exitCode, …}`       |
| GET    | `/jobs/:id/stream`    |                   | SSE; emits `event: done` on exit  |
| GET    | `/healthz`            |                   | `200 "ok"` (no auth)              |

Jobs are serial — the queue holds requests while one runs.

## Why this is safe to expose only on the LAN

- Bearer-token auth on every endpoint except `/healthz`.
- Listens on `0.0.0.0:9000` — bind to `127.0.0.1` or firewall to the
  Coolify VM's IP if you don't want it reachable from the rest of the
  rack.
- Slug is validated against `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$` before
  it ever reaches the shell. The script's own `validate_slug` is the
  second line of defence.
- `--force` is the only optional flag forwarded.

## App management API (added 2026-05-21)

All endpoints require the same Bearer token. Slug scope is enforced via the
`?slug=` query parameter or `X-Wcn-Customer-Slug` header.

| Method | Path                                          | Notes                                     |
|--------|-----------------------------------------------|-------------------------------------------|
| GET    | `/apps?slug=<slug>`                           | list apps                                 |
| POST   | `/apps?slug=<slug>`                           | create app (also creates in Coolify)      |
| GET    | `/apps/:id`                                   |                                           |
| PATCH  | `/apps/:id`                                   | partial update                            |
| DELETE | `/apps/:id`                                   | DB + Coolify                              |
| POST   | `/apps/:id/deploy`                            | triggers Coolify deployment               |
| GET    | `/apps/:id/deployments`                       | deployment history                        |
| GET    | `/apps/:id/logs?tail=N`                       | container logs                            |
| GET    | `/apps/:id/env`                               | env vars from ops_db                      |
| PUT    | `/apps/:id/env`                               | replace all env vars; syncs to Coolify    |
| GET    | `/apps/:id/domains`                           | custom domains for this app               |
| POST   | `/apps/:id/domains` `{hostname}`              | _stub — full impl in PR 3_                |
| GET    | `/apps/:id/domains/:hostname`                 | _stub_                                    |
| DELETE | `/apps/:id/domains/:hostname`                 | _stub_                                    |

Domain endpoints are intentional 501s until `add-custom-domain.sh` is
refactored into a callable library (PR 3). The list endpoint works (reads
`ops_db.domains` directly).
