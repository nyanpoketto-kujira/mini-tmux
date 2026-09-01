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
  // 1. Normalisasi newline
  let text = str.replace(/\r\n|\r/g, '\n');
  // 2. Hapus OSC title sequence (\x1b]...\x07)
  text = text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  // 3. Hapus non-SGR (cursor move, clear screen \x1b[2K, dll)
  //    Catatan: 'm' (SGR final byte) TIDAK boleh ada di range ini.
  text = text.replace(/\x1b\[[0-9;?]*[A-HJKSTf-lp-su]/g, '');
  // 4. Hapus 256-color & truecolor (\x1b[38;...m) yang tidak didukung Discord
  text = text.replace(/\x1b\[(?:38|48);[0-9;]+m/g, '');
  // 5. Normalisasi \x1b[m jadi \x1b[0m
  text = text.replace(/\x1b\[m/g, '\x1b[0m');
  // 6. Buang kontrol karakter HANYA selain \t, \n, dan \x1b (JANGAN HAPUS \x1b!)
  text = text.replace(/[\x00-\x08\x0B-\x1A\x1C-\x1F\x7F]/g, '');
  return text;
}

function renderBlock(chunk) {
  // Bungkus blok pesan dalam Markdown ANSI Discord.
  // Reset warna (`\x1b[0m`) di akhir supaya tidak menggumpal ke pesan berikut.
  return "```ansi\n" + escapeBlock(chunk) + "\x1b[0m\n```";
}

// Potong teks ke `max`, tanpa memotong di tengah urutan escape SGR (\x1b[...m)
function splitChunk(text, max) {
  if (text.length <= max) return [text, ""];
  let part = text.slice(0, max);
  const partial = part.match(/\x1b\[[0-9;]*$/);
  if (partial && !partial[0].endsWith("m")) {
    // mundur ke sebelum escape yang terpotong
    part = part.slice(0, part.length - partial[0].length);
    if (part.length === 0) part = text.slice(0, max);
  }
  return [part, text.slice(part.length)];
}

// ------------------- STREAMING / FLUSH -------------------
async function flushSession(channel, name) {
  const session = sessions.get(name);
  if (!session || session.flushing) return;
  session.flushing = true;

  try {
    // Proses SELURUH buffer yang tertunda pada setiap flush.
    // message pertama memakai `session.msg` (send jika null / edit jika ada),
    // bagian selanjutnya (output > MAX_CHARS) -> pesan continuation baru.
    while (session.outputBuff.length > 0) {
      const chunk = cleanAnsi(session.outputBuff.join(""));
      session.outputBuff.length = 0;
      if (chunk.length === 0) continue; // hanya noise ANSI, jangan kirim apa-apa

      let rest = chunk;
      let opened = false; // sudah ada pesan yang di-stream di flush ini

      while (rest.length > 0) {
        const [part, remainder] = splitChunk(rest, MAX_CHARS);
        rest = remainder;
        const text = renderBlock(part);

        try {
          if (!opened) {
            if (session.msg) {
              // masih dalam satu batch command -> stream (edit pesan aktif)
              await session.msg.edit(text);
            } else {
              // command baru dimulai -> buat pesan Discord BARU
              session.msg = await channel.send(text);
            }
          } else {
            // output melebihi ~1800 char: tutup blok ```ansi (sudah di-render),
            // buka blok ```ansi baru lewat pesan continuation baru.
            session.msg = await channel.send(text);
          }
          opened = true;
        } catch (err) {
          // rate limit / error Discord: simpan sisa buffer agar tidak hilang
          println(`[stream] Gagal kirim untuk '${name}': ${err.message}`);
          session.outputBuff.unshift(part + rest);
          return;
        }
      }
    }
  } finally {
    session.flushing = false;
    // Output yang masih datang selama flush -> lanjutkan stream berikutnya.
    if (session.outputBuff.length > 0) {
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
    msg: null, // pesan aktif utk batch command saat ini
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

  if (!content.startsWith("buat!") &&
      !content.startsWith("pindah!") &&
      content !== "hapus!" &&
      !content.startsWith("stdin!") &&
      content !== "c!" &&
      !(content in ANSI_MAP) &&
      !content.startsWith("!") &&
      !content.startsWith("help")) {
    return;
  }

  let reply = null;

  try {
    if (content.startsWith("help")) {
      reply = helpText();
    } else if (content.startsWith("buat! ")) {
      reply = handleCreate(channel, content.slice(6).trim());
    } else if (content.startsWith("pindah! ")) {
      reply = handlePindah(channel, content.slice(8).trim());
    } else if (content === "hapus!") {
      reply = await handleHapus(channel);
    } else if (content.startsWith("stdin! ")) {
      // Input interaktif: tetap stream ke pesan aktif terakhir
      const data = content.slice(7);
      reply = writeToActive(channel, data);
    } else if (content === "c!") {
      reply = writeToActive(channel, "\x03"); // Ctrl+C
    } else if (content in ANSI_MAP) {
      // Navigasi / input dasar: tetap update ke pesan aktif terakhir
      reply = writeToActive(channel, ANSI_MAP[content]);
    } else if (content.startsWith("! ")) {
      // PER-COMMAND STREAMING: command baru -> pesan Discord baru.
      // Reset pointer agar output berikutnya dibuatkan pesan sendiri,
      // tidak lagi meng-edit pesan command sebelumnya.
      const session = requireActive(channel);
      if (session) {
        session.msg = null;
        // Simpan pesan pemicu supaya bisa di-react emoji exit code ketika
        // command ini selesai dieksekusi pty.
        session.lastCmdMsg = message;
      }

      const cmd = content.slice(2) + "\r";
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