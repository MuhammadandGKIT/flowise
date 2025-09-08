/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function(knex) {
    return knex.schema.createTable("iccid_transactions", table => {
      table.increments("id").primary();        // Primary key
      table.string("type").notNullable();      // eSIM / SIM / T-Mobile
      table.date("order_date").notNullable();  // Tanggal pemesanan
      table.string("invoice").notNullable().unique(); // Nomor invoice unik
      table.text("paket").notNullable();       // Deskripsi paket
      table.string("iccid").defaultTo("-");    // ICCID, default "-"
      table.string("code").defaultTo("-");     // Kode aktivasi, default "-"
      table.boolean("issue").defaultTo(false); // Status issue
      table.date("tgl_issue");                  // Tanggal diterbitkan
      table.timestamps(true, true);            // created_at & updated_at
    });
  };
  
  /**
   * @param { import("knex").Knex } knex
   * @returns { Promise<void> }
   */
  exports.down = function(knex) {
    return knex.schema.dropTableIfExists("iccid_transactions");
  };
  