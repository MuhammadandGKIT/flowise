const pool = require("./db/connection");

async function testConnection() {
  try {
    const client = await pool.connect();
    console.log("✅ Koneksi berhasil ke PostgreSQL!");
    const res = await client.query("SELECT NOW()");
    console.log("Waktu server DB:", res.rows[0].now);
    client.release();
  } catch (err) {
    console.error("❌ Gagal koneksi ke PostgreSQL:", err.message);
  } finally {
    pool.end();
  }
}

testConnection();
