# Secure PDF Utility Suite

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-18+-green?logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/Express-4.x-blue?logo=express" alt="Express">
  <img src="https://img.shields.io/badge/License-MIT-yellow" alt="License">
  <img src="https://img.shields.io/badge/Demo-Live-brightgreen" alt="Demo">
</p>

Aplikasi pemrosesan PDF **self-hosted** yang aman, cepat, dan 100% sadar privasi. Semua pemrosesan dilakukan di server Anda sendiri - tidak ada data yang dikirim ke pihak ketiga.

## ✨ Demo

🌐 **Live Demo:** [https://pdf.farzani.my.id](https://pdf.farzani.my.id)

## 🎯 Fitur

| Fitur | Deskripsi |
|-------|-----------|
| **Merge PDF** | Gabungkan beberapa file PDF dengan drag-and-drop ordering. Preview halaman dan susun ulang sebelum merge. |
| **Split PDF** | Pisahkan PDF berdasarkan rentang halaman atau ekstrak semua halaman menjadi file terpisah. |
| **Compress PDF** | Kompres PDF dengan 3 level (Low, Recommended, Extreme) atau tentukan target ukuran output. |
| **PDF ke JPG** | Konversi halaman PDF ke gambar JPG dengan pilihan kualitas. |
| **JPG ke PDF** | Gabungkan gambar JPG/PNG menjadi PDF dengan pilihan ukuran kertas dan orientasi. |
| **Organize PDF** | Putar, hapus, dan susun ulang halaman PDF. Mendukung insert PDF tambahan. |

## 🛡️ Keamanan

- ✅ **Auto-delete** - File dihapus otomatis setelah 30 menit, entri tracker ikut dibersihkan
- ✅ **File Validation** - Validasi MIME type dengan magic bytes, file yang gagal ditolak dan dihapus
- ✅ **Path Traversal Protection** - Setiap `fileId` divalidasi whitelist dan path di-resolve tidak boleh keluar dari direktori upload/output
- ✅ **Rate Limiting** - Mencegah abuse, sadar reverse proxy via `X-Forwarded-For`
- ✅ **UUID Rename** - File di-rename dengan UUID untuk keamanan
- ✅ **Security Headers** - Helmet.js (CSP, nosniff, frameguard, dst.)
- ✅ **CORS Tertutup** - Default same-origin; origin tambahan harus dinyatakan eksplisit
- ✅ **Size Limit** - Batas ukuran file 50MB per file, 50 file per request
- ✅ **Error Konsisten** - 400/404/413/422 dibedakan, pesan tidak membocorkan path internal

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- npm atau yarn
- (Opsional) Docker & Docker Compose untuk deployment

### Installation

```bash
# Clone repository
git clone https://github.com/juanpradana/pdf-utility.git
cd pdf-utility

# Install dependencies
npm install

# Jalankan server
npm start
```

Server akan berjalan di `http://localhost:3001`

Untuk deployment dengan Docker, lihat bagian [Docker Deployment](#-docker-deployment).

### Development

```bash
# Jalankan dengan auto-reload
npm run dev
```

## 🏗️ Tech Stack

| Layer | Technology |
|-------|------------|
| **Backend** | Node.js, Express |
| **PDF Processing** | pdf-lib |
| **PDF Rendering** | PDF.js (client-side) |
| **Security** | helmet, express-rate-limit, cors |
| **Frontend** | Vanilla JS, Obsidian Slate dark-first theme (+ light mode), hash routing |
| **Reverse Proxy** | Eksternal (host Nginx / Nginx Proxy Manager / Caddy / Traefik / Cloudflare Tunnel) — aplikasi berjalan pada port 3001 |

> Tidak ada native dependency (`sharp`, `poppler`, dll) — semua operasi PDF
> ditangani `pdf-lib` di server dan Canvas/PDF.js di browser, sehingga image
> Docker berbasis Alpine dan tetap ringan.

## 📁 Project Structure

```
secure-pdf-utility-suite/
├── server.js              # Express server & API endpoints
├── package.json           # Dependencies & scripts
├── Dockerfile             # Production image (multi-stage, non-root)
├── docker-compose.yml     # Deployment stack (app on port 3001)
├── .dockerignore          # Build context exclusions
├── .env.example           # Configuration template
├── README.md              # Documentation
├── nginx/
│   ├── nginx.conf          # Contoh reverse proxy untuk host/main proxy
│   └── maintenance.html    # 503 page (opsional, untuk apex domain)
├── public/
│   ├── index.html         # Frontend HTML
│   ├── styles.css         # Design tokens & styles (dark-first + light theme)
│   └── app.js             # Frontend JavaScript
├── temp_uploads/          # Temporary upload storage (auto-created)
└── temp_outputs/          # Processed files storage (auto-created)
```

## 🐳 Docker Deployment

Docker Compose menjalankan **satu container** (`app`) pada **port 3001**
(dapat diubah lewat `PORT` di `.env`), siap diletakkan di belakang reverse
proxy utama di host (Nginx, Nginx Proxy Manager, Caddy, Traefik, atau
Cloudflare Tunnel):

| Service | Image | Peran |
|---------|-------|-------|
| `app` | build lokal (`pdf-utility:latest`) | Node/Express, di-expose pada port 3001 |

```bash
# 1. Siapkan konfigurasi
cp .env.example .env
nano .env                 # sesuaikan bila perlu (PORT, dll)

# 2. Build dan jalankan
docker compose up -d --build

# 3. Cek status dan log
docker compose ps
docker compose logs -f
```

Aplikasi tersedia di **port 3001** di host. Reverse proxy utama — yang menerima
trafik pada port 80 dan 443 serta melakukan terminasi TLS untuk
`pdf.farzani.my.id` — meneruskan request ke `http://127.0.0.1:3001`.
Redirect HTTP→HTTPS, terminasi TLS untuk `pdf.farzani.my.id`, dan routing
host lain (termasuk apex) ditangani oleh **reverse proxy utama**, bukan oleh
proyek ini. Contoh lengkap blok `server { ... }` untuk reverse proxy utama ada
di `nginx/nginx.conf` — tinggal disesuaikan `server_name` dan path sertifikat.

Aplikasi memakai `/api/health` untuk healthcheck container, dan
`TRUST_PROXY=true` membuat rate limit mempercayai header `X-Forwarded-*` dari
reverse proxy — jadi IP asli klien yang terhitung, bukan IP proxy.

Perintah lain yang sering dipakai:

```bash
docker compose restart          # restart container
docker compose down             # hentikan dan hapus container
docker compose up -d --build    # rebuild setelah update kode
docker compose logs -f --tail=100
```

Data sementara disimpan pada named volume `pdf-data`, sehingga tetap ada
meskipun container di-rebuild.

### TLS

Sertifikat dikelola oleh **reverse proxy utama**, bukan oleh proyek ini. Skrip
`nginx/init-letsencrypt.sh` dan `nginx/generate-ssl.sh` masih tersedia sebagai
referensi bila ingin menerbitkan sertifikat sendiri (mis. untuk Cloudflare
proxy), namun untuk deployment multi-subdomain sebaiknya sertifikat dikelola
pada lapisan proxy utama.

Sertifikat Let's Encrypt yang sudah ada di host (`/home/ubuntu/pdf-utility/
nginx/ssl/server.crt` dan `server.key`, kedaluwarsa Februari 2027) dapat
langsung dijadikan referensi oleh reverse proxy utama.

Jika domain berada di balik Cloudflare, set mode SSL/TLS ke **Full (strict)**
agar sertifikat origin diverifikasi.

## 🔧 Configuration

Seluruh konfigurasi lewat environment variable (lihat `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Port server |
| `NODE_ENV` | `production` | Mode runtime |
| `UPLOAD_DIR` | `/data/uploads` | Direktori file upload |
| `OUTPUT_DIR` | `/data/outputs` | Direktori hasil proses |
| `FILE_EXPIRY_MIN` | `30` | Umur file sebelum dihapus (menit) |
| `MAX_FILE_SIZE_MB` | `50` | Ukuran maksimum per file |
| `MAX_FILES` | `50` | Jumlah maksimum file per upload |
| `MAX_TRACKED_FILES` | `20000` | Batas entri tracker (eviksi tertua) |
| `CLEANUP_INTERVAL_MS` | `60000` | Interval pembersihan file kedaluwarsa |
| `RATE_LIMIT_WINDOW_MIN` | `15` | Jendela rate limit (menit) |
| `RATE_LIMIT_MAX` | `300` | Maksimum request per IP per jendela |
| `UPLOAD_RATE_LIMIT_MAX` | `60` | Maksimum upload per IP per jendela |
| `JSON_LIMIT` | `25mb` | Batas ukuran body JSON |
| `TRUST_PROXY` | `true` | Percaya `X-Forwarded-For` (di belakang proxy) |
| `FRONTEND_ORIGIN` | _(kosong)_ | Origin CORS tambahan; kosong = same-origin saja |

### Reverse Proxy & SSL

Reverse proxy sudah dibundel di `docker-compose.yml` (service `proxy`), jadi
tidak perlu memasang Nginx di host. Konfigurasinya ada di `nginx/nginx.conf`:
HTTP→HTTPS redirect, TLS 1.2/1.3, `client_max_body_size 100M`, timeout 300s
untuk proses PDF besar, dan `proxy_request_buffering off` agar upload besar
tidak menahan memori di proxy.

Karena `TRUST_PROXY=true`, rate limiting menghitung IP asli klien dari header
`X-Forwarded-For`, bukan IP proxy.

Jika ingin memakai Nginx host (mis. sudah ada Nginx lain), cukup bind ulang
`app` ke `127.0.0.1:3001` dan teruskan `X-Forwarded-*` seperti di atas.


## 📱 Responsive Design

Aplikasi ini fully responsive dan mendukung:
- Desktop (1024px+)
- Tablet (768px - 1024px)
- Mobile (< 768px)

Fitur touch drag-and-drop tersedia untuk perangkat mobile.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📜 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [pdf-lib](https://github.com/Hopding/pdf-lib) - PDF manipulation library
- [PDF.js](https://mozilla.github.io/pdf.js/) - PDF rendering in browser
- [Nginx](https://nginx.org/) - reverse proxy dan terminasi TLS di container `proxy`
