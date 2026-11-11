# Secure PDF Utility Suite

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-18+-green?logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/Express-4.x-blue?logo=express" alt="Express">
  <img src="https://img.shields.io/badge/License-MIT-yellow" alt="License">
  <img src="https://img.shields.io/badge/Demo-Live-brightgreen" alt="Demo">
</p>

Aplikasi pemrosesan PDF **self-hosted** yang aman, cepat, dan 100% sadar privasi. Semua pemrosesan dilakukan di server Anda sendiri - tidak ada data yang dikirim ke pihak ketiga.

## ✨ Demo

🌐 **Live Demo:** [https://pdf.farzani.space](https://pdf.farzani.space)

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
| **Image Processing** | sharp |
| **PDF Rendering** | PDF.js (client-side) |
| **Security** | helmet, express-rate-limit, cors |
| **Frontend** | Vanilla JS, Glassmorphism UI |

## 📁 Project Structure

```
secure-pdf-utility-suite/
├── server.js              # Express server & API endpoints
├── package.json           # Dependencies & scripts
├── Dockerfile             # Production image (multi-stage, non-root)
├── docker-compose.yml     # Deployment stack
├── .dockerignore          # Build context exclusions
├── .env.example           # Configuration template
├── README.md              # Documentation
├── public/
│   ├── index.html         # Frontend HTML
│   ├── styles.css         # Glassmorphism CSS styles
│   └── app.js             # Frontend JavaScript
├── temp_uploads/          # Temporary upload storage (auto-created)
└── temp_outputs/          # Processed files storage (auto-created)
```

## 🐳 Docker Deployment

Cara tercepat menjalankan di server: Docker Compose.

```bash
# 1. Siapkan konfigurasi
cp .env.example .env
nano .env                 # sesuaikan bila perlu

# 2. Build dan jalankan
docker compose up -d --build

# 3. Cek status dan log
docker compose ps
docker compose logs -f
```

Aplikasi akan tersedia di `http://<server>:3001`. Port di-bind ke `127.0.0.1`
saja — akses publik lewat reverse proxy (lihat di bawah).

Perintah lain yang sering dipakai:

```bash
docker compose restart          # restart container
docker compose down             # hentikan dan hapus container
docker compose up -d --build    # rebuild setelah update kode
docker compose logs -f --tail=100
```

Data sementara disimpan pada named volume `pdf-data`, sehingga tetap ada
meskipun container di-rebuild.

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

### Nginx + SSL (reverse proxy)

Jalankan app di port `3001` (Docker) dan letakkan Nginx di depannya. Contoh
konfigurasi untuk domain `pdf.farzani.my.id`:

```nginx
# /etc/nginx/sites-available/pdf.farzani.my.id
server {
    listen 80;
    server_name pdf.farzani.my.id;

    client_max_body_size 100M;   # samakan/lebihkan dari MAX_FILE_SIZE_MB

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;   # proses PDF besar butuh waktu
    }
}
```

Aktifkan dan reload:

```bash
sudo ln -s /etc/nginx/sites-available/pdf.farzani.my.id /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Karena `TRUST_PROXY=true`, rate limiting akan menghitung IP asli klien dari
header `X-Forwarded-For`, bukan IP proxy.

### SSL

Jika domain di-proxy Cloudflare, aktifkan mode **Full** dan pasang sertifikat
self-signed di origin:

```bash
sudo mkdir -p /etc/nginx/ssl
sudo openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout /etc/nginx/ssl/pdf.farzani.my.id.key \
  -out    /etc/nginx/ssl/pdf.farzani.my.id.crt \
  -subj   "/CN=pdf.farzani.my.id"
```

Lalu tambahkan blok HTTPS pada konfigurasi Nginx:

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name pdf.farzani.my.id;

    ssl_certificate     /etc/nginx/ssl/pdf.farzani.my.id.crt;
    ssl_certificate_key /etc/nginx/ssl/pdf.farzani.my.id.key;
    ssl_protocols       TLSv1.2 TLSv1.3;

    client_max_body_size 100M;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

Untuk origin tanpa Cloudflare, gunakan Let's Encrypt dengan Certbot:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d pdf.farzani.my.id
```


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
- [sharp](https://sharp.pixelplumbing.com/) - High performance image processing
