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

- ✅ **Auto-delete** - File dihapus otomatis setelah 30 menit
- ✅ **File Validation** - Validasi MIME type dengan magic bytes
- ✅ **Rate Limiting** - Mencegah abuse dengan pembatasan request
- ✅ **UUID Rename** - File di-rename dengan UUID untuk keamanan
- ✅ **Security Headers** - Helmet.js untuk HTTP security headers
- ✅ **Size Limit** - Batas ukuran file 50MB per file

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ 
- npm atau yarn

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
├── README.md              # Documentation
├── public/
│   ├── index.html         # Frontend HTML
│   ├── styles.css         # Glassmorphism CSS styles
│   └── app.js             # Frontend JavaScript
├── temp_uploads/          # Temporary upload storage (auto-created)
└── temp_outputs/          # Processed files storage (auto-created)
```

## 🔧 Configuration

Edit `server.js` untuk konfigurasi:

```javascript
const PORT = process.env.PORT || 3001;      // Port server
const FILE_EXPIRY_MS = 30 * 60 * 1000;      // File expiry (30 menit)
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3001 | Port server |

### Nginx Configuration (Production)

Jika menggunakan Nginx sebagai reverse proxy, pastikan untuk mengatur `client_max_body_size` agar upload file besar tidak mengalami error **413 Request Entity Too Large**:

```nginx
# /etc/nginx/sites-available/pdf.farzani.space
server {
    ...
    client_max_body_size 100M;  # Sesuaikan dengan kebutuhan
    ...
}
```

Setelah update, reload Nginx:
```bash
sudo nginx -t && sudo systemctl reload nginx
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
