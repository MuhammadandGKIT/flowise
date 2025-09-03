const express = require("express");
// const puppeteer = require("puppeteer");
const Papa = require("papaparse");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ================================
   ROUTE CEK DATA (Scraping)
================================ */

app.post("/cek", async (req, res) => {
  try {
    const { nomor } = req.body;  // pastikan body punya "nomor"

    if (!nomor) {
      return res.status(400).json({ error: "nomor tidak boleh kosong" });
    }

    // contoh hit ke API gkomunika langsung
    const response = await axios.post(
      "https://gkomunika.id/api/v1/check/data_info",
      new URLSearchParams({ iccid: nomor }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    res.json({ nomor, hasil: response.data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


/* ================================
   ROUTE WEBHOOK (Qontak)
================================ */



app.use(express.json());

const TARGET_ROOM = process.env.TARGET_ROOM;
const FLOWISE_URL = process.env.FLOWISE_URL;
const QONTAK_URL = process.env.QONTAK_URL;
const QONTAK_TOKEN = process.env.QONTAK_TOKEN;

// const BOT_ID = "BOT_ID_KAMU";
const BOT_ID = process.env.BOT_ID;
const PORT = process.env.PORT || 3000;

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
   ROUTE CEK DATA GOOGLE SHEET
================================ */

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post("/from-gas", (req, res) => {
  let body = req.body;

  // kalau products dikirim sebagai string → parse ke object
  if (typeof body.products === "string") {
    try {
      body.products = JSON.parse(body.products);
    } catch (e) {
      console.error("⚠️ Gagal parse products:", e);
    }
  }

  console.log("📩 Update dari Google Sheets:");
  console.log(body);

  res.json({ status: "OK", received: body });
});




const GAS_URL = process.env.GAS_URL;
// endpoint baru di Node.js
app.get("/products", async (req, res) => {
  try {
    const response = await fetch(GAS_URL);
    const data = await response.json();

    res.json({
      status: "success",
      source: "Google Sheets",
      products: data.products || [],
    });
  } catch (err) {
    console.error("❌ Error ambil data dari GAS:", err.message);
    res.status(500).json({ status: "error", message: err.message });
  }
});




/* ================================
   ROUTE DEFAULT
================================ */
app.get("/", (req, res) => {
  res.send(`
    ✅ Server jalan 🚀<br/>
    - Gunakan <b>POST /cek</b> dengan body JSON { "nomor": "..." }<br/>
    - Gunakan <b>POST /webhook/qontak</b> untuk terima webhook
  `);
});


app.listen(PORT, () => {
  console.log(`✅ Server gabungan jalan di http://localhost:${PORT} 🚀`);
});
