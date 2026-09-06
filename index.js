require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");

// Dynamic require for node-pty (native module). Jangan ubah ke ESM import,
// karena node-pty dibangun sebagai module native (C++ addon).
let pty;
try {
  pty = require("node-pty");
} catch (err) {
  console.error("Gagal load node-pty:", err.message);
  console.error("Pastikan node-pty sudah ter-install (npm install).");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ------------------- STATE (per session) -------------------
// Map session: key = nama_session, value = objek {
//   ptyProcess, flushTimer, flushing, outputBuff, msg
// }
const sessions = new Map();

// Pointer active session untuk tiap channel
// key = channelId, value = nama_session
const activeSession = new Map();

// Konstanta batas aman pesan (Discord max = 2000)
const MAX_CHARS = 1800; // akumulasi output sebelum membuat pesan baru
const FLUSH_INTERVAL = 800; // ms throttle: edit pesan aktif tiap ~800ms

// ------------------- UTIL -------------------
function getActiveName(channelId) {
  const name = activeSession.get(channelId);
  if (!name || !sessions.has(name)) return null;
  return name;
}

function println(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// Emoji angka untuk react exit code (0️⃣ 1️⃣ 2️⃣ ... 9️⃣)
const DIGIT_EMOJI = ["0️⃣", "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];

// Ubah exit code (angka) menjadi rangkaian emoji per-digit.
// Contoh: 0 -> 0️⃣, 42 -> 4️⃣2️⃣, 137 -> 1️⃣3️⃣7️⃣
function exitToEmoji(code) {
  if (code === null || code === undefined) return null;
  const digits = String(Math.max(0, Math.floor(code))).split("");
  return digits.map((d) => DIGIT_EMOJI[+d]).join("");
}

// Aman-kan teks untuk ditampilkan di dalam code block (hindari escape ```)
function escapeBlock(text) {
  return text.replace(/```/g, "`\u200b``");
}

function cleanAnsi(str) {
  if (!str) return '';
  // 1. Normalisasi CRLF -> LF.
  let text = str.replace(/\r\n/g, '\n');
  // 2. Reduksi lone \r (carriage return): terminal memindahkan kursor ke kolom 0,
  //    lalu karakter setelahnya menimpa baris. Sisakan hanya bagian setelah \r
  //    terakhir pada tiap baris (mis. "50%\r60%\r100%" -> "100%"). HARUS sebelum
  //    langkah pembersihan kontrol (langkah 6) yang ikut menghapus \r.
  text = text.split('\n').map((line) => {
    const idx = line.lastIndexOf('\r');
    return idx === -1 ? line : line.slice(idx + 1);
  }).join('\n');
  // 3. Hapus OSC title sequence (\x1b]...\x07)
  text = text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  // 4. Hapus non-SGR (cursor move, clear screen \x1b[2K, dll)
  //    Catatan: 'm' (SGR final byte) TIDAK boleh ada di range ini.
  text = text.replace(/\x1b\[[0-9;?]*[A-HJKSTf-lp-su]/g, '');
  // 5. Hapus 256-color & truecolor (\x1b[38;...m) yang tidak didukung Discord
  text = text.replace(/\x1b\[(?:38|48);[0-9;]+m/g, '');
  // 6. Normalisasi \x1b[m jadi \x1b[0m
  text = text.replace(/\x1b\[m/g, '\x1b[0m');
  // 7. Buang kontrol karakter HANYA selain \t, \n, dan \x1b (JANGAN HAPUS \x1b!)
  text = text.replace(/[\x00-\x08\x0B-\x1A\x1C-\x1F\x7F]/g, '');
  return text;
}

function renderBlock(chunk) {
  // Bungkus blok pesan dalam Markdown ANSI Discord.
  // Reset warna (`\x1b[0m`) di akhir supaya tidak menggumpal ke pesan berikut.
  return "```ansi\n" + escapeBlock(chunk) + "\x1b[0m\n```";
}

// Render satu "halaman" (pesan Discord) stream: dalam model append+scroll,
// satu halaman = satu blok kode.
function renderPage(page) {
  return renderBlock(page);
}

// Potong teks ke `max`, tanpa memotong di tengah urutan escape SGR (\x1b[...m)
// atau di tengah \x1b polos. Jika sepotong escape menempati seluruh budget,
// kembalikan part kosong (tidak memaksakan escape yang terpotong ke output).
function splitChunk(text, max) {
  if (text.length <= max) return [text, ""];
  let part = text.slice(0, max);
  const tr = part.match(/\x1b(\[[0-9;?]*)?$/);
  if (tr && !tr[0].endsWith("m")) {
    // mundur ke sebelum escape yang terpotong / \x1b polos
    part = part.slice(0, part.length - tr[0].length);
    // jangan paksa part kembali penuh (fallback lama) — escape bisa tertinggal
  }
  return [part, text.slice(part.length)];
}

// ------------------- STREAMING / FLUSH -------------------
// Sisa output yang gagal terkirim (rate-limit) / belum muat, menunggu flush
// berikutnya agar tidak ada data yang "menguap".
let pendingTail = "";

async function flushSession(channel, name) {
  const session = sessions.get(name);
  if (!session || session.flushing) return;
  session.flushing = true;

  try {
    while (session.outputBuff.length > 0 || pendingTail !== "") {
      // Proses output masuk dalam bentuk MENTAH: emulasi \r membutuhkan batas
      // antar-flush, sebelum reduksi per-baris \r pada cleanAnsi.
      const incoming = pendingTail + session.outputBuff.join("");
      session.outputBuff.length = 0;
      pendingTail = "";

      let rest = incoming;
      // Normalisasi CRLF -> LF di awal (sama seperti cleanAnsi). Terminal
      // mengubah \n menjadi \r\n pada output (opost/onlcr), jadi baris
      // progress yang dicetak lalu pindah baris tiba sebagai "\r<bar>\r\n".
      // Dengan normalisasi ini, \r penutup baris TIDAK dianggap menimpa isi
      // barisnya sendiri.
      rest = rest.replace(/\r\n/g, "\n");
      // `session.currentText` selalu memuat isi yang sudah tampil di
      // `session.msg`, jadi output tidak "menguap": kami meng-edit pesan yang
      // sama sampai penuh (MAX_CHARS), lalu membuka pesan baru (scroll).
      let cur = session.currentText ?? "";
      let msg = session.msg;

      // --- Emulasi \r LINTAS-FLUSH (progress bar) ---
      // Script mengupdate baris pakai "\r<segi>" pada baris yang sama. Bila
      // flush memotong baris itu, segmen lama sudah terlanjur tampil di pesan.
      // Kalau output baru diawali \r dan kursor masih di baris aktif (cur tak
      // diakhiri \n), segmen terbaru MENIMPA baris itu, bukan menempel ke samping.
      if (rest.startsWith("\r") && cur.length > 0 && !cur.endsWith("\n")) {
        const lastNl = cur.lastIndexOf("\n");
        const head = lastNl === -1 ? "" : cur.slice(0, lastNl + 1);
        const nlIdx = rest.indexOf("\n");
        const firstSeg = nlIdx === -1 ? rest : rest.slice(0, nlIdx);
        // Pertahankan \n berikutnya: \n = baris baru, bukan bagian yang ditimpa.
        rest = nlIdx === -1 ? "" : rest.slice(nlIdx);
        // Segmen setelah \r terakhir adalah tampilan baris tersebut.
        // Jaga-jaga bila baris berakhir \r (tanpa \n menyusul di flush sama):
        // \r itu hanya mengembalikan kursor, bukan menghapus isi baris.
        const seg = firstSeg.split("\r");
        let newActive = cleanAnsi(seg.pop());
        if (newActive === "" && seg.length > 0) {
          newActive = cleanAnsi(seg.pop());
        }
        const newCur = head + newActive;
        if (newCur.length > 0 && newCur.length <= MAX_CHARS) {
          try {
            msg = msg
              ? await msg.edit(renderPage(newCur))
              : await channel.send(renderPage(newCur));
          } catch (err) {
            println(`[stream] Gagal kirim '${name}': ${err.message}`);
            pendingTail = incoming;
            return;
          }
          cur = newCur;
          session.msg = msg;
          session.currentText = cur;
        } else if (newCur.length > 0) {
          // Baris hasil menimpa melebihi satu halaman -> mulai pesan baru.
          msg = null;
          cur = "";
          session.msg = null;
          session.currentText = "";
          rest = newCur + rest;
        }
      }

      // Bersihkan ANSI sisa (reduksi \r per-baris di dalamnya ikut dikerjakan).
      rest = cleanAnsi(rest);

      while (rest.length > 0) {
        // Sisa ruang yang tersedia di pesan aktif.
        const budget = MAX_CHARS - cur.length;

        let take, remainder;
        if (budget > 0) {
          // Masih ada ruang -> isi pesan aktif sampai batas MAX_CHARS.
          [take, remainder] = splitChunk(rest, budget);
          if (take === "") {
            // Eskap ANSI tidak muat di sisa ruang pesan aktif -> buka pesan
            // continuation baru untuk sisa output (agar escape tak terpotong).
            // `cur` sudah tampil penuh di pesan lama; mulai halaman baru.
            const [take2, rem2] = splitChunk(rest, MAX_CHARS);
            try {
              msg = await channel.send(renderPage(take2));
            } catch (err) {
              println(`[stream] Gagal kirim '${name}': ${err.message}`);
              pendingTail = rest;
              return;
            }
            cur = take2;
            session.msg = msg;
            session.currentText = cur;
            rest = rem2;
            continue;
          }
          const newText = cur + take;
          try {
            if (msg) {
              msg = await msg.edit(renderPage(newText));
            } else {
              msg = await channel.send(renderPage(newText));
            }
          } catch (err) {
            println(`[stream] Gagal kirim '${name}': ${err.message}`);
            // Jangan kehilangan data: kembali ke buffer, coba lagi flush berikut.
            // `cur` sudah tampil di `msg`, jadi cukup simpan `rest` (tak terkirim).
            pendingTail = rest;
            return;
          }
          cur = newText;
          session.msg = msg;
          session.currentText = cur;
          rest = remainder;
        } else {
          // Pesan aktif sudah penuh -> buka pesan continuation baru.
          [take, remainder] = splitChunk(rest, MAX_CHARS);
          try {
            msg = await channel.send(renderPage(take));
          } catch (err) {
            println(`[stream] Gagal kirim '${name}': ${err.message}`);
            pendingTail = rest;
            return;
          }
          cur = take;
          session.msg = msg;
          session.currentText = cur;
          rest = remainder;
        }
      }
    }
  } finally {
    session.flushing = false;
    // Output yang masih datang selama flush -> lanjutkan stream berikutnya.
    if (session.outputBuff.length > 0 || pendingTail !== "") {
      scheduleFlush(channel, name);
    }
  }
}

// ------------------- SESSION LIFECYCLE -------------------
function spawnSession(channel, name) {
  if (sessions.has(name)) {
    throw new Error(`Session '${name}' sudah ada.`);
  }

  // Lebar/tinggi terminal. cols=90, rows=30.
  // TERM=xterm (bukan 256color) agar CLI tools hanya pakai 16 warna ANSI
  // standar yang didukung Discord. COLORTERM dikosongkan agar aplikasi tidak
  // mengirim RGB truecolor.
  const ptyProcess = pty.spawn(process.platform === "win32" ? "powershell.exe" : "bash", [], {
    name: "xterm",
    cols: 90,
    rows: 30,
    cwd: process.env.HOME || process.cwd(),
    env: { ...process.env, TERM: "xterm", COLORTERM: "" },
  });

  const session = {
    ptyProcess,
    outputBuff: [],
    flushTimer: null,
    flushing: false,
    msg: null, // pesan Discord aktif (sdg di-stream/append)
    currentText: "", // isi mentah yg sudah tampil di `msg` (anti-menguap)
    lastExit: null, // exitCode + signal terakhir sesi ini
    // Pesan Discord pemicu command terakhir. Dipakai sebagai target react
    // emoji exit code saat pty selesai menjalankan command.
    lastCmdMsg: null,
    _onData: null,
    _onExit: null,
  };

  // Listener output
  session._onData = (data) => {
    session.outputBuff.push(data);
    // Flag ke chat: panggil scheduler flush
    scheduleFlush(channel, name);
  };

  session._onExit = (evt) => {
    // node-pty: evt = { exitCode, signal }
    const exitCode = evt?.exitCode ?? null;
    const signal = evt?.signal ?? null;
    session.lastExit = { exitCode, signal };
    println(`Session '${name}' exited dengan code ${exitCode}${signal ? ` (signal ${signal})` : ""}`);

    // React emoji angka sesuai digit exit code ke pesan pemicu command &
    // pesan output terakhir, sebelum sesi ditutup.
    reactExitCode(session, channel);

    closeSession(name, channel);
  };

  ptyProcess.onData(session._onData);
  ptyProcess.onExit(session._onExit);

  sessions.set(name, session);
  return ptyProcess;
}

// React emoji angka (0️⃣1️⃣2️⃣...) ke pesan trigger & output sesuai digit exit
// code. Aman (catch) bila pesan sudah dihapus / tidak tersedia.
async function reactExitCode(session, channel) {
  if (!session?.lastExit) return;
  const emoji = exitToEmoji(session.lastExit.exitCode);
  if (!emoji) {
    println(`[exit] Sesi dibunuh sinyal, tanpa exit code -> tidak react.`);
    return;
  }

  const targets = new Set();
  if (session.lastCmdMsg?.id) targets.add(session.lastCmdMsg);
  if (session.msg?.id && session.msg.id !== session.lastCmdMsg?.id) {
    targets.add(session.msg);
  }

  for (const target of targets) {
    try {
      if (!target.reactions?.cache?.has(emoji)) {
        await target.react(emoji);
      }
    } catch (err) {
      println(`[exit] Gagal react '${emoji}' ke pesan: ${err.message}`);
    }
  }
}

function scheduleFlush(channel, name) {
  const session = sessions.get(name);
  if (!session) return;

  // Throttle ~800ms: TIDAK reset timer pada setiap data (bukan debounce).
  // Maksimal 1 flush per interval, lalu flush lanjutan lewat `finally` di
  // flushSession bila output terus masuk. Ini mencegah edit Discord spam.
  if (session.flushing || session.flushTimer) return;

  session.flushTimer = setTimeout(() => {
    session.flushTimer = null;
    flushSession(channel, name).catch((err) => {
      println(`[flush] Error di session '${name}': ${err.message}`);
    });
  }, FLUSH_INTERVAL);
}

function closeSession(name, channel) {
  const session = sessions.get(name);
  if (!session) return;

  // Bersihkan timer
  if (session.flushTimer) {
    clearTimeout(session.flushTimer);
    session.flushTimer = null;
  }

  // Hapus listener (cegah memory leak)
  try {
    session.ptyProcess.removeListener("data", session._onData);
    session.ptyProcess.removeListener("exit", session._onExit);
  } catch {}

  // Kill process kalau masih hidup
  try {
    session.ptyProcess.kill();
  } catch {}

  sessions.delete(name);

  // Kalau session aktif di channel ini, bersihkan pointer
  if (activeSession.get(channel?.id) === name) {
    activeSession.delete(channel.id);
  }

  flushSession(channel, name).catch(() => {});
}

// ------------------- COMMAND HANDLERS -------------------
function handleCreate(channel, name) {
  if (!name) return "❌ Gunakan format: `buat! <nama>`";
  try {
    spawnSession(channel, name);
    activeSession.set(channel.id, name);
    return `✅ Session **${name}** dibuat & dijadikan ACTIVE.`;
  } catch (err) {
    return `❌ ${err.message}`;
  }
}

function handlePindah(channel, name) {
  if (!name) return "❌ Gunakan format: `pindah! <nama>`";
  if (!sessions.has(name)) return `❌ Session **${name}** tidak ditemukan.`;
  activeSession.set(channel.id, name);
  return `✅ Berpindah ke session **${name}**.`;
}

async function handleHapus(channel) {
  const name = getActiveName(channel.id);
  if (!name) return "❌ Tidak ada session aktif di channel ini.";
  closeSession(name, channel);
  return `💥 Session **${name}** telah dihentikan & dihapus.`;
}

function requireActive(channel) {
  const name = getActiveName(channel.id);
  if (!name) return null;
  return sessions.get(name);
}

function writeToActive(channel, data) {
  const session = requireActive(channel);
  if (!session) return "❌ Tidak ada session aktif. Buat dengan `buat! <nama>` dulu.";
  try {
    session.ptyProcess.write(data);
    return null;
  } catch (err) {
    return `❌ Gagal menulis ke session: ${err.message}`;
  }
}

// ------------------- MESSAGE PARSING -------------------
const ANSI_MAP = {
  "up!": "\x1b[A",
  "down!": "\x1b[B",
  "right!": "\x1b[C",
  "left!": "\x1b[D",
  "enter!": "\r",
  "tab!": "\t",
  "space!": " ",
};

async function onMessage(message) {
  if (message.author.bot) return;
  const { channel, content } = message;

  // Normalisasi: terima "buat!" / "buat! nama", juga tanpa spasi setelah "!".
  const stripped = content.trim();

  const isCommand =
    stripped.startsWith("buat!") ||
    stripped.startsWith("pindah!") ||
    stripped === "hapus!" ||
    stripped.startsWith("stdin!") ||
    stripped === "c!" ||
    Object.prototype.hasOwnProperty.call(ANSI_MAP, stripped) ||
    stripped.startsWith("!") ||
    stripped.startsWith("help");

  if (!isCommand) {
    return;
  }

  let reply = null;

  try {
    let body = stripped;

    if (body.startsWith("help")) {
      reply = helpText();
    } else if (body.startsWith("buat!")) {
      reply = handleCreate(channel, body.slice(5).trim());
    } else if (body.startsWith("pindah!")) {
      reply = handlePindah(channel, body.slice(7).trim());
    } else if (body === "hapus!") {
      reply = await handleHapus(channel);
    } else if (body.startsWith("stdin!")) {
      // Input interaktif: tetap stream ke pesan aktif terakhir.
      // Hapus satu spasi pemisah bila ada, kirim sisanya verbatim.
      const data = body.slice(6).replace(/^ /, "");
      reply = writeToActive(channel, data);
    } else if (body === "c!") {
      reply = writeToActive(channel, "\x03"); // Ctrl+C
    } else if (Object.prototype.hasOwnProperty.call(ANSI_MAP, body)) {
      // Navigasi / input dasar: tetap update ke pesan aktif terakhir
      reply = writeToActive(channel, ANSI_MAP[body]);
    } else if (body.startsWith("!")) {
      // PER-COMMAND STREAMING: command baru -> pesan Discord baru.
      // Terima "! cmd" maupun "!cmd", lalu append \r sebagai Enter PTY.
      const session = requireActive(channel);
      if (session) {
        // Segmen baru: pesan output perintah ini dibuat sendiri. Output
        // segmen sebelumnya sudah tampil di `session.msg` (bukan hilang).
        session.msg = null;
        session.currentText = "";
        // Simpan pesan pemicu supaya bisa di-react emoji exit code ketika
        // command ini selesai dieksekusi pty.
        session.lastCmdMsg = message;
      }

      const cmd = body.slice(1).trimStart() + "\r";
      reply = writeToActive(channel, cmd);
    }

    if (reply) {
      await channel.send(reply);
    }

    // Jangan hapus pesan perintah, biarkan sebagai riwayat.
  } catch (err) {
    println(`Error handling message: ${err.message}`);
    await channel.send(`❌ Error: ${err.message}`).catch(() => {});
  }
}

function helpText() {
  return `**📟 Terminal Session Manager (mini-tmux)**
\`\`\`
— Session Management —
buat! <nama>     Buat session baru & jadikan active
pindah! <nama>   Pindah ke session yang sudah ada
hapus!           Hentikan & hapus session aktif

— Input Terminal —
! <perintah>     Kirim perintah (auto newline)
                 -> output di-stream di pesan BARU per command
stdin! <teks>    Kirim raw string (update pesan aktif terakhir)
c!               Kirim Ctrl+C (Interrupt)

— Navigasi & Dasar —
up! down! right! left!
enter!  tab!  space!
\`\`\`
⚠️ Output terminal di-stream (edit message) otomatis & throttle ~800ms.
Output per-perintah dibuat di pesan Discord terpisah.
Output ANSI warna (mis. \`ls --color\`) dirender BERWARNA di Discord
melalui block \`\`\`ansi (escape SGR dipertahankan).
Pastikan bot punya permission **Send Messages** & **Manage Messages**.`;
}

// ------------------- BOOT -------------------
client.once("ready", () => {
  println(`Bot online sebagai ${client.user.tag}`);
  println("List session aktif akan ditampilkan di log.");
});

client.on("messageCreate", onMessage);

// ------------------- BOOT -------------------
const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("DISCORD_TOKEN tidak ditemukan di environment.");
  console.error("Salin .env.example ke .env dan isi token bot Anda.");
  process.exit(1);
}

client.login(token);