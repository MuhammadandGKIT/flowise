// cek_usage.js
const express = require("express");
const axios = require("axios");

const router = express.Router();

router.post("/cek", async (req, res) => {
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

    const data = response.data?.data;
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
    const usageDetail = (data.itemList || []).map((u) => {
      const usedKB = parseInt(u.usage, 10) || 0;
      totalUsageKB += usedKB;
      usagePerCountry[u.enus] = (usagePerCountry[u.enus] || 0) + usedKB;

      return {
        date: `${u.usageDate.slice(0, 4)}-${u.usageDate.slice(4, 6)}-${u.usageDate.slice(6, 8)}`,
        country: u.enus,
        usage: formatData(usedKB),
      };
    });

    const hasil = {
      bundle: data.product_name,
      activeDate: new Date(parseInt(data.useSDate, 10)).toISOString().split("T")[0],
      endDate: new Date(parseInt(data.useEDate, 10)).toISOString().split("T")[0],
      status: data.esimStatus === 2 ? "Selesai" : "Aktif",
      totalUsage: formatData(totalUsageKB),
      usageByCountry: Object.entries(usagePerCountry).map(([country, used]) => ({
        country,
        usage: formatData(used),
      })),
      usageDetail,
      variants: JSON.parse(data.attribute_variant || "[]"),
    };

    res.json({ nomor, hasil });
  } catch (err) {
    console.error("=== ERROR ===", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
