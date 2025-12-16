// services/chat-service.js
const pool = require("../db/connection");

class ChatService {
  constructor() {
    this.buffer = [];
    this.BATCH_SIZE = 50; // insert per 50 chat
    this.FLUSH_INTERVAL = 20000; // atau setiap 3 detik
    this.isFlushig = false;

    // Auto flush berkala
    this.startAutoFlush();

    // Graceful shutdown - flush sebelum app mati
    this.setupGracefulShutdown();
  }

  startAutoFlush() {
    setInterval(async () => {
      if (this.buffer.length > 0 && !this.isFlushig) {
        await this.flush();
      }
    }, this.FLUSH_INTERVAL);
  }

  async save_chat(body) {
    try {
      // Validasi data penting
      if (!body.room?.id && !body.room_id) {
        console.warn("⚠️ room_id is missing");
        return { success: false, error: "room_id required" };
      }

      // Tambah ke buffer
      this.buffer.push({
        room_id: body.room?.id || body.room_id,
        sender_id: body.sender_id,
        name: body.room?.name,
        participant_type: body.participant_type,
        channel_account: body.room?.channel_account,
        account_uniq_id: body.room?.account_uniq_id,
        text: body.text,
        resolved_at: body.resolved_at,
        created_at: new Date()
      });

      console.log(`📦 Chat buffered (${this.buffer.length}/${this.BATCH_SIZE})`);

      // Flush jika buffer penuh
      if (this.buffer.length >= this.BATCH_SIZE) {
        await this.flush();
      }

      return { success: true, buffered: this.buffer.length };

    } catch (err) {
      console.error("❌ Save chat error:", err.message);
      return { success: false, error: err.message };
    }
  }

  async flush() {
    if (this.buffer.length === 0 || this.isFlushig) return;

    this.isFlushig = true;

    // Copy buffer & kosongkan
    const toInsert = [...this.buffer];
    this.buffer = [];

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Build batch insert query
      const values = [];
      const params = [];
      let paramIndex = 1;

      toInsert.forEach(chat => {
        values.push(
          `($${paramIndex}, $${paramIndex+1}, $${paramIndex+2}, $${paramIndex+3}, $${paramIndex+4}, $${paramIndex+5}, $${paramIndex+6}, $${paramIndex+7}, $${paramIndex+8})`
        );

        params.push(
          chat.room_id,
          chat.sender_id,
          chat.name,
          chat.participant_type,
          chat.channel_account,
          chat.account_uniq_id,
          chat.text,
          chat.resolved_at,
          chat.created_at
        );

        paramIndex += 9;
      });

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
        ) VALUES ${values.join(', ')}
        ON CONFLICT DO NOTHING
      `;

      const result = await client.query(query, params);
      await client.query('COMMIT');

      console.log(`💾 Flushed ${result.rowCount} chats to DB`);

    } catch (err) {
      await client.query('ROLLBACK');
      console.error("❌ Batch insert failed:", err.message);

      // Kembalikan ke buffer untuk retry
      this.buffer = [...toInsert, ...this.buffer];

    } finally {
      client.release();
      this.isFlushig = false;
    }
  }

  setupGracefulShutdown() {
    const shutdown = async (signal) => {
      console.log(`\n⏳ Received ${signal}, flushing remaining chats...`);

      if (this.buffer.length > 0) {
        console.log(`📤 Flushing ${this.buffer.length} remaining chats...`);
        await this.flush();
      }

      console.log("✅ Graceful shutdown complete");
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  // Method untuk force flush (kalau butuh)
  async forceFlush() {
    await this.flush();
  }

  // Get buffer status
  getStatus() {
    return {
      buffered: this.buffer.length,
      batchSize: this.BATCH_SIZE,
      flushInterval: this.FLUSH_INTERVAL,
      isFlushig: this.isFlushig
    };
  }
}

// Singleton instance
const chatService = new ChatService();

module.exports = {
  save_chat: (body) => chatService.save_chat(body),
  forceFlush: () => chatService.forceFlush(),
  getStatus: () => chatService.getStatus()
};