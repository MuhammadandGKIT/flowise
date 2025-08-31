const express = require("express");
const router = express.Router();

router.post("/webhook/qontak", (req, res) => {
  const body = req.body || {};

  // tampilkan semua data yang diterima
  console.log("🔥 Received Webhook:", body);

  // balikin respons 200 OK + semua body
  res.status(200).json({
    status: "ok",
    received: body,
  });
});

module.exports = router;
