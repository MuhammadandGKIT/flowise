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
const QONTAK_URL = process.env.QONTAK_URL;
const QONTAK_TOKEN = process.env.QONTAK_TOKEN;
const BOT_ID = process.env.BOT_ID;
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
app.post("/webhook/qontak", async (req, res) => {
  const body = req.body || {};
  const { webhook_event, data_event, room_id, sender_id, is_agent, text } = body;

  // 🚫 Hanya proses pesan customer
  if (
    webhook_event !== "message_interaction" ||
    data_event !== "receive_message_from_customer"
  ) {
    console.log("🚫 Event bukan dari customer, diabaikan:", webhook_event, data_event);
    return res.sendStatus(200);
  }

  // 🚫 Abaikan kalau bukan dari target room
  if (room_id !== TARGET_ROOM) {
    console.log("🚫 Pesan diabaikan dari room:", room_id);
    return res.sendStatus(200);
  }

  // 🚫 Abaikan kalau pengirim adalah bot/agent
  if (sender_id === BOT_ID || is_agent === true) {
    console.log("🤖 Pesan dari bot/agent, diabaikan.");
    return res.sendStatus(200);
  }

  // Pastikan ada teks
  const userMessage = text?.trim();
  if (!userMessage) {
    console.log("⚠️ Tidak ada teks, diabaikan.");
    return res.sendStatus(200);
  }

  console.log("🎯 Pesan user dari TARGET_ROOM:", userMessage);

  try {
    // 🔹 Kirim ke Flowise
    const flowiseRes = await axios.post(FLOWISE_URL, {
      question: userMessage,
    });

    const answer = flowiseRes.data.text || "Maaf, saya belum bisa menjawab. pesan kamu nanti akan dijawab oleh cs kami";

    // 🔹 Kirim jawaban balik ke Qontak
    await axios.post(
      QONTAK_URL,
      {
        room_id: TARGET_ROOM,
        type: "text",
        text: answer,
      },
      {
        headers: {
          Authorization: QONTAK_TOKEN,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("📩 Jawaban terkirim ke TARGET_ROOM:", answer);
  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);
  }

  res.sendStatus(200);
});



/* ================================
   ROUTE AMBIL DATA GOOGLE SHEET
================================ */
// middleware body parser dengan limit besar

// ambil semua produk dari database
app.get("/products", async (req, res) => {
  try {
    // Ambil data tapi exclude kolom tokopedia & tiktok
    const result = await pool.query(`
      SELECT 
        id, id_produk, merek, nama_produk, deskripsi_produk,
        komisi_afiliasi, supplier, coverage_negara, sku,
        tautan_web, created_at, updated_at
      FROM products
      ORDER BY updated_at DESC
    `);

    res.json({
      status: "success",
      total: result.rowCount,
      products: result.rows
    });
  } catch (err) {
    console.error("❌ Error ambil data dari DB:", err.message);
    res.status(500).json({ status: "error", message: err.message });
  }
});




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
   ROUTE DEFAULT
================================ */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});


app.listen(PORT, () => {
  console.log(`✅ Server gabungan jalan di http://localhost:${PORT} 🚀`);
});
