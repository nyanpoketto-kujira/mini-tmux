# Discord Terminal / Shell Session Manager (mini-tmux)

Bot Discord interaktif berbasis **Node.js (Discord.js v14)** yang berfungsi sebagai **Terminal / Shell Session Manager (Multiplexer)** — mirip mini-tmux. Kamu bisa membuat banyak sesi shell `bash` sekaligus, berpindah antar sesi, dan menjalankan perintah langsung dari chat Discord dengan **dukungan terminal interaktif penuh** (SIGINT/Ctrl+C, ANSI output, navigasi panah, tab, dsb).

## ✨ Fitur Utama

- **Multi-Terminal Management** — Kelola banyak sesi shell sekaligus.
- **Pseudo-Terminal (PTY)** — Menggunakan `node-pty` (bukan `child_process` biasa), sehingga mendukung terminal interaktif, sinyal `SIGINT` (Ctrl+C), output ANSI, dan navigasi pseudo-terminal.
- **Streaming Output dengan Rate-Limit Handling** — Output terminal otomatis di-stream ke Discord menggunakan mekanisme buffer & batching (debounce), mengedit pesan terakhir secara terus-menerus.
- **Auto Pagination** — Jika output melebihi batas aman, otomatis membuat pesan baru dan melanjutkan aliran output di pesan tersebut.
- **Pembersihan Listener** — Bebas memory leak saat sesi di-kill.

## 🧱 Teknologi & Dependencies

| Library | Versi | Kegunaan |
|---------|-------|----------|
| `discord.js` | ^14.15.3 | Library Discord untuk berinteraksi dengan bot |
| `node-pty` | ^1.0.0 | Membuat pseudo-terminal (PTY) interaktif |
| `dotenv` | ^16.4.5 | Load konfigurasi token dari file `.env` |

> **Kenapa `node-pty`?** Berbeda dengan `child_process`, `node-pty` menyediakan pseudo-terminal sungguhan sehingga perintah interaktif (seperti `vim`, `htop`, `python`, `nano`, ftp, dll) bisa berjalan dan merespons input keyboard (termasuk Ctrl+C dan tombol panah) dengan benar.

## 📟 Daftar Command

### Session Management
| Command | Deskripsi |
|---------|-----------|
| `buat! <nama>` | Membuat session pty/`bash` baru dengan nama tersebut dan menjadikannya active session. |
| `pindah! <nama>` | Berpindah active session ke terminal yang sudah ada. |
| `hapus!` | Menghentikan/kill session aktif, lalu menghapusnya dari Map. |

### Input Terminal
| Command | Deskripsi |
|---------|-----------|
| `! <perintah>` | Menulis perintah ke stdin session aktif (newline `\r` ditambahkan otomatis). |
| `stdin! <teks>` | Menulis raw string ke stdin session aktif **tanpa modifikasi**. |
| `c!` | Mengirim sinyal Ctrl+C (Interrupt / `\x03`). |

### Navigasi & Input Dasar
| Command | ANSI yang dikirim | Arti |
|---------|-------------------|------|
| `up!` | `\x1b[A` | Panah atas |
| `down!` | `\x1b[B` | Panah bawah |
| `right!` | `\x1c[C` | Panah kanan |
| `left!` | `\x1b[D` | Panah kiri |
| `enter!` | `\r` | Enter/Return |
| `tab!` | `\t` | Tab |
| `space!` | ` ` | Spasi |

## ⚙️ Mekanisme Streaming & Rate-Limit Handling

Discord memiliki **rate limit (HTTP 429)** dan batas **2000 karakter per pesan**. Untuk mengatasinya:

1. Output terminal ditampung dalam **buffer**.
2. Mekanisme **debounce / interval throttle** (default **900ms**) menggabungkan output dan **meng-edit pesan Discord terakhir** (`edit message`).
3. Semua output dibungkus dalam **markdown block ANSI** (` ```ansi ... ``` `).
4. Jika akumulasi buffer melebihi **batas aman 1800 karakter**:
   - Pesan lama diselesaikan/diedit sampai batas tersebut.
   - Pesan chat **baru** dibuat di Discord.
   - Aliran output dilanjutkan di pesan baru (sisa buffer dipindahkan).
5. Jika pengiriman gagal (misal rate-limit), buffer **dikembalikan** agar output tidak hilang.

