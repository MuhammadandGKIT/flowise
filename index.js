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
const MAX_CONTEXT_MESSAGES = 10;
const BLOCK_DURATION_MS = 60_000;
const BUFFER_TIMEOUT = 10_000;

const adminRooms = {};
const bufferStore = {};
const bufferTimers = {};

function isBlocked(roomId) {
  return adminRooms[roomId] && adminRooms[roomId].blockedUntil > Date.now();
}

function blockRoom(roomId, durationMs) {
  adminRooms[roomId] = { blockedUntil: Date.now() + durationMs, messageSent: false };
}

// Ambil context terbaru dari Redis
async function buildFullContext(roomKey, summaryKey) {
  const recentRaw = await client.lRange(roomKey, -MAX_CONTEXT_MESSAGES, -1);
  const recentMessages = recentRaw.map(msg => JSON.parse(msg));

  const contextText = recentMessages
    .map(msg => {
      if (msg.role === "user") return `User: ${msg.text}`;
      if (msg.role === "agent") return `Agent: ${msg.text}`;
      if (msg.role === "context") return `Context: ${msg.text}`;
    })
    .join("\n");

  const prevSummary = await client.get(summaryKey) || "";
  return prevSummary ? `${prevSummary}\n${contextText}` : contextText;
}

// Simpan pesan ke Redis
async function pushToRedis(roomKey, role, text) {
  await client.rPush(roomKey, JSON.stringify({ role, text }));
}

app.post("/webhook/qontak", async (req, res) => {
  const { sender_id, text, room, file } = req.body;
  if (sender_id !== process.env.ALLOWED_SENDER_ID) return res.sendStatus(200);

  const userMessage = text?.trim();
  const fileUrl = file?.url || null;
  if (!userMessage && !fileUrl) return res.sendStatus(200);

  console.log(`📥 [${new Date().toISOString()}] ${sender_id} (${room?.id}): ${userMessage || "(file)"}`);

  if (isBlocked(room.id)) {
    if (!adminRooms[room.id].messageSent) {
      await axios.post(process.env.QONTAK_URL, {
        room_id: room.id,
        type: "text",
        text: "Pesan Anda sedang diteruskan ke admin. Mohon tunggu sebentar."
      }, { headers: { Authorization: process.env.QONTAK_TOKEN, "Content-Type": "application/json" } });
      adminRooms[room.id].messageSent = true;
    }
    return res.sendStatus(200);
  }

  const roomKey = `room:${room.id}:messages`;
  const summaryKey = `room:${room.id}:summary`;

  if (!bufferStore[room.id]) bufferStore[room.id] = [];
  bufferStore[room.id].push(fileUrl ? { type: "file", url: fileUrl, text: userMessage } : { type: "text", text: userMessage });

  if (fileUrl) {
    await axios.post(process.env.QONTAK_URL, {
      room_id: room.id,
      type: "text",
      text: "📷 Gambar Anda diterima dan sedang dianalisis..."
    }, { headers: { Authorization: process.env.QONTAK_TOKEN, "Content-Type": "application/json" } });
  }

  if (bufferTimers[room.id]) clearTimeout(bufferTimers[room.id]);

  bufferTimers[room.id] = setTimeout(async () => {
    const messages = bufferStore[room.id];
    bufferStore[room.id] = [];

    const combinedText = messages.filter(m => m.type === "text").map(m => m.text).join(" ");
    const files = messages.filter(m => m.type === "file");

    console.log("➡️ Gabungan bubble ->", combinedText, files.map(f => f.url));

    let answer = "";

    try {
      // 🔹 Analisis gambar dulu jika ada
      if (files.length > 0) {
        const resp = await axios.post(process.env.CHAT_FLOW_URL, {
          question: combinedText || "",
          uploads: files.map((f, i) => ({
            data: f.url,
            type: "url",
            name: `Flowise_${i}.jpeg`,
            mime: "image/jpeg"
          }))
        }, {
          headers: { Authorization: `Bearer ${process.env.FLOWISE_API_KEY}`, "Content-Type": "application/json" }
        });

        const chatFlowAnswer = resp.data?.text || "";
        const userLog = `User mengirim gambar: ${files.map(f => f.url).join(", ")} ${combinedText || ""}`;

        await pushToRedis(roomKey, "user", userLog);
        await pushToRedis(roomKey, "context", chatFlowAnswer);

        console.log("📂 Hasil analisis gambar:", chatFlowAnswer, "\n📂 Disimpan ke Redis sebagai context untuk AgentFlow");
      }

      // 🔹 Ambil context terbaru dari Redis sebelum kirim ke AgentFlow
      const fullContext = await buildFullContext(roomKey, summaryKey);

      // Kirim ke AgentFlow
      const respAgent = await axios.post(process.env.AGENT_FLOW_URL, {
        question: combinedText,
        context: fullContext
      }, {
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.AGENT_API_KEY}` }
      });

      answer = respAgent.data?.text || "";

      await pushToRedis(roomKey, "user", combinedText);
      await pushToRedis(roomKey, "agent", answer);

      // Update summary maksimal 1000 karakter
      const updatedContext = await buildFullContext(roomKey, summaryKey);
      await client.set(summaryKey, updatedContext.length > 1000 ? updatedContext.slice(-1000) : updatedContext);

      if (answer) {
        await axios.post(process.env.QONTAK_URL, {
          room_id: room.id,
          type: "text",
          text: answer
        }, { headers: { Authorization: process.env.QONTAK_TOKEN, "Content-Type": "application/json" } });
      }

    } catch (err) {
      console.error("❌ Error Flowise/AgentFlow:", err.response?.data || err.message);
    }

    // 🔹 Cek keyword admin
    if (answer && answer.toLowerCase().includes("admin")) {
      const adminMessage = "Silakan sampaikan pertanyaan atau pesan Anda, saya akan membantu Anda untuk berkomunikasi dengan admin.";
      await axios.post(process.env.QONTAK_URL, {
        room_id: room.id,
        type: "text",
        text: adminMessage
      }, { headers: { Authorization: process.env.QONTAK_TOKEN, "Content-Type": "application/json" } });

      blockRoom(room.id, BLOCK_DURATION_MS);
    }

    console.log(`📤 [${new Date().toISOString()}] Flowise + AgentFlow raw -> ${answer}`);
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
