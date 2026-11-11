#!/usr/bin/env sh
# ---------------------------------------------------------------------------
# Generate a self-signed TLS certificate for the origin server.
#
# This is the FALLBACK path: run it once so the proxy container has a usable
# certificate before you have real ones. For public domains served directly
# (DNS pointing straight at this host, ports 80/443 reachable from the
# internet) prefer Let's Encrypt — see nginx/init-letsencrypt.sh, which
# overwrites the same two files.
#
# Usage:
#   chmod +x nginx/generate-ssl.sh
#   ./nginx/generate-ssl.sh pdf.farzani.my.id farzani.my.id www.farzani.my.id
#
# The first argument is the certificate CN; any further arguments are added as
# subjectAltName entries, so one certificate can cover the app subdomain and
# the maintenance host. `www.<CN>` is always included.
#
# Output is always ./nginx/ssl/server.crt and ./nginx/ssl/server.key, the
# names nginx.conf loads, so swapping in a real certificate is a file
# replacement with no config change.
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

if [ -f "$SSL_DIR/server.crt" ] && [ -f "$SSL_DIR/server.key" ]; then
    echo "Certificate already exists in $SSL_DIR — nothing to do."
    echo "Delete those files first if you want to regenerate."
    exit 0
fi

echo "Generating self-signed certificate for: $DOMAIN"
echo "Subject alternative names: $SAN"

openssl req -x509 -nodes -newkey rsa:4096 \
    -keyout "$SSL_DIR/server.key" \
    -out    "$SSL_DIR/server.crt" \
    -days   "$DAYS" \
    -subj   "/CN=$DOMAIN" \
    -addext "subjectAltName=$SAN"

chmod 600 "$SSL_DIR/server.key"
chmod 644 "$SSL_DIR/server.crt"

cat <<EOF

Self-signed certificate created:
  certificate: $SSL_DIR/server.crt
  private key: $SSL_DIR/server.key
  valid for:   $DAYS days
  covers:      $SAN

Browsers will warn until a trusted certificate replaces these files.
For a free trusted certificate, run:
  ./nginx/init-letsencrypt.sh $DOMAIN
EOF
