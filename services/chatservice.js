const pool = require("../db/connection");

// Buffer untuk menyimpan chat sementara
let chatBuffer = [];

// Interval flush buffer ke database (misal setiap 30 detik)
setInterval(async () => {
  if (chatBuffer.length === 0) return;

  const bufferCopy = [...chatBuffer]; // copy buffer
  chatBuffer = []; // reset buffer

  try {
    const query = `
      INSERT INTO chat_history (
        room_id, sender_id, name, participant_type, channel_account,
        account_uniq_id, text, resolved_at, created_at
      )
      VALUES ${bufferCopy.map((_, i) => 
        `($${i*8+1},$${i*8+2},$${i*8+3},$${i*8+4},$${i*8+5},$${i*8+6},$${i*8+7},$${i*8+8},NOW())`
      ).join(",")}
    `;

    const params = bufferCopy.flatMap(body => {
      let participantType = "Customer";
      if (body.room?.participants) {
        const p = body.room.participants.find(x => x.id === body.sender_id);
        if (p?.type === "agent") participantType = "Agent";
        else if (p?.type === "internal") participantType = "Staf Internal";
      }

      return [
        body.room?.id || body.room_id,
        body.sender_id,
        body.room?.name || null,
        participantType,
        body.room?.channel_account || null,
        body.room?.account_uniq_id || null,
        body.text || null,
        body.resolved_at || null
      ];
    });

    await pool.query(query, params);
    console.log(`💾 ${bufferCopy.length} chat(s) berhasil disimpan batch`);
  } catch (err) {
    console.error("Batch save error:", err.message);
    // Jika gagal, bisa push balik ke buffer
    chatBuffer.unshift(...bufferCopy);
  }
}, 30000); // 30 detik

// Fungsi untuk menambahkan chat ke buffer
function save_chat(body) {
  chatBuffer.push(body);
}

module.exports = { save_chat };
