const express = require("express");
const axios = require("axios");
const fs = require("fs");
const app = express();

app.use(express.json());

// Konfigurasi token & URL
const FLOWISE_URL = "http://cloud.flowiseai.com/api/v1/prediction/cca885c8-fbea-49e3-94ce-6f8f14137fb8";
const QONTAK_TOKEN = "JCXvkjGiACxo4DGiHg8zMpBc3-WPP_eCVSVl9DtTl4Q";
const QONTAK_URL = "http://service-chat.qontak.com/api/open/v1/messages/whatsapp";
const LOG_FILE = "./webhook_debug.log";

// Endpoint Webhook
app.post("/webhook", async (req, res) => {
  const { webhook_event, data_event } = req.body;

  // Normalisasi data
  const normalized = {
    message: {
      id: req.body.id,
      text: req.body.text,
      sender_id: req.body.sender_id,
      created_at: req.body.created_at,
    },
    room: {
      id: req.body?.room?.id,
      account_uniq_id: req.body?.room?.account_uniq_id,
      organization_id: req.body?.room?.organization_id,
      is_unresponded: req.body?.room?.is_unresponded,
    },
    sender: {
      name: req.body?.sender?.name,
      participant_type: req.body?.sender?.participant_type,
    },
    meta: {
      channel: req.body?.room?.channel,
      data_event,
    },
  };

  // Log ke file
  fs.appendFileSync(
    LOG_FILE,
    `[${new Date().toISOString()}] Normalized Data: ${JSON.stringify(normalized, null, 2)}\n`
  );

  // Kalau ada pesan baru dari customer
  if (webhook_event === "message_interaction" && data_event === "receive_message_from_customer") {
    try {
      // 1️⃣ Kirim pertanyaan ke Flowise
      const flowiseResponse = await axios.post(
        FLOWISE_URL,
        { question: normalized.message.text },
        { headers: { "Content-Type": "application/json" } }
      );

      const flowiseData = flowiseResponse.data;
      fs.appendFileSync(
        LOG_FILE,
        `[${new Date().toISOString()}] Flowise Response: ${JSON.stringify(flowiseData, null, 2)}\n`
      );

      const answer = flowiseData.text || "Maaf, saya tidak bisa memproses permintaan kamu sekarang 🙏";

      // 2️⃣ Kirim balik ke Qontak
      const qontakResponse = await axios.post(
        QONTAK_URL,
        {
          room_id: normalized.room.id, // ambil dari data webhook
          type: "text",
          text: answer,
        },
        {
          headers: {
            Authorization: `Bearer ${QONTAK_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      );

      fs.appendFileSync(
        LOG_FILE,
        `[${new Date().toISOString()}] Qontak Response: ${JSON.stringify(qontakResponse.data, null, 2)}\n`
      );

      return res.status(200).json({
        status: "ok",
        received: normalized,
        flowise: flowiseData,
        reply: answer,
      });
    } catch (error) {
      fs.appendFileSync(
        LOG_FILE,
        `[${new Date().toISOString()}] ERROR: ${error.message}\n`
      );

      return res.status(500).json({
        status: "error",
        message: error.message,
      });
    }
  }

  // Default respon kalau bukan pesan customer
  return res.status(200).json({
    status: "ok",
    data: normalized,
  });
});

// Jalankan server
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
