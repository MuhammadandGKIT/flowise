const pool = require("./db/connection");

(async () => {
  try {
    const client = await pool.connect();
    console.log("✅ Connected to PostgreSQL");

    // Tes query sederhana
    const res = await client.query("SELECT NOW()");
    console.log("🕒 Current time:", res.rows[0]);

    client.release();
    process.exit(0);S
  } catch (err) {
    console.error("❌ Database connection error:", err.stack);
    process.exit(1);
  }
})();
