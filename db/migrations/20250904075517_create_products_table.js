/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function(knex) {
    return knex.schema.createTable("products", function(table) {
      table.increments("id").primary();              // PK auto increment
      table.string("id_produk").nullable().unique(); // ID Produk tetap varchar (biasanya pendek)
      table.text("merek").nullable();                // bisa panjang
      table.text("nama_produk").nullable();          // bisa panjang
      table.text("deskripsi_produk").nullable();     // text sudah panjang
      table.decimal("komisi_afiliasi", 5, 2).nullable();
      table.text("supplier").nullable();             // bisa panjang
      table.text("coverage_negara").nullable();      // bisa panjang
      table.text("sku").nullable();                  // bisa panjang
      table.text("tautan_tiktok").nullable();
      table.text("tautan_web").nullable();
      table.text("tautan_tokopedia").nullable();
      table.timestamps(true, true);
    });
  };
  
  /**
   * @param { import("knex").Knex } knex
   * @returns { Promise<void> }
   */
  exports.down = function(knex) {
    return knex.schema.dropTableIfExists("products");
  };
  