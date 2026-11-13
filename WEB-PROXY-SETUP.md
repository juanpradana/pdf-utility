# Shared reverse proxy (web-proxy) — deployment notes

`pdf-utility` no longer binds ports 80 or 443. Those ports belong to a separate,
shared reverse proxy project that routes every subdomain on this host.

## Why it is separate

Ports 80 and 443 are reserved for the main web / main reverse proxy. Keeping the
proxy in its own project means:

- `pdf-utility`'s `docker compose` commands can never take down the other sites.
- Any single app (pdf, btc, cctv, the future main site) can be rebuilt or
  restarted without touching the proxy or the other apps.
- The proxy has exactly one job: terminate TLS, then route by `Host`.

## Where it lives on the server

```
/home/ubuntu/web-proxy/
├── docker-compose.yml     # one service, binds 80 and 443
├── renew.sh               # monthly Let's Encrypt renewal (+ nginx reload)
├── nginx/
│   ├── conf.d/
│   │   ├── 00-default.conf                  # :80 -> 301 HTTPS; default :443 -> 503 maintenance
│   │   ├── pdf.farzani.my.id.conf           # -> host.docker.internal:3001
│   │   ├── btc.farzani.my.id.conf           # -> host.docker.internal:3857
│   │   └── bdlcctv.farzani.my.id.conf       # -> host.docker.internal:3447
│   ├── maintenance/maintenance.html          # 503 page for unmatched hosts (apex)
│   ├── certbot-www/                          # ACME HTTP-01 webroot
│   ├── letsencrypt/                          # certbot state (root-owned, 0700)
│   └── ssl/                                  # server.crt / server.key + per-host certs
```

## How each upstream is reached

The proxy does **not** join other projects' Docker networks. It resolves
`host.docker.internal` to the host's bridge gateway (`host-gateway`) and calls
each service on its **published host port**:

| Host                        | Upstream                                | Service                |
|-----------------------------|-----------------------------------------|------------------------|
| `pdf.farzani.my.id`         | `host.docker.internal:3001`             | `pdf-utility-app`      |
| `btc.farzani.my.id`         | `host.docker.internal:3857`             | `btc-3d-anima`         |
| `bdlcctv.farzani.my.id`     | `host.docker.internal:3447`             | `cctv-bandarlampung`   |
| everything else (incl. apex)| 503 maintenance page                    | —                      |

So each app stays an independent compose project with its own lifecycle, and the
proxy stays a single container that only changes when a route is added.

## Operating it

```bash
cd /home/ubuntu/web-proxy

docker compose up -d            # (re)create the proxy
docker compose exec proxy nginx -t
docker compose exec proxy nginx -s reload
docker compose logs -f --tail=100
```

## Adding a new subdomain

1. Create `nginx/conf.d/<host>.conf` as a copy of an existing vhost, change
   `server_name` and the `proxy_pass` target (usually `host.docker.internal:<port>`).
2. Certificates: if it uses the shared `server.crt` (i.e. the same SAN set),
   nothing else is needed. If it needs its own certificate, put it in
   `nginx/ssl/` and point `ssl_certificate`/`ssl_certificate_key` at it, like
   `bdlcctv.farzani.my.id.conf` does.
3. `docker compose exec proxy nginx -t && docker compose exec proxy nginx -s reload`

## Certificate renewal

Cron (monthly) runs `renew.sh`:

```bash
crontab -l
# Renew Let's Encrypt certificates for the shared web-proxy (main reverse proxy).
0 3 1 * * cd /home/ubuntu/web-proxy && ./renew.sh >> /home/ubuntu/web-proxy/renew.log 2>&1
```

`renew.sh` renews through the webroot challenge (answered by nginx on 80),
copies `pdf.farzani.my.id` into `server.{crt,key}` — the names the default
maintenance block uses — and reloads nginx. No host `sudo`, no host certbot.

> The old cron entry pointed at `/home/ubuntu/pdf-utility/nginx/init-letsencrypt.sh`
> and has been removed; that project no longer owns ports 80/443.

## Migrating from the old pdf-utility proxy

Done once (already applied on this host):

1. Copied `nginx/conf.d/*.conf`, the certificates, certbot state and
   `maintenance.html` into `web-proxy/`.
2. Repointed every vhost at `host.docker.internal:<published host port>`.
3. Stopped and removed `pdf-utility-proxy`; started `web-proxy`.
4. Verified every subdomain returns its expected status.