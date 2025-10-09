const express = require("express");

const Papa = require("papaparse");
const axios = require("axios");
require("dotenv").config();
const pool = require("./db/connection");
const app = express();
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const GAS_URL = process.env.GAS_URL;
const TARGET_ROOM = process.env.TARGET_ROOM;
const FLOWISE_URL = process.env.FLOWISE_URL;
const QONTAK_TOKEN = process.env.QONTAK_TOKEN;
const QONTAK_URL = process.env.QONTAK_URL;
const BOT_ID = process.env.BOT_ID;
const TARGET_SENDER = process.env.TARGET_SENDER;
const TARGET_ACCOUNT = process.env.TARGET_ACCOUNT;
const PORT = process.env.PORT || 3001;
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));
const client = require("./redisClient");
const FormData = require("form-data");


/**
 * @route POST /cek
 * @description Mengecek data penggunaan ICCID via API gkomunika.
 * @param {string} req.body.nomor - Nomor ICCID yang akan dicek.
 * @returns {Object} JSON hasil pengecekan, termasuk bundle, status, usage per negara, dll.
 */
/* ================================
   ROUTE CEK DATA USAGE
================================ */

app.post("/cek", async (req, res) => {
  try {
    const { nomor } = req.body;

    if (!nomor) {
      return res.status(400).json({ error: "nomor tidak boleh kosong" });
    }

    // Hit API gkomunika
    const response = await axios.post(
      "https://gkomunika.id/api/v1/check/data_info",
      new URLSearchParams({ iccid: nomor }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    // Ambil data dari struktur tradeData.subOrderList
    const data = response.data?.tradeData?.subOrderList?.[0];
    if (!data) {
      return res.status(404).json({
        error: "Data tidak ditemukan",
        raw: response.data,
      });
    }

    // Helper format KB → MB/GB
    const formatData = (kb) => {
      const mb = kb / 1024;
      if (mb >= 1024) return (mb / 1024).toFixed(2) + " GB";
      return mb.toFixed(2) + " MB";
    };

    // Hitung total usage & per negara
    let totalUsageKB = 0;
    const usagePerCountry = {};
    const usageDetail = (data.usageInfoList || []).map((u) => {
      const usedKB = parseInt(u.usedAmount, 10) || 0;
      totalUsageKB += usedKB;
      usagePerCountry[u.country] = (usagePerCountry[u.country] || 0) + usedKB;

      return {
        date: `${u.usedDate.slice(0, 4)}-${u.usedDate.slice(4, 6)}-${u.usedDate.slice(6, 8)}`,
        country: u.country,
        usage: formatData(usedKB),
      };
    });

    // Ringkasan
    const hasil = {
      bundle: data.skuName,
      activeDate: data.planStartTime,
      endDate: data.planEndTime,
      status: data.planStatus === "2" ? "Selesai" : "Aktif",
      durationDays: data.totalDays,
      totalUsage: formatData(totalUsageKB),
      usageByCountry: Object.entries(usagePerCountry).map(([country, used]) => ({
        country,
        usage: formatData(used),
      })),
      usageDetail,
    };

    res.json({ nomor, hasil });
  } catch (err) {
    console.error("=== ERROR ===", err.message);
    res.status(500).json({ error: err.message });
  }
});





/* ================================
   ROUTE WEBHOOK (Qontak)
================================ */

// 🔑 Ambil dari .env
// Simpan state blok per room
// state blok per room

// ====== CONFIG & STATE ======
const BUFFER_TIMEOUT = 3_000; // 5 detik buffer
const bufferStore = {};
const bufferTimers = {};

const bearer = (t = "") => (/^bearer\s+/i.test(t) ? t : `Bearer ${t}`);

// ===== DETEKSI ADMIN HANDOFF =====
function isAdminHandoffSignal(ans) {
  if (!ans) return false;
  const s = String(ans).trim().toLowerCase();
  const patterns = [
    /^admin\.?$/,
    /^<admin>$/,
    /^handoff$/,
    /^route_to_admin$/,
    /#\s*handoff\b/,
  ];
  return patterns.some((rx) => rx.test(s));
}

// ===== MIME DETECTOR =====
function guessMime(url = "") {
  const u = url.toLowerCase();
  if (u.endsWith(".png")) return "image/png";
  if (u.endsWith(".webp")) return "image/webp";
  if (u.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

// ====== QONTAK HELPERS ======
async function sendQontakText(roomId, text) {
  console.log(`[QONTAK] Room ${roomId} - Pesan bot: ${text}`);
  return axios.post(
    process.env.QONTAK_URL,
    { room_id: roomId, type: "text", text },
    {
      headers: {
        Authorization: bearer(process.env.QONTAK_TOKEN || ""),
        "Content-Type": "application/json",
      },
    }
  );
}

async function addRoomTagAndAssign(roomId, tag, agentIds = []) {
  try {
    const form = new FormData();
    form.append("tag", tag);

    await axios.post(
      `https://service-chat.qontak.com/api/open/v1/rooms/${roomId}/tags`,
      form,
      {
        headers: {
          Authorization: bearer(process.env.QONTAK_TOKEN || ""),
          ...form.getHeaders(),
        },
      }
    );
    console.log(`✅ Tag '${tag}' berhasil ditambahkan ke room ${roomId}`);

    for (const userId of agentIds) {
      try {
        await axios.post(
          `https://service-chat.qontak.com/api/open/v1/rooms/${roomId}/agents/${userId}`,
          {},
          {
            headers: {
              Accept: "application/json",
              Authorization: bearer(process.env.QONTAK_TOKEN || ""),
              "Content-Type": "application/json",
            },
          }
        );
        console.log(`✅ Room ${roomId} berhasil di-assign ke agent ${userId}`);
      } catch (err) {
        console.error(`❌ Gagal assign ke agent ${userId}:`, err.response?.data || err.message);
      }
    }
  } catch (err) {
    console.error(`❌ Gagal menambah tag '${tag}':`, err.response?.data || err.message);
  }
}

// ====== WEBHOOK HANDLER ======
app.post("/webhook/qontak", async (req, res) => {
  const { sender_id, text, room, file } = req.body || {};
  const allowedSenders = (process.env.ALLOWED_SENDER_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
//bagian ini hapus jika mau publish
  if (sender_id && allowedSenders.length && !allowedSenders.includes(sender_id))
    return res.sendStatus(200);

  const userMessage = text?.trim();
  const fileUrl = file?.url || null;
  const roomId = room?.id || req.body?.room_id;

  if (!roomId || !sender_id || (!userMessage && !fileUrl)) return res.sendStatus(200);

  const sessionId = roomId;

  // simpan sementara di buffer
  if (!bufferStore[sessionId]) bufferStore[sessionId] = [];
  bufferStore[sessionId].push(
    fileUrl
      ? { type: "file", url: fileUrl, text: userMessage || "" }
      : { type: "text", text: userMessage }
  );

  console.log(`[USER] Sender ID ${sender_id} - Pesan masuk: ${userMessage || "(file)"}`);

  // if (fileUrl)
  //   await sendQontakText(roomId, "📷 Gambar Anda diterima dan sedang dianalisis...");

  // reset timer buffer
  if (bufferTimers[sessionId]) clearTimeout(bufferTimers[sessionId]);
  bufferTimers[sessionId] = setTimeout(async () => {
    const messages = bufferStore[sessionId] || [];
    bufferStore[sessionId] = [];
    bufferTimers[sessionId] = null;

    const combinedText = messages
      .filter((m) => m.type === "text")
      .map((m) => m.text)
      .join(" ")
      .trim();

    const files = messages.filter((m) => m.type === "file");
    console.log(`💬 [BUFFER] Text gabungan (${sessionId}): "${combinedText}"`);
    if (files.length) {
      console.log(`🖼️ [BUFFER] Ada ${files.length} file di buffer:`, files.map((f) => f.url));
    }


    try {
      let visionSummary = "";

      // kirim file ke flowise
      if (files.length) {
        const respVision = await axios.post(
          process.env.CHAT_FLOW_URL,
          {
            question: combinedText || "",
            overrideConfig: { sessionId },
            uploads: files.map((f, i) => ({
              data: f.url,
              type: "url",
              name: `Flowise_${i}${
                f.url?.toLowerCase().endsWith(".png") ? ".png" : ".jpg"
              }`,
              mime: guessMime(f.url),
            })),
          },
          {
            headers: {
              Authorization: bearer(process.env.FLOWISE_API_KEY || ""),
              "Content-Type": "application/json",
            },
          }
        );
        visionSummary = respVision.data?.text?.trim() || "";
        console.log(`[FLOWISE] Room ${roomId} - Ringkasan gambar: ${visionSummary}`);
      }

      const question =
        combinedText + (visionSummary ? `\n[Ringkasan gambar] ${visionSummary}` : "");

      const respAgent = await axios.post(
        process.env.AGENT_FLOW_URL,
        { question, overrideConfig: { sessionId } },
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: bearer(process.env.AGENT_API_KEY || ""),
          },
        }
      );

      const answer = respAgent.data?.text || "";
      console.log(`[AGENT/FLOWISE] Room ${roomId}: ${answer}`);

      if (isAdminHandoffSignal(answer)) {
        await sendQontakText(
          roomId,
          "Silakan sampaikan pertanyaan atau pesan Anda, saya akan bantu teruskan ke admin."
        );
        await addRoomTagAndAssign(roomId, "agent", [
          "da80f6d5-8c0c-4a2a-90f2-48453c88aac0",
          "471b3f67-1733-4ad3-9f2a-4963d757b00e",
        ]);
      } else if (answer) {
        await sendQontakText(roomId, answer);
      }
    } catch (err) {
      console.error("❌ Error Flowise/AgentFlow:", err.response?.data || err.message);

      // === AUTO TAG KE ADMIN SAAT ERROR ===
      await sendQontakText(
        roomId,
        "mohon tunggu sebentar!!"
      );

      await addRoomTagAndAssign(roomId, "agent", [
        "da80f6d5-8c0c-4a2a-90f2-48453c88aac0",
        "471b3f67-1733-4ad3-9f2a-4963d757b00e",
      ]);
    }
  }, BUFFER_TIMEOUT);

  res.sendStatus(200);
});











/**
 * ===============================
 * ROUTE: Sinkronisasi Produk
 * ===============================
 * Endpoint ini digunakan untuk mengambil data produk dari Google Sheets (GAS),
 * memetakan data sesuai format database, dan menyimpan/ memperbarui data
 * tersebut di database PostgreSQL.
 *
 * Cara Kerja:
 * 1. Ambil data dari Google Apps Script (GAS)
 * 2. Map & filter data sesuai header Google Sheet
 * 3. Insert atau update data ke database (upsert)
 */

app.get("/sync-products", async (req, res) => {
  try {
    // ===============================
    // 1️⃣ Ambil data produk dari GAS
    // ===============================
    const response = await fetch(GAS_URL);

    // Jika gagal fetch data dari GAS, tampilkan error
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `GAS fetch failed: ${response.status} ${response.statusText}. Response: ${text.substring(0, 200)}...`
      );
    }

    const products = await response.json();

    // Jika data kosong, langsung kembalikan response sukses tapi total 0
    if (!Array.isArray(products) || products.length === 0) {
      return res.json({
        status: "success",
        total: 0,
        message: "Tidak ada produk di GAS",
      });
    }

    // =========================================
    // 2️⃣ Mapping & Filter data sesuai header
    // =========================================
    // Tujuannya untuk memastikan field sesuai dengan tabel database
    const mappedProducts = products
      .map((p) => ({
        id_produk: p["ID Produk"]?.toString().trim() || null,
        merek: p["Merek"] || null,
        nama_produk: p["Nama Produk"] || null,
        deskripsi_produk: p["Deskripsi Produk"] || null,
        komisi_afiliasi:
          p["Komisi Afiliasi %"] !== undefined && p["Komisi Afiliasi %"] !== ""
            ? Number(p["Komisi Afiliasi %"])
            : null,
        supplier: p["Supplier"] || null,
        coverage_negara: p["Coverage Negara"] || null,
        sku: p["SKU"] || null,
        tautan_tiktok: p["Tautan (TikTok Shop)"] || null,
        tautan_web: p["Tautan Web"] || null,
        tautan_tokopedia: p["Tautan Tokopedia"] || null,
      }))
      .filter((p) => p.id_produk); // skip baris tanpa ID Produk

    // =========================================
    // 3️⃣ Insert atau Update data ke Database
    // =========================================
    // Menggunakan UPSERT (INSERT ... ON CONFLICT) untuk menghindari duplikasi
    for (const prod of mappedProducts) {
      await pool.query(
        `INSERT INTO products (
          id_produk, merek, nama_produk, deskripsi_produk, komisi_afiliasi,
          supplier, coverage_negara, sku, tautan_tiktok, tautan_web, tautan_tokopedia,
          created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
        ON CONFLICT (id_produk) DO UPDATE SET
          merek = EXCLUDED.merek,
          nama_produk = EXCLUDED.nama_produk,
          deskripsi_produk = EXCLUDED.deskripsi_produk,
          komisi_afiliasi = EXCLUDED.komisi_afiliasi,
          supplier = EXCLUDED.supplier,
          coverage_negara = EXCLUDED.coverage_negara,
          sku = EXCLUDED.sku,
          tautan_tiktok = EXCLUDED.tautan_tiktok,
          tautan_web = EXCLUDED.tautan_web,
          tautan_tokopedia = EXCLUDED.tautan_tokopedia,
          updated_at = NOW()`,
        [
          prod.id_produk,
          prod.merek,
          prod.nama_produk,
          prod.deskripsi_produk,
          prod.komisi_afiliasi,
          prod.supplier,
          prod.coverage_negara,
          prod.sku,
          prod.tautan_tiktok,
          prod.tautan_web,
          prod.tautan_tokopedia,
        ]
      );
    }

    // ===============================
    // 4️⃣ Response sukses
    // ===============================
    res.json({
      status: "success",
      total: mappedProducts.length,
      message: `Berhasil menyimpan ${mappedProducts.length} produk ke database 🚀`,
    });
  } catch (err) {
    // ===============================
    // Error Handling
    // ===============================
    console.error("❌ Error sinkronisasi ke DB:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});






/**
 * ===============================
 * ROUTE: Ambil Daftar Produk
 * ===============================
 * Endpoint ini digunakan untuk mengambil data produk dari database.
 * Hanya mengembalikan field tertentu: nama_produk, supplier, deskripsi_produk,
 * coverage_negara, dan tautan_web.
 *
 * Fitur:
 * - Pencarian berdasarkan nama_produk
 * - Mengembalikan list produk sesuai query pencarian (jika ada)
 */
app.get("/products", async (req, res) => {
  try {
    // ===============================
    // 1️⃣ Cek API Key
    // ===============================
    // const apiKey = req.headers["x-api-key"]; // client harus kirim header 'x-api-key'
    // if (!apiKey || apiKey !== process.env.PRODUCTS_API_KEY) {
    //   return res.status(401).json({
    //     status: "error",
    //     message: "Unauthorized. API Key invalid atau tidak diberikan.",
    //   });
    // }

    // ===============================
    // 2️⃣ Ambil query parameter 'search'
    // ===============================
    const search = req.query.search || "";

    // ===============================
    // 3️⃣ Query database (flexible search)
    // ===============================
    const queryText = `
      SELECT 
        nama_produk, 
        supplier, 
        deskripsi_produk, 
        coverage_negara, 
        tautan_web
      FROM products
      WHERE 
        nama_produk ILIKE $1 OR
        deskripsi_produk ILIKE $1 OR
        coverage_negara ILIKE $1
      ORDER BY nama_produk ASC
    `;
    const { rows } = await pool.query(queryText, [`%${search}%`]);

    // ===============================
    // 4️⃣ Response sukses
    // ===============================
    res.json({
      status: "success",
      total: rows.length,
      data: rows,
    });
  } catch (err) {
    // ===============================
    // Error handling
    // ===============================
    console.error("❌ Error mengambil data produk:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});









/* ================================
   POST DATA ICCID & INVOICE
================================ */
app.post("/save_iccid", async (req, res) => {
  try {
    const rows = req.body; // array of objects [{type, order_date, invoice, paket, iccid, code, issue, tgl_issue}, ...]

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ status: "error", message: "No data provided" });
    }

    // helper format tanggal → YYYY-MM-DD
    const formatDate = (value) => {
      if (!value) return null;

      // jika sudah format YYYY-MM-DD, gunakan langsung
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

      // jika format DD.MM.YYYY
      if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(value)) {
        const [day, month, year] = value.split(".");
        return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
      }

      // coba parse date JS
      const d = new Date(value);
      if (!isNaN(d.getTime())) {
        const day = ("0" + d.getDate()).slice(-2);
        const month = ("0" + (d.getMonth() + 1)).slice(-2);
        const year = d.getFullYear();
        return `${year}-${month}-${day}`;
      }

      return null; // fallback jika tidak valid
    };

    const query = `
      INSERT INTO iccid_transactions(type, order_date, invoice, paket, iccid, code, issue, tgl_issue)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(invoice) DO UPDATE
        SET type = EXCLUDED.type,
            paket = EXCLUDED.paket,
            iccid = EXCLUDED.iccid,
            code = EXCLUDED.code,
            issue = EXCLUDED.issue,
            tgl_issue = EXCLUDED.tgl_issue
    `;

    for (const r of rows) {
      await pool.query(query, [
        r.type || "-",
        formatDate(r.order_date),
        r.invoice || "-",
        r.paket || "-",
        r.iccid || "-",
        r.code || "-",
        r.issue ?? false,
        formatDate(r.tgl_issue)
      ]);
    }

    res.json({ status: "success", count: rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: "error", message: err.message });
  }
});




app.get("/transactions_iccid", async (req, res) => {
  try {
    const { invoice, iccid } = req.query;

    let baseQuery = `
      SELECT
        id, type, order_date, invoice, paket,
        iccid, code, issue, tgl_issue, created_at, updated_at
      FROM iccid_transactions
      WHERE 1=1
    `;
    const values = [];
    let idx = 1;

    if (invoice) {
      baseQuery += ` AND invoice ILIKE $${idx++}`;
      values.push(`%${invoice}%`);
    }

    if (iccid) {
      baseQuery += ` AND iccid ILIKE $${idx++}`;
      values.push(`%${iccid}%`);
    }

    baseQuery += ` ORDER BY created_at DESC`;

    const result = await pool.query(baseQuery, values);

    res.json({
      status: "success",
      count: result.rowCount,
      data: result.rows
    });
  } catch (err) {
    console.error("Error fetching transactions_iccid:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});




























/* ================================
   ROUTE DEFAULT
================================ */
app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>API Backend ICCID & Produk</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 800px; margin: 40px auto; line-height: 1.6; }
          h1 { color: #2c3e50; }
          code { background: #f4f4f4; padding: 2px 6px; border-radius: 4px; }
          .endpoint { margin-bottom: 12px; }
          .note { margin-top: 20px; padding: 10px; background: #fffae6; border-left: 4px solid #f39c12; }
        </style>
      </head>
      <body>
        <h1>🚀 API Backend ICCID & Produk</h1>
        <p>Berikut daftar endpoint yang tersedia:</p>

        <div class="endpoint"><code>POST /cek</code> → Cek data usage ICCID via API gkomunika. Body: { nomor }</div>
        <div class="endpoint"><code>POST /webhook/qontak</code> → Webhook Qontak, otomatis balas via Flowise</div>
        <div class="endpoint"><code>GET /products</code> → Ambil produk dari database. Query: supplier, country. <b>Wajib header x-api-key</b></div>
        <div class="endpoint"><code>GET /sync-products</code> → Sinkronisasi produk dari Google Sheet (GAS) ke database</div>
        <div class="endpoint"><code>POST /save_iccid</code> → Insert/update data ICCID & invoice ke database</div>
        <div class="endpoint"><code>POST /transactions_iccid</code> → Data ICCID dan Invoice</div>
        <div class="note">
          🔑 Gunakan API key pada header <code>x-api-key</code> untuk endpoint yang butuh autentikasi.
        </div>
      </body>
    </html>
  `);
});




app.listen(PORT, () => {
  console.log(`✅ Server gabungan jalan di http://localhost:${PORT} 🚀`);
});
