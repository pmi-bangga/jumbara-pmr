# 🏕️ Jumbara PMR — Sistem Penilaian Digital

Aplikasi web penilaian **Jumbara Palang Merah Remaja (PMR)** untuk juri, admin, dan pembina. Siap di-deploy **100% gratis** di **GitHub + Cloudflare Pages + Cloudflare D1**, dirancang **mobile-first** untuk juri di lapangan.

![PMI](assets/img/logo-pmi.png)

## ✨ Fitur Utama

- 🔐 **Multi-role:** Admin, Juri, Pembina
- 📱 **Mobile-first** UI untuk juri dengan QR camera scanning
- 🌙 **Dark mode & Light mode**
- 📶 **Offline sync** — juri bisa menilai tanpa internet, data sync otomatis
- 🖨️ **BLE Thermal Printing** — cetak struk & label QR via Bluetooth
- 📺 **TV Scoreboard** — tampilan publik tanpa data pribadi
- 📊 **Laporan & Export** — Excel (.xlsx) dan PDF
- 🔒 **Privasi** — halaman publik hanya tampilkan kode kontingen

---

## ☁️ Cara Deploy ke GitHub + Cloudflare (Gratis)

### 1️⃣ Upload ke GitHub
Push seluruh folder project ini ke repository GitHub Anda (Public atau Private).

### 2️⃣ Buat Database D1 di Cloudflare
1. Login ke [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Buka menu **Storage & Databases → D1 SQL Database**
3. Klik **Create** → beri nama `jumbara-pmr-db`
4. Masuk ke tab **Console** pada database tersebut, lalu copy-paste isi file [`migrations/0001_init.sql`](migrations/0001_init.sql) dan klik **Execute** (untuk membuat semua 16 tabel).
5. Catat **Database ID** yang muncul. (Opsional: isi `database_id` di `wrangler.toml`).

### 3️⃣ Hubungkan GitHub ke Cloudflare Pages
1. Di Cloudflare Dashboard, buka **Workers & Pages → Create → Pages → Connect to Git**
2. Pilih repository `jumbara-pmr` dari GitHub Anda
3. Pengaturan Build:
   - **Framework preset:** `None`
   - **Build command:** *(kosongkan)*
   - **Build output directory:** `/`
4. Klik **Save and Deploy**

### 4️⃣ Hubungkan D1 Database & Secret ke Pages
1. Setelah deploy pertama selesai, masuk ke project Pages Anda → **Settings → Bindings** (atau **Functions → D1 database bindings**)
2. Klik **Add** → pilih **D1 database**:
   - **Variable name:** `DB`
   - **D1 database:** `jumbara-pmr-db`
3. *(Disarankan)* Di **Settings → Environment variables**, tambahkan:
   - `SESSION_SECRET`: isi string acak panjang (misalnya 32+ karakter)
4. Buka tab **Deployments → Retry deployment** (atau push commit baru) agar binding aktif.

### 5️⃣ Selesai! 🎉
Buka URL `.pages.dev` Anda — data awal demo (akun, pos, kontingen, peserta) akan **otomatis dibuat** pada akses pertama!

---

## 👤 Akun Demo

| Username | Password | Role |
|----------|----------|------|
| `admin` | `admin123` | Admin PMI |
| `juri1` | `juri123` | Juri (Pos Pertolongan Pertama) |
| `juri2` | `juri123` | Juri (Pos Pertolongan Pertama) |
| `juri3` | `juri123` | Juri (Pos Tandu & KKR) |
| `pembina1` | `pembina123` | Pembina |
| `pembina2` | `pembina123` | Pembina |
| `pembina3` | `pembina123` | Pembina |

> ⚠️ **Catatan:** Ganti semua password default sebelum digunakan di kegiatan resmi!

---

## 📁 Struktur Project

```
jumbara-pmr/
├── index.html                 # Halaman utama (SPA)
├── publik.html                # TV Scoreboard & halaman nilai publik
├── favicon.ico                # Favicon PMI
├── wrangler.toml              # Konfigurasi Cloudflare Pages + D1
├── migrations/
│   └── 0001_init.sql          # Skema database D1 (16 tabel)
├── functions/                 # Cloudflare Pages Functions (Backend)
│   ├── api.js                 # Router API (/api?action=...)
│   └── _lib/
│       ├── auth.js            # Signed cookie session (HMAC-SHA256)
│       ├── helpers.js         # Utilitas, PBKDF2 hash, kalkulasi nilai
│       ├── seed.js            # Auto-seed data demo
│       ├── juri.js            # Endpoint juri
│       ├── admin.js           # Endpoint admin
│       └── pembina.js         # Endpoint pembina
└── assets/
    ├── css/pmi-theme.css      # Tema PMI (dark/light mode)
    ├── js/                    # Frontend Vanilla JS
    ├── img/logo-pmi.png       # Logo PMI
    └── vendor/                # Library JS (jsQR, jsPDF, xlsx, qrcode)
```
