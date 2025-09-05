module.exports = {
    development: {
      client: "pg",
      connection: {
        host: "101.50.2.61",
        port: 5433,
        user: "postgres",
        password: "Rivian1207",
        database: "postgres",
      },
      migrations: {
        directory: "./db/migrations"
      }
    }
  };
  