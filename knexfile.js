module.exports = {
    development: {
      client: "pg",
      connection: {
        host: "101.50.2.61",
        port: 5433,
        user: "postgres",
        password: "Globalkomunika12",
        database: "Chatbot",
      },
      migrations: {
        directory: "./db/migrations"
      }
    }
  };
  