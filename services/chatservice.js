const pool = require("../db/connection");

// Buffer chat
let chatBuffer = [];

// Flush ke DB tiap 30 detik
setInterval(async () => {
  if (chatBuffer.length === 0) return;

  const bufferCopy = [...chatBuffer];
  chatBuffer = [];

  try {
    const query = `
      INSERT INTO chat_history (
        room_id,
        sender_id,
        name,
        participant_type,
        channel_account,
        account_uniq_id,
        text,
        resolved_at,
        created_at
      )
      VALUES ${bufferCopy.map((_, i) =>
        `($${i * 8 + 1}, $${i * 8 + 2}, $${i * 8 + 3}, $${i * 8 + 4},
          $${i * 8 + 5}, $${i * 8 + 6}, $${i * 8 + 7}, $${i * 8 + 8}, NOW())`
      ).join(",")}
    `;

    const params = bufferCopy.flatMap(body => [
      body.room?.id || body.room_id,
      body.sender_id,
      body.room?.name,
      body.participant_type,        // ✅ ISI APA ADANYA
      body.room?.channel_account,
      body.room?.account_uniq_id,
      body.text,
      body.resolved_at
    ]);

    await pool.query(query, params);
    console.log(`💾 ${bufferCopy.length} chat disimpan (apa adanya)`);
  } catch (err) {
    console.error("❌ Batch save error:", err.message);
    chatBuffer.unshift(...bufferCopy);
  }
}, 30000);

// Masukin ke buffer TANPA LOGIC
function save_chat(body) {
  chatBuffer.push(body);
}

module.exports = { save_chat };
