// const express = require("express");
// const puppeteer = require("puppeteer");

// const app = express();
// app.use(express.json());

// app.post("/cek", async (req, res) => {
//   const { nomor } = req.body;

//   try {
//     const browser = await puppeteer.launch({
//       headless: false, // lihat proses di browser
//       args: ["--no-sandbox", "--disable-setuid-sandbox"],
//     });

//     const page = await browser.newPage();
//     await page.setViewport({ width: 1280, height: 800 });

//     // buka halaman
//     await page.goto("https://gkomunika.com/id/pages/check-data-usage", {
//       waitUntil: "networkidle2",
//       timeout: 60000,
//     });

//     // isi ICCID
//     await page.type("#iccid", nomor, { delay: 100 });

//     // klik tombol
//     await page.click("#check-iccid");

//     // ganti waitForTimeout → pakai setTimeout manual
//     await new Promise(resolve => setTimeout(resolve, 5000));

//     // tunggu elemen hasil (cek dulu apakah muncul)
//     let hasil = "";
//     try {
//       await page.waitForSelector(".check-data-usage__result", { timeout: 10000 });
//       hasil = await page.$eval(".check-data-usage__result", (el) => el.innerText.trim());
//     } catch (e) {
//       hasil = "⚠️ Hasil tidak ditemukan, mungkin selector berubah atau data tidak tersedia.";
//     }

//     await browser.close();

//     res.json({ nomor, hasil });
//   } catch (err) {
//     res.status(500).json({ error: err.message });
//   }
// });


// // route default biar gak kena "Cannot GET /"
// app.get("/", (req, res) => {
//   res.send("Server Scraper jalan 🚀 gunakan POST /cek dengan body JSON { nomor }");
// });



// app.listen(3000, () => {
//   console.log("✅ Scraper jalan di http://localhost:3000 🚀");
// });
// module.exports = app;