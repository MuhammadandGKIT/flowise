/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function(knex) {
  return knex.schema.createTable("chat_history", function(table) {
    table.increments("id").primary();       // PK auto increment

    table.string("room_id").nullable();
    table.string("sender_id").nullable();
    table.string("name").nullable();
   table.string("participant_type").nullable();
    table.string("channel_account").nullable();
    table.string("account_uniq_id").nullable();

    table.text("text").nullable();          // isi pesan panjang
    table.timestamp("resolved_at").nullable();

    table.timestamps(true, true);           // created_at & updated_at
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function(knex) {
  return knex.schema.dropTableIfExists("chat_history");
};
