// redis.js
const Redis = require("ioredis");

// Buat koneksi Redis
const client = new Redis({
  host: "101.50.2.61",
  port: 6379,
  username: "", // optional, tergantung konfigurasi server Redis kamu
  password: "Abc1234567",
  lazyConnect: false, // langsung connect saat file di-load
  connectTimeout: 10000, // 10 detik timeout koneksi
  retryStrategy: (times) => {
    const delay = Math.min(times * 200, 2000);
    console.log(`🔄 Retry Redis connection in ${delay}ms...`);
    return delay;
  },
  maxRetriesPerRequest: null, // biarkan reconnect tak terbatas
  enableReadyCheck: true, // pastikan server Redis siap sebelum pakai
  tls: process.env.REDIS_USE_TLS === "true" ? {} : undefined, // opsional jika nanti Redis kamu pakai SSL
});

// Event saat koneksi berhasil
client.on("connect", () => console.log("✅ Redis connected successfully!"));

// Event saat Redis siap digunakan
client.on("ready", () => console.log("🚀 Redis is ready for commands!"));

// Event saat koneksi terputus
client.on("close", () => console.warn("⚠️ Redis connection closed!"));

// Event saat terjadi error
client.on("error", (err) => console.error("❌ Redis Error:", err));

// Export client biar bisa dipakai di file lain
module.exports = client;
