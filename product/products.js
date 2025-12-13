const express = require("express");
const router = express.Router();
const { pool } = require("../db/connection"); // sesuaikan path db.js kamu

router.get("/", async (req, res) => {
  try {
    const search = req.query.search || "";

    let queryText = `
      SELECT 
        id,
        nama_produk,
        supplier,
        deskripsi_produk,
        coverage_negara,
        tautan_web
      FROM products
      WHERE 1=1
    `;

    const queryParams = [];

    if (search) {
      const keywords = search.trim().split(/\s+/);
      const searchClauses = keywords.map((_, i) => {
        const idx = queryParams.length + 1;
        queryParams.push(`%${keywords[i]}%`);
        return `
          nama_produk ILIKE $${idx} OR
          deskripsi_produk ILIKE $${idx} OR
          supplier ILIKE $${idx} OR
          coverage_negara ILIKE $${idx}
        `;
      });

      queryText += ` AND (${searchClauses.join(" OR ")})`;
    }

    queryText += ` ORDER BY nama_produk ASC`;

    const { rows } = await pool.query(queryText, queryParams);

    res.json({
      status: "success",
      total: rows.length,
      data: rows.map(row => ({
        nama_produk: row.nama_produk,
        supplier: row.supplier,
        deskripsi_produk: row.deskripsi_produk,
        coverage_negara: row.coverage_negara,
        tautan_web: row.tautan_web
      })),
    });

  } catch (err) {
    console.error("❌ Error mengambil data produk:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

module.exports = router;
