// product/sync-product.js
const express = require("express");
const router = express.Router();
const fetch = require("node-fetch"); // Jika kamu pakai node-fetch
const pool = require("../db/connection");

const GAS_URL = process.env.GAS_URL;
router.get("/sync-products", async (req, res) => {
  try {
    // ===============================
    // 1️⃣ Ambil data produk dari GAS
    // ===============================
    const response = await fetch(GAS_URL);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `GAS fetch failed: ${response.status} ${response.statusText}. Response: ${text.substring(0, 200)}...`
      );
    }

    const products = await response.json();

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
      .filter((p) => p.id_produk);

    // =========================================
    // 3️⃣ Insert atau Update data ke Database
    // =========================================
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
    console.error("❌ Error sinkronisasi ke DB:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

module.exports = router;
