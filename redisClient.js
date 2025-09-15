// redisClient.js
const redis = require("redis");

const client = redis.createClient({
  url: "redis://:Abc1234567@101.50.2.61:6379"
});

client.on("error", (err) => console.error("Redis Client Error", err));

(async () => {
  await client.connect();
  console.log("✅ Redis connected!");
})();

module.exports = client;
