const express = require("express");
const cekDataApp = require("./cek_data.js");
const qontakWebhookApp = require("./qontak_webhook.js");

const app = express();

// middleware untuk parsing JSON
app.use(express.json());

// mount apps di path berbeda
app.use("/cek-data", cekDataApp);
app.use("/", qontakWebhookApp); // mount langsung di root

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`✅ Server gabungan jalan di http://localhost:${PORT} 🚀`);
});
