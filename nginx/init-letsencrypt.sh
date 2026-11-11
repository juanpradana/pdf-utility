#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Obtain (or renew) a Let's Encrypt certificate and install it for the proxy.
#
# Use this when the domain's DNS points straight at this server and ports 80
# and 443 are reachable from the internet — the result is trusted by browsers,
# with no warning. It writes ./nginx/ssl/server.{crt,key}, the exact files
# nginx.conf loads, so no configuration changes are needed.
#
# Usage:
#   ./nginx/init-letsencrypt.sh                                  # issue (default domains)
#   ./nginx/init-letsencrypt.sh --renew                          # renew existing
#   ./nginx/init-letsencrypt.sh pdf.example.com example.com      # custom domains
#   LETSENCRYPT_EMAIL=you@example.com ./nginx/init-letsencrypt.sh
#
# Notes:
#   - Run from the project directory (the folder with docker-compose.yml).
#   - Needs Docker; no root on the host is required.
#   - --staging can be appended via LETSENCRYPT_STAGING=1 for a dry run.
# ---------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")/.."   # project root

SSL_DIR="nginx/ssl"
WEBROOT_DIR="nginx/certbot-www"
LE_DIR="nginx/letsencrypt"
CERTBOT_IMAGE="certbot/certbot:latest"

DEFAULT_DOMAINS=(pdf.farzani.my.id farzani.my.id www.farzani.my.id)
RENEW_ONLY=0
DOMAINS=()

for arg in "$@"; do
    case "$arg" in
        --renew) RENEW_ONLY=1 ;;
        *) DOMAINS+=("$arg") ;;
    esac
done
[ ${#DOMAINS[@]} -eq 0 ] && DOMAINS=("${DEFAULT_DOMAINS[@]}")

PRIMARY="${DOMAINS[0]}"

mkdir -p "$SSL_DIR" "$WEBROOT_DIR" "$LE_DIR"

if ! command -v docker >/dev/null 2>&1; then
    echo "docker not found in PATH." >&2
    exit 1
fi

# Build the -d flags for certbot.
DOMAIN_FLAGS=()
for d in "${DOMAINS[@]}"; do
    DOMAIN_FLAGS+=(-d "$d")
done

# ---------------------------------------------------------------------------
# Renewal path
# ---------------------------------------------------------------------------
if [ "$RENEW_ONLY" -eq 1 ]; then
    echo "==> Renewing certificate for: ${DOMAINS[*]}"
    docker run --rm \
        -v "$(pwd)/$WEBROOT_DIR:/var/www/certbot" \
        -v "$(pwd)/$LE_DIR:/etc/letsencrypt" \
        "$CERTBOT_IMAGE" renew --webroot -w /var/www/certbot --quiet
else
    # -----------------------------------------------------------------------
    # Issuance path
    # -----------------------------------------------------------------------
    echo "==> Requesting certificate for: ${DOMAINS[*]}"

    # The proxy must be up, because the ACME challenge is answered by nginx.
    if ! docker compose ps --status running --services 2>/dev/null | grep -qx proxy; then
        echo "==> Proxy is not running; starting it (self-signed cert is fine for this step)."
        docker compose up -d proxy
        sleep 3
    fi

    # Preflight: confirm the world can reach the challenge path over HTTP.
    # A failure here almost always means DNS or the provider's firewall.
    echo "==> Preflight: checking http://$PRIMARY/.well-known/acme-challenge/"
    if ! curl -fsS -o /dev/null --max-time 10 \
            "http://$PRIMARY/.well-known/acme-challenge/preflight" 2>/dev/null; then
        # A 404 is expected (no such file yet); only a connection failure is fatal.
        if ! curl -sS -o /dev/null --max-time 10 \
                "http://$PRIMARY/.well-known/acme-challenge/preflight" 2>/dev/null; then
            echo "!! Could not reach http://$PRIMARY over port 80." >&2
            echo "   Check that DNS for $PRIMARY points here and that port 80 is" >&2
            echo "   open in your cloud provider's security group / firewall." >&2
            exit 1
        fi
    fi

    CERTBOT_ARGS=(certonly --webroot -w /var/www/certbot
        --agree-tos --no-eff-email --keep-until-expiring)
    if [ -n "${LETSENCRYPT_EMAIL:-}" ]; then
        CERTBOT_ARGS+=(--email "$LETSENCRYPT_EMAIL")
    else
        CERTBOT_ARGS+=(--register-unsafely-without-email)
    fi
    if [ "${LETSENCRYPT_STAGING:-0}" = "1" ]; then
        CERTBOT_ARGS+=(--staging)
        echo "==> Using the ACME staging endpoint (certificate will NOT be trusted)."
    fi

    docker run --rm \
        -v "$(pwd)/$WEBROOT_DIR:/var/www/certbot" \
        -v "$(pwd)/$LE_DIR:/etc/letsencrypt" \
        "$CERTBOT_IMAGE" "${CERTBOT_ARGS[@]}" "${DOMAIN_FLAGS[@]}"
fi

# ---------------------------------------------------------------------------
# Install the certificate where nginx expects it.
#
# Certbot writes its live/ and archive/ directories as root with 0700, so the
# copy is done from a helper container (which runs as root) rather than from
# this shell — that keeps the script usable without sudo on the host.
# ---------------------------------------------------------------------------
echo "==> Installing certificate into $SSL_DIR/server.{crt,key}"

if ! docker run --rm \
        -v "$(pwd)/$LE_DIR:/etc/letsencrypt:ro" \
        -v "$(pwd)/$SSL_DIR:/ssl" \
        --entrypoint sh \
        "$CERTBOT_IMAGE" -c "
            set -e
            src=/etc/letsencrypt/live/$PRIMARY
            [ -s \"\$src/fullchain.pem\" ] || { echo \"missing \$src/fullchain.pem\"; exit 1; }
            [ -s \"\$src/privkey.pem\" ]   || { echo \"missing \$src/privkey.pem\"; exit 1; }
            cp -L \"\$src/fullchain.pem\" /ssl/server.crt
            cp -L \"\$src/privkey.pem\"   /ssl/server.key
            chmod 644 /ssl/server.crt
            chmod 600 /ssl/server.key
        "; then
    echo "!! Could not install the certificate from $LE_DIR/live/$PRIMARY" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Reload the proxy so it picks up the new certificate
# ---------------------------------------------------------------------------
if docker compose ps --status running --services 2>/dev/null | grep -qx proxy; then
    echo "==> Reloading nginx"
    docker compose exec -T proxy nginx -s reload
else
    echo "==> Proxy not running; it will use the new certificate on next start."
fi

cat <<EOF

Done. Certificate installed for: ${DOMAINS[*]}

Verify with:
  curl -vI https://$PRIMARY/ 2>&1 | grep -i 'subject:\\|issuer:'

Automatic renewal: this certificate expires after 90 days. Renew it with a
monthly cron entry, for example:

  0 3 1 * * cd $(pwd) && ./nginx/init-letsencrypt.sh --renew >> nginx/letsencrypt/renew.log 2>&1
EOF
