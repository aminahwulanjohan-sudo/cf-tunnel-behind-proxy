# cf-tunnel-behind-proxy

Jalankan **Cloudflare Named Tunnel** di VM yang **tidak punya akses internet langsung**
— semua egress wajib lewat HTTP proxy. Metode ini "mengibuli" `cloudflared`
agar bisa konek ke Cloudflare edge lewat proxy.

> Ditemukan 2026-10-02 setelah cara standar (`cloudflared tunnel run`) gagal total
> di VM dengan egress terbatas. Teruji jalan stabil sebagai named tunnel
> `Muse.ai` dengan 8 public hostname.

---

## Masalah yang dipecahkan

| Kendala | Cara normal | Hasil |
|---|---|---|
| Egress wajib via proxy | `cloudflared` konek langsung ke edge:7844 | ❌ Diblokir |
| `cloudflared` abaikan `https_proxy` untuk koneksi edge | Set proxy env var | ❌ Tetap konek langsung |
| DNS di-intercept | Resolve `region*.v2.argotunnel.com` normal | ❌ Tidak bisa dipakai |
| UDP mati total | QUIC / quick tunnel | ❌ Mustahil |

## Cara kerja (3 komponen)

```
cloudflared --protocol http2
  │
  │ ① Tanya DNS: "region1.v2.argotunnel.com di mana?"
  ▼
mini-dns (127.0.0.1:53, TCP)
  │ Jawab: "di 127.0.0.1" (+ SRV _v2-origintunneld → 127.0.0.1:7844)
  ▼
tcp-relay (127.0.0.1:7844)
  │ CONNECT edge:7844 via proxy → pipe byte mentah dua arah
  │ (TLS cloudflared ↔ edge tetap end-to-end, relay buta isi)
  ▼
Cloudflare edge ──→ tunnel terdaftar ✅
```

**Mount namespace**: `cloudflared` dijalankan via `unshare --mount` dengan
`/etc/resolv.conf` yang di-bind ke file berisi `nameserver 127.0.0.1` +
`options use-vc` (paksa TCP, karena UDP mati). Hanya cloudflared yang
dapat jawaban DNS palsu — program lain tetap pakai DNS normal.

**Kenapa `--protocol http2`**: QUIC butuh UDP yang mati di VM seperti ini.

---

## Struktur repo

```
scripts/
  tcp-relay.js        # 127.0.0.1:7844 → proxy CONNECT → Cloudflare edge
  mini-dns-tcp.js     # DNS palsu: SRV _v2-origintunneld + A region* → 127.0.0.1
  run-cf-tunnel.sh    # Entry point: start relay + jalankan cloudflared terisolasi
systemd/
  mini-dns.service
  tcp-relay.service
  cf-tunnel.service
docs/
  METHOD.md           # Panduan detail + prompt untuk replikasi di VM lain
```

## Cara pakai

### 1. Prasyarat
- Node.js (untuk relay & mini-dns, stdlib saja — tanpa dependensi)
- Binary `cloudflared`
- Token tunnel dari dashboard Cloudflare
  (Zero Trust → Networks → Tunnels → nama tunnel → Install → copy token)
- Info proxy VM: host, port, user, password

### 2. Install
```bash
sudo mkdir -p /opt/cf-tunnel
sudo cp -r scripts systemd /opt/cf-tunnel/

# simpan token (jangan commit!)
echo '<TOKEN_TUNNEL>' > ~/.cloudflared-token
chmod 600 ~/.cloudflared-token

# sesuaikan proxy di systemd/tcp-relay.service, lalu:
sudo cp systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mini-dns tcp-relay cf-tunnel
```

### 3. Verifikasi
```bash
journalctl -u cf-tunnel -f
# cari: "Registered tunnel connection"
```

### 4. Tambah public hostname
Via dashboard (Zero Trust → Tunnels → tunnel → Public Hostnames),
atau via API dengan token berizin **Account Cloudflare Tunnel Edit**.

---

## Catatan penting

- **Token harus fresh** dari dashboard. Error `Invalid tunnel secret` = token salah/kadaluarsa.
- **Tes IPv4 dulu** sebelum mengandalkan IPv6 — perilaku proxy bisa berubah
  (pernah: IPv4 dibunuh saat TLS handshake pagi hari, pulih sendiri siangnya).
- Kredensial proxy bisa rotate — kalau tunnel tiba-tiba mati, cek kredensial di
  `tcp-relay.service` / env.
- File ini **tidak berisi secret apapun**. Token & kredensial proxy selalu dari
  file lokal / env, jangan commit.

## Lisensi

MIT