## 🧠 Arsitektur State

- **`sessions` (Map)** — key: `nama_session`, value: objek berisi instance `node-pty` (plus buffer, timer, dan referensi pesan output).
  ```js
  sessions = Map {
    "nama_session" => {
      ptyProcess,      // instance node-pty
      outputBuff,      // array buffer output
      flushTimer,      // debounce timer
      outputMsg,       // pesan Discord terakhir (untuk di-edit)
      _onData, _onExit // listener, untuk dibersihkan saat kill
    }
  }
  ```
- **`activeSession` (Map)** — key: `channelId`, value: `nama_session`. Menyimpan pointer session aktif untuk tiap channel (agar komunitas per-channel bisa independen).

## 🚀 Cara Menjalankan

### 1. Prasyarat
- [Node.js](https://nodejs.org) (disarankan LTS/terbaru)
- [pixi](https://pixi.sh) (opsional, untuk manajemen environment & build tools) **atau** alat build manual: `make`, `gcc`/`g++`, `python3` (diperlukan untuk meng-compile `node-pty`)
- Akun Discord + [aplikasi/bot di Discord Developer Portal](https://discord.com/developers/applications), lengkap dengan **token bot**.

### 2. Konfigurasi Token
```bash
cp .env.example .env
```
Lalu isi file `.env`:
```env
DISCORD_TOKEN=token_bot_anda_disini
```

### 3. Install Dependencies (menggunakan pixi)

```bash
# Inisialisasi environment pixi (buat pixi.lock) & install package:
pixi run install      # setara dengan: npm install
```

Atau tanpa pixi (wajib punya build tools sistem):
```bash
npm install
```

### 4. Jalankan Bot

```bash
# Menggunakan pixi:
pixi run              # setara dengan: node index.js

# atau manual:
node index.js
```

### 5. Invite Bot ke Server

Pastikan bot di-invite dengan permission:
- **Send Messages**
- **Manage Messages** *(wajib, karena output di-edit terus-menerus)*

Bot akan langsung aktif begitu login — tidak perlu menyiapkan slash command.

## 👀 Contoh Penggunaan

```
[Anda]      : buat! server1
[Bot]       : ✅ Session server1 dibuat & dijadikan ACTIVE.
[Anda]      : ! ls -la
[Bot]       : ```ansi
              total 12
              drwxr-xr-x ...
              ...
              ```ansi```

[Anda]      : buat! server2
[Bot]       : ✅ Session server2 dibuat & dijadikan ACTIVE.
[Anda]      : pindah! server1
[Bot]       : ✅ Berpindah ke session server1.
[Anda]      : c!
[Bot]       : (mengirim SIGINT ke session yang sedang berjalan)
[Anda]      : hapus!
[Bot]       : 💥 Session server1 telah dihentikan & dihapus.
```

## 🧹 Pembersihan & Anti Memory-Leak

Saat session di-kill (`hapus!` atau proses `exit`):
- **Timer flush** di-clear (`clearTimeout`).
- **Listener `data` & `exit` dihapus** (`removeListener`) dari instance pty.
- **Proses di-kill** (`ptyProcess.kill()`).
- Session **dihapus dari `Map`** dan pointer `activeSession` di channel yang bersangkutan dibersihkan.

Ini mencegah penumpukan listener dan kebocoran memori pada bot yang berjalan lama.

## 🛡️ Error Handling

Jika session tidak ditemukan atau belum ada session aktif, bot mengembalikan pesan error yang jelas:
- `❌ Session '<nama>' tidak ditemukan.`
- `❌ Tidak ada session aktif. Buat dengan 'buat! <nama>' dulu.`
- `❌ Session '<nama>' sudah ada.` (jika nama kembar)

Jika `DISCORD_TOKEN` tidak diisi saat bot dijalankan, bot akan keluar dengan pesan panduan.

## 🗂️ Struktur File

```
pr/
├── index.js          # Bot utama (semua logika & command)
├── package.json      # Dependencies & scripts npm
├── pixi.toml         # Environment pixi + tasks (run, install)
├── pixi.lock         # Lockfile pixi (dihasilkan saat install)
├── .env.example      # Template konfigurasi token
└── .gitignore        # Node_modules, .env, .pixi
```

## 📝 Lisensi

Bebas digunakan & dimodifikasi untuk keperluan pribadi maupun open-source.
