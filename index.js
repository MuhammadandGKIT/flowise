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

// Middleware: parsing body JSON & form-urlencoded dengan limit besar
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));
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
const adminRooms = {}; // { roomId: { blockedUntil: timestamp, messageSent: boolean } }

function isBlocked(roomId) {
  return adminRooms[roomId] && adminRooms[roomId].blockedUntil > Date.now();
}

function blockRoom(roomId, durationMs) {
  adminRooms[roomId] = { blockedUntil: Date.now() + durationMs, messageSent: false };
}

app.post("/webhook/qontak", async (req, res) => {
  const { sender_id, text, room } = req.body;
  if (sender_id !== process.env.ALLOWED_SENDER_ID) return res.sendStatus(200);
  const userMessage = text?.trim();
  if (!userMessage) return res.sendStatus(200);

  console.log(`📥 [${new Date().toISOString()}] ${sender_id} (${room?.id}): ${userMessage}`);

  // cek blok admin
  if (isBlocked(room.id)) {
    if (!adminRooms[room.id].messageSent) {
      // kirim pesan satu kali
      await axios.post(process.env.QONTAK_URL, {
        room_id: room.id,
        type: "text",
        text: "Pesan Anda sedang diteruskan ke admin. Mohon tunggu sebentar."
      }, { headers: { Authorization: process.env.QONTAK_TOKEN, "Content-Type": "application/json" } });

      adminRooms[room.id].messageSent = true; // tandai sudah dikirim
      console.log(`🛑 Middleware admin aktif. Pesan dikirim sekali.`);
    } else {
      console.log(`🛑 Room ${room.id} sedang ditangani admin. Flowise diblok, pesan default sudah dikirim sebelumnya.`);
    }
    return res.sendStatus(200);
  }

  // request ke Flowise
  const answer = await axios.post(process.env.FLOWISE_URL, { question: userMessage })
    .then(r => r.data?.text)
    .catch(err => { console.error("❌ Error Flowise:", err.message); return ""; });

  console.log(`📤 [${new Date().toISOString()}] Flowise raw -> ${answer}`);

  // cek keyword admin
  if (answer.toLowerCase().includes("admin")) {
    const adminMessage = "Silakan sampaikan pertanyaan atau pesan Anda, saya akan membantu Anda untuk berkomunikasi dengan admin.";
    await axios.post(process.env.QONTAK_URL, {
      room_id: room.id,
      type: "text",
      text: adminMessage
    }, { headers: { Authorization: process.env.QONTAK_TOKEN, "Content-Type": "application/json" } });

    console.log(`🛑 Middleware admin aktif. Pesan dikirim: ${adminMessage}`);
    blockRoom(room.id, 60_000); // blok 1 menit
    return res.sendStatus(200);
  }

  // kirim jawaban Flowise normal
  if (answer) {
    await axios.post(process.env.QONTAK_URL, {
      room_id: room.id,
      type: "text",
      text: answer
    }, { headers: { Authorization: process.env.QONTAK_TOKEN, "Content-Type": "application/json" } });
  }

  res.sendStatus(200);
});






//post data product


app.get("/sync-products", async (req, res) => {
  try {
    // 1. Ambil data dari GAS
    const response = await fetch(GAS_URL);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GAS fetch failed: ${response.status} ${response.statusText}. Response: ${text.substring(0, 200)}...`);
    }

    const products = await response.json();

    if (!Array.isArray(products) || products.length === 0) {
      return res.json({ status: "success", total: 0, message: "Tidak ada produk di GAS" });
    }

    // 2. Mapping & filter data sesuai header dari Google Sheet
    const mappedProducts = products
      .map(p => ({
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
      .filter(p => p.id_produk); // skip baris tanpa ID Produk

    // 3. Insert/Update ke DB
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

    res.json({
      status: "success",
      total: mappedProducts.length,
      message: `Berhasil menyimpan ${mappedProducts.length} produk ke database 🚀`,
    });
  } catch (err) {
    console.error("❌ Error sync ke DB:", err);
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
        <div class="endpoint"><code>POST /iccid</code> → Insert/update data ICCID & invoice ke database</div>
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
