#!/bin/bash
# run-cf-tunnel.sh — cloudflared named tunnel via tcp-relay + mini-dns
# Alur: cloudflared -> 127.0.0.1:7844 (tcp-relay) -> proxy CONNECT edge:7844 -> Cloudflare
#
# Prasyarat:
#   1. Token tunnel dari dashboard Cloudflare (Zero Trust > Tunnels > [nama] > Install)
#      Simpan di ~/.cloudflared-token (permission 600)
#   2. Proxy env var tersedia (https_proxy) ATAU set PROXY_HOST/PROXY_PORT/PROXY_USER/PROXY_PASS
#   3. Node.js terinstall (untuk tcp-relay.js & mini-dns-tcp.js)
#   4. cloudflared binary terinstall
set -e
cd "$(dirname "$0")"

# pastikan service pendukung jalan
systemctl is-active --quiet mini-dns 2>/dev/null || sudo systemctl start mini-dns 2>/dev/null || node mini-dns-tcp.js &
systemctl is-active --quiet tcp-relay 2>/dev/null || sudo systemctl start tcp-relay 2>/dev/null || node tcp-relay.js &
sleep 1

# resolv.conf khusus: paksa cloudflared pakai mini-dns lokal via TCP
printf 'nameserver 127.0.0.1\noptions use-vc\n' > /tmp/resolv.cf-tunnel

TOKEN_FILE="$HOME/.cloudflared-token"
[ -f "$TOKEN_FILE" ] || { echo "Token tidak ditemukan di $TOKEN_FILE"; exit 1; }
TOKEN=$(cat "$TOKEN_FILE")

exec unshare --mount bash -c '
mount --bind /tmp/resolv.cf-tunnel /etc/resolv.conf
exec env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY \
  GODEBUG=netdns=cgo \
  cloudflared tunnel --no-autoupdate --protocol http2 run --token "$0"
' "$TOKEN"
