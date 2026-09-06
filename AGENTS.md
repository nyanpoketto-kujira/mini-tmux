# AGENTS.md

Discord terminal multiplexer bot. All logic lives in a single file: `index.js`. The whole bot is Indonesian-language (UI strings, comments, error messages) — keep new messages/comments in Indonesian to match.

## Commands
- `pixi run install` — install deps (npm install via pixi env; node-pty needs make/gcc/python build tools)
- `pixi run` or `node index.js` — run the bot
- `npm start` — also runs the bot
- No test / lint / typecheck setup exists.

## Setup & Env
- Requires `.env` with `DISCORD_TOKEN` (copy `.env.example`). Bot exits with a message if the token is missing.
- Optional admin guard: `ADMIN_MODE=true` + `ADMIN_ROLE_ID=<role id>`. Bila aktif, perintah berbahaya (lihat `isDangerous`, index.js) dari `!`/`stdin!` TIDAK dieksekusi langsung — bot tag role admin dengan embed peringatan + tombol `▶ Lanjutkan` (izinkan sekali) / `⛔ Hentikan`. Hanya member dengan role `ADMIN_ROLE_ID` yang bisa menekan tombol. **Admin yang mengetik perintah dikecualikan** (jalan langsung, tanpa blokir). Guard bisa di-toggle dari Discord: `safe!on|off` (hanya admin; `DANGEROUS_ENABLED` diubah jadi `let`, awalnya dari env). `DANGER_TEST_TERMS` berisi termin uji hardcoded (`"cat bakwangorengenak"`) yang deterministik memicu alur blokir.
- Native module: `node-pty` is a C++ addon. Uses `require()` (CommonJS) deliberately — do NOT convert to ESM import (handled at `index.js:6-13`).

## Architecture
- `sessions` (Map): name -> { ptyProcess, outputBuff, flushTimer, flushing, msg, currentText, lastCmdMsg, lastExit, _onData, _onExit }
  - `msg` = pesan Discord aktif; `currentText` = isi mentah yang sudah tampil di `msg` (kunci anti-menguap).
- `activeSession` (Map): channelId -> session name (per-channel active session)
- `node-pty` spawns bash on POSIX, powershell.exe on win32; TERM=xterm, COLORTERM unset to force 16-color ANSI (Discord-safe).
- `spawnSession` / `closeSession` must stay symmetric: `closeSession` (index.js:260) clears timer, removes listeners, kills pty, deletes from Map, clears activeSession pointer. Keep it that way to avoid memory leaks.

## Streaming / Rate-limit gotchas
- Discord 2000-char limit → safe cap `MAX_CHARS = 1800`, flush throttle `FLUSH_INTERVAL = 800`ms. Satu halaman = satu blok ` ```ansi ` via `renderPage` → `renderBlock`.
- `flushSession` (index.js:116) meng-EDIT pesan aktif sampai penuh (`cur` mendekati `MAX_CHARS`), lalu membuka pesan continuation baru (scroll) — output TIDAK "menguap". `cur`/`currentText` selalu disinkronkan ke `session.msg`. `!` commands start a fresh message: reset `session.msg = null; session.currentText = ""` + set `lastCmdMsg` (for exit-code emoji react).
- `splitChunk` (index.js:99) memotong ke `max` tanpa memotong di tengah escape SGR; bila escape tak muat di budget pesan aktif (`take===""`), buka pesan baru (`take2 = splitChunk(rest, MAX_CHARS)`). `pendingTail` (global, lintas session) menahan output yang gagal kirim / tak muat; pada kegagalan edit simpan hanya `rest` (bukan `cur + rest` — `cur` sudah tampil, memasukkannya lagi = duplikasi). Harus selalu ada progress (jangankan infinite loop).
- `cleanAnsi` (index.js:64) sanitizes ANSI for Discord. Critical constraints: keep `\x1b[` SGR sequences (`m` final byte) intact for colors, strip OSC title / cursor-move / 256-color / truecolor, and NEVER strip `\x1b` itself. Lone `\r` di-reduksi (overwrite baris, mis. `\r10%\r50%\r100%` → `100%`) SEBELUM langkah buang kontrol (yang juga membuang `\r`). Emulasi `\r` LINTAS-FLUSH ada di `flushSession` (index.js:140): kalau output baru diawali `\r` dan baris aktif belum diakhiri `\n`, segmen terbaru menimpa baris pesan (progress bar tidak menempel ke samping saat flush memotong baris). `flushSession` menormalkan `\r\n`→`\n` pada `rest` SEBELUM emulasi, karena terminal mengubah `\n` menjadi `\r\n` pada output (opost/onlcr) — bila tidak, baris progress penutup yang berakhir `\r` (→`split("\r").pop()` kosong) "terhapus" oleh guard `newCur.length>0` dan progress terakhir hilang. Fallback segmen-terakhir untuk `\r` di akhiran baris juga dipasang. This is the classic source of bugs — any color/regex change needs care.
- Verifikasi tanpa menjalankan bot: `node --check index.js` + ekstrak fungsi asli (`escapeBlock`, `cleanAnsi`, `renderBlock`, `renderPage`, `splitChunk`, `flushSession`, `isDangerous`) ke `vm` — lihat sim di `/tmp/opencode/sim.js` (mode `main`/`unit`/`rate`/`cr`/`replay`/`danger`).

## Discord intents (index.js:15-21)
`Guilds`, `GuildMessages`, `MessageContent` — all three required for message parsing to work. Bot needs Send Messages + Manage Messages permissions (it edits messages).
