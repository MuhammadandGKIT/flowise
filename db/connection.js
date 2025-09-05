// db/connection.js
const { Pool } = require("pg");

const pool = new Pool({
  user: "postgres",              // user default PostgreSQL
  host: "101.50.2.61",           // IP VPS kamu
  database: "postgres",          // database default yang kamu buat
  password: "Rivian1207",        // password PostgreSQL
  port: 5433,                    // pakai port mapping Docker
});

module.exports = pool;
