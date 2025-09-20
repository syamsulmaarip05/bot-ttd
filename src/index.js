// src/index.js
require("dotenv").config();
const wppconnect = require("@wppconnect-team/wppconnect");
const cron = require("node-cron");
const fs = require("fs/promises");
const fssync = require("fs");
const path = require("path");

// ========== KONFIGURASI ==========
const TZ = process.env.TZ || "Asia/Jakarta";
const CRON = process.env.CRON || "0 8 * * 4"; // Kamis 08:00 WIB
const MESSAGE =
  process.env.MESSAGE ||
  "Reminder TTD! Yuk, segera minum Tablet Tambah Darahmu hari ini agar tetap fokus dan bertenaga. Ingat, sesudah makan dan ditemani air putih. Mohon segera klik link laporan ini setelah kamu minum obatnya: https://unsilbakti.com 💊😊";
const HEADLESS = (process.env.HEADLESS ?? "false").toLowerCase() === "true"; // default: false agar QR mudah discan

// ========== HELPER ==========
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Normalisasi nomor menjadi 628xx...@c.us */
function toWaId(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, ""); // ambil digit saja
  if (d.startsWith("6262")) d = d.slice(2); // buang duplikasi '62' di depan

  if (d.startsWith("0")) d = "62" + d.slice(1); // 08xxxx -> 628xxxx
  else if (d.startsWith("8")) d = "62" + d; // 8xxxx  -> 628xxxx
  // jika bukan 0/8/62, biarkan (anggap sudah internasional)

  const after62 = d.startsWith("62") ? d.slice(2) : d;
  if (after62.length < 9 || after62.length > 13) return null; // validasi kasar panjang
  return d + "@c.us";
}

async function loadStudents() {
  const raw = await fs.readFile("./data/students.json", "utf8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data))
    throw new Error("students.json harus berupa array objek");
  return data;
}

/** Tunggu sampai WPPConnect benar2 siap (CONNECTED / inChat) */
async function waitForConnected(client, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const [state, isConn] = await Promise.all([
        client.getConnectionState().catch(() => ""),
        client.isConnected().catch(() => false),
      ]);
      // state umum: OPENING, SYNCING, CONNECTED, inChat
      if (isConn || state === "CONNECTED" || state === "inChat") return true;
    } catch {}
    await sleep(1000);
  }
  throw new Error("Timeout: belum CONNECTED setelah menunggu.");
}

/** Kirim pesan ke semua siswa */
async function sendReminders(client) {
  const students = await loadStudents();
  console.log(`[INFO] Mulai kirim ${students.length} pesan pengingat TTD...`);

  for (const [i, s] of students.entries()) {
    try {
      const to = toWaId(s.phone);
      if (!to) {
        console.error(`⚠️ Format nomor mencurigakan: ${s.phone}`);
        continue;
      }
      console.log(`[DEBUG] Normalized ${s.phone} -> ${to}`);

      // Cek nomor terdaftar & bisa menerima pesan
      const status = await client.checkNumberStatus(to).catch(() => null);
      if (!status || status.status !== 200) {
        console.error(`⚠️ Nomor tidak bisa menerima WA: ${s.phone}`);
        continue;
      }

      const text = `Halo ${s.name || "Siswa"}, ${MESSAGE}`;
      await client.sendText(to, text);
      console.log(
        `✅ [${i + 1}/${students.length}] Terkirim ke ${s.name} (${s.phone})`
      );
    } catch (e) {
      console.error(
        `❌ Gagal kirim ke ${s?.name || "-"} (${s?.phone || "-"})`,
        e?.message || e
      );
    }
    await sleep(1200); // jeda aman antar pesan
  }

  console.log("[INFO] Selesai kirim semua pengingat.");
}

// ========== BOOTSTRAP ==========
wppconnect
  .create({
    session: "ttd-bot",
    puppeteerOptions: {
      headless: true, 
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    },
    // Simpan QR ke file agar mudah discan
    catchQR: (base64Qr /*, asciiQR, attempts, urlCode */) => {
      try {
        const out = path.join(__dirname, "../qr.png");
        const png = base64Qr.replace(/^data:image\/png;base64,/, "");
        fssync.writeFileSync(out, png, "base64");
        console.log(
          `🔳 QR disimpan ke ${out}. Scan via WhatsApp → Linked devices. (QR akan diperbarui bila expired)`
        );
      } catch (e) {
        console.log("Gagal menyimpan QR:", e?.message || e);
      }
    },
    statusFind: (status, session) => console.log("[STATE]", session, status),
    // autoClose: 0, // uncomment jika tidak ingin auto close saat idle
  })
  .then(async (client) => {
    console.log("[READY] WPPConnect siap. Menjadwalkan pengingat...");

    // Balas sederhana "ping" -> "pong"
    client.onMessage(async (msg) => {
      if ((msg?.body || "").trim().toLowerCase() === "ping") {
        await client.sendText(msg.from, "pong ✅");
      }
    });

    // Jadwal CRON
    cron.schedule(
      CRON,
      async () => {
        console.log(`[CRON] Trigger pengingat (TZ=${TZ})`);
        await waitForConnected(client); // ⬅️ pastikan benar2 siap
        await sendReminders(client);
      },
      { timezone: TZ }
    );

    // Uji cepat saat start
    if (process.env.SEND_NOW === "1") {
      await waitForConnected(client); // ⬅️ pastikan siap dulu
      await sendReminders(client);
    }
  })
  .catch((e) => console.error("[BOOT ERROR]", e));
