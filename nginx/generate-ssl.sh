#!/usr/bin/env sh
# ---------------------------------------------------------------------------
# Generate a self-signed TLS certificate for the origin server.
#
# Run this ONCE on the server before `docker compose up -d`:
#
#   chmod +x nginx/generate-ssl.sh
#   ./nginx/generate-ssl.sh pdf.farzani.my.id farzani.my.id www.farzani.my.id
#
# The first argument is the certificate CN; any further arguments are added as
# subjectAltName entries, so one certificate can cover the app subdomain and
# the maintenance host. `www.<CN>` is always included.
#
# The certificate is valid for 10 years and is only used to secure the
# connection between Cloudflare (or the browser) and this origin. Cloudflare
# should be set to "Full (strict)" mode for full verification.
# ---------------------------------------------------------------------------
set -eu

DOMAIN="${1:-pdf.farzani.my.id}"
shift || true

# Collect SANs: the CN, its www variant, then any extra names passed in.
SAN="DNS:$DOMAIN,DNS:www.$DOMAIN"
for extra in "$@"; do
    [ -n "$extra" ] || continue
    SAN="$SAN,DNS:$extra"
done

SSL_DIR="$(dirname "$0")/ssl"
DAYS=3650

mkdir -p "$SSL_DIR"

if [ -f "$SSL_DIR/selfsigned.crt" ] && [ -f "$SSL_DIR/selfsigned.key" ]; then
    echo "Certificate already exists in $SSL_DIR — nothing to do."
    echo "Delete those files first if you want to regenerate."
    exit 0
fi

echo "Generating self-signed certificate for: $DOMAIN"
echo "Subject alternative names: $SAN"

openssl req -x509 -nodes -newkey rsa:4096 \
    -keyout "$SSL_DIR/selfsigned.key" \
    -out    "$SSL_DIR/selfsigned.crt" \
    -days   "$DAYS" \
    -subj   "/CN=$DOMAIN" \
    -addext "subjectAltName=$SAN"

chmod 600 "$SSL_DIR/selfsigned.key"
chmod 644 "$SSL_DIR/selfsigned.crt"

cat <<EOF

Certificate created:
  certificate: $SSL_DIR/selfsigned.crt
  private key: $SSL_DIR/selfsigned.key
  valid for:   $DAYS days
  covers:      $SAN

In Cloudflare, for $DOMAIN:
  SSL/TLS  ->  Overview  ->  set encryption mode to "Full (strict)"
EOF