// CODINGAN FINAL

const express = require("express");
const Papa = require("papaparse");
const axios = require("axios");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
require("dotenv").config();

// ===== CONFIG ENV =====
const PORT = process.env.PORT || 3001;
const GAS_URL = process.env.GAS_URL;
const TARGET_ROOM = process.env.TARGET_ROOM;
const FLOWISE_URL = process.env.FLOWISE_URL;
const QONTAK_TOKEN = process.env.QONTAK_TOKEN;
const QONTAK_URL = process.env.QONTAK_URL;
const BOT_ID = process.env.BOT_ID;
const TARGET_SENDER = process.env.TARGET_SENDER;
const TARGET_ACCOUNT = process.env.TARGET_ACCOUNT;

// ===== DATABASE =====
const pool = require("./db/connection");

// ===== EXPRESS APP =====
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// ===== REDIS & QUEUE =====
// const { Queue, Worker } = require("bullmq");
const redis = require("./redisClient");

// const chatQueue = new Queue("chatQueue", { connection: client });

/**
 * @route POST /cek
 * @description Mengecek data penggunaan ICCID via API gkomunika.
 * @param {string} req.body.nomor - Nomor ICCID yang akan dicek.
 * @returns {Object} JSON hasil pengecekan, termasuk bundle, status, usage per negara, dll.
 */
/* ================================
   ROUTE CEK DATA USAGE
================================ */
app.post("/cek", async (req, res) => {
  try {
    const { nomor } = req.body;

    if (!nomor) {
      return res.status(400).json({ error: "nomor tidak boleh kosong" });
    }

    // Hit API gkomunika
    const response = await axios.post(
      "https://gkomunika.id/api/v1/check/data_info",
      new URLSearchParams({ iccid: nomor }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    // Ambil data dari response.data.data (sesuai respons terbaru)
    const data = response.data?.data;
    if (!data) {
      return res.status(404).json({
        error: "Data tidak ditemukan",
        raw: response.data,
      });
    }

    // Helper format KB → MB/GB
    const formatData = (kb) => {
      const mb = kb / 1024;
      if (mb >= 1024) return (mb / 1024).toFixed(2) + " GB";
      return mb.toFixed(2) + " MB";
    };

    // Hitung total usage & per negara (gunakan itemList dari API terbaru)
    let totalUsageKB = 0;
    const usagePerCountry = {};
    const usageDetail = (data.itemList || []).map((u) => {
      const usedKB = parseInt(u.usage, 10) || 0;
      totalUsageKB += usedKB;
      usagePerCountry[u.enus] = (usagePerCountry[u.enus] || 0) + usedKB;

      return {
        date: `${u.usageDate.slice(0, 4)}-${u.usageDate.slice(4, 6)}-${u.usageDate.slice(6, 8)}`,
        country: u.enus,
        usage: formatData(usedKB),
      };
    });

    // Ringkasan
    const hasil = {
      bundle: data.product_name,
      activeDate: new Date(parseInt(data.useSDate, 10)).toISOString().split("T")[0],
      endDate: new Date(parseInt(data.useEDate, 10)).toISOString().split("T")[0],
      status: data.esimStatus === 2 ? "Selesai" : "Aktif",
      totalUsage: formatData(totalUsageKB),
      usageByCountry: Object.entries(usagePerCountry).map(([country, used]) => ({
        country,
        usage: formatData(used),
      })),
      usageDetail,
      variants: JSON.parse(data.attribute_variant || "[]"),
    };

    res.json({ nomor, hasil });
  } catch (err) {
    console.error("=== ERROR ===", err.message);
    res.status(500).json({ error: err.message });
  }
});






/* ================================
   ROUTE WEBHOOK (Qontak)
================================ */

// 🔑 Ambil dari .env
// Simpan state blok per room
// state blok per room

// ===== QUEUE BULLMQ =====
// ====== CONSTANT ======
//codingan siap lauching
const BUFFER_TIMEOUT = 5_000; // 5 detik
const MESSAGE_DEDUP_TTL = 90; // 90 detik untuk dedup
const PROCESSING_LOCK_TTL = 45; // 45 detik untuk lock processing
const RATE_LIMIT_WINDOW = 60; // 1 menit
const MAX_REQUESTS_PER_MINUTE = 5; // Max 5 request per menit per room
const RESPONSE_CACHE_TTL = 120; // Cache response 2 menit untuk cegah loop
const MAX_IMAGE_UPLOADS_PER_ROOM = 2; // Maksimal 2 gambar per room
const IMAGE_COUNTER_TTL = 3600; // Reset counter setiap 1 jam
// const MAX_CONVERSATION_HISTORY = 3; // Batasi history ke 3 pesan terakhir (hemat token)

const bufferTimers = {};
const processingRooms = new Set();
const lastBotResponses = new Map(); // Cache last response per room

const bearer = (t = "") => (/^bearer\s+/i.test(t) ? t : `Bearer ${t}`);

// ========== BOT RESPONSE DETECTOR ==========
function isBotResponse(text, roomId) {
  if (!text) return false;

  // Cek apakah text ini adalah response bot yang baru dikirim
  const lastResponse = lastBotResponses.get(roomId);
  if (lastResponse) {
    const { text: lastText, time } = lastResponse;
    const timeDiff = Date.now() - time;

    // Jika text PERSIS SAMA dan dalam 2 menit terakhir, ini bot echo
    if (text === lastText && timeDiff < RESPONSE_CACHE_TTL * 1000) {
      return true;
    }

    // Cek similarity tinggi (90%+ sama) dan baru saja dikirim (dalam 30 detik)
    if (timeDiff < 30000) {
      const similarity = calculateSimilarity(text, lastText);
      if (similarity > 0.9) {
        return true;
      }
    }
  }

  // HANYA cek pattern yang SANGAT spesifik untuk bot response
  const strictBotPatterns = [
    // Pattern dari screenshot Anda
    /^kami\s+memiliki\s+produk\s+esim/i,
    /anda\s+dapat\s+mengaksesnya\s+di\s+\[tautan\s+ini\]/i,
    /pastikan\s+perangkat\s+anda\s+mendukung\s+esim/i,
    /silakan\s+beri\s+tahu/i,
    /^📷\s*(sedang\s*)?(menganalisis|analisis)\s*gambar/i,
    /^⏳\s*terlalu\s*banyak\s*permintaan/i,
    /^baik,?\s*saya\s*hubungkan\s*dengan\s*admin/i,
    /^mohon\s*maaf,?\s*saya\s*hubungkan\s*dengan\s*tim/i,
    /^terjadi\s*kendala.*kami\s*hubungkan/i,
    /^mohon\s*tunggu\s*sebentar/i,
    // Generic bot patterns
    /^bot:/i,
    /^assistant:/i,
    /\[automated\s+response\]/i,
  ];

  return strictBotPatterns.some(pattern => pattern.test(text.trim()));
}

function calculateSimilarity(str1, str2) {
  const len1 = str1.length;
  const len2 = str2.length;
  const maxLen = Math.max(len1, len2);
  if (maxLen === 0) return 1.0;

  const minLen = Math.min(len1, len2);
  const commonStart = str1.substring(0, minLen) === str2.substring(0, minLen)
    ? minLen
    : 0;

  return commonStart / maxLen;
}

// ========== IMAGE UPLOAD LIMITER ==========
async function checkImageUploadLimit(roomId) {
  const key = `imgcount:${roomId}`;
  const count = await redis.get(key);
  const currentCount = parseInt(count || "0", 10);

  if (currentCount >= MAX_IMAGE_UPLOADS_PER_ROOM) {
    console.log(`🖼️Image limit: room ${roomId.slice(-8)} (${currentCount}/${MAX_IMAGE_UPLOADS_PER_ROOM})`);
    return false;
  }

  return true;
}

async function incrementImageCounter(roomId) {
  const key = `imgcount:${roomId}`;
  const count = await redis.incr(key);

  if (count === 1) {
    await redis.expire(key, IMAGE_COUNTER_TTL);
  }

  console.log(` Image counter: room ${roomId.slice(-8)} = ${count}/${MAX_IMAGE_UPLOADS_PER_ROOM}`);
  return count;
}

// ========== RATE LIMITER ==========
async function checkRateLimit(roomId) {
  const key = `ratelimit:${roomId}`;
  const count = await redis.incr(key);

  if (count === 1) {
    await redis.expire(key, RATE_LIMIT_WINDOW);
  }

  if (count > MAX_REQUESTS_PER_MINUTE) {
    console.log(`🚫 Rate limit: room ${roomId.slice(-8)} (${count}/${MAX_REQUESTS_PER_MINUTE})`);
    return false;
  }

  return true;
}

// ========== FLOWISE RATE LIMITER ==========
async function checkFlowiseRateLimit(roomId) {
  const key = `flowise:${roomId}`;
  const count = await redis.incr(key);

  if (count === 1) {
    await redis.expire(key, RATE_LIMIT_WINDOW);
  }

  // Flowise limit lebih ketat (3 per menit untuk vision/agent)
  if (count > 5) {
    console.log(`🚫 Flowise rate limit: room ${roomId.slice(-8)} (${count}/3)`);
    return false;
  }

  return true;
}

// ========== PROCESSING LOCK ==========
async function acquireProcessingLock(roomId) {
  // In-memory check first (fastest)
  if (processingRooms.has(roomId)) {
    return false;
  }

  // Redis lock with NX (set if not exists)
  const lockKey = `processing:${roomId}`;
  const acquired = await redis.set(lockKey, Date.now().toString(), "EX", PROCESSING_LOCK_TTL, "NX");

  if (!acquired) {
    return false;
  }

  processingRooms.add(roomId);
  return true;
}

async function releaseProcessingLock(roomId) {
  processingRooms.delete(roomId);
  await redis.del(`processing:${roomId}`);
}

// ========== BUFFER REDIS ==========
async function addToBuffer(roomId, message) {
  const key = `buffer:${roomId}`;
  const old = JSON.parse((await redis.get(key)) || "[]");
  old.push(message);

  // Batasi buffer max 5 pesan
  if (old.length > 5) old.shift();

  await redis.set(key, JSON.stringify(old), "EX", 15);
}

async function flushBuffer(roomId) {
  const key = `buffer:${roomId}`;
  const messages = JSON.parse((await redis.get(key)) || "[]");
  await redis.del(key);
  return messages;
}

// ========== ANTI DUPLIKAT (ULTRA KETAT) ==========
async function isDuplicate(roomId, messageId, text, senderId) {
  if (!roomId) return false;

  // Buat primary key yang PASTI unik
  let primaryKey = null;

  // Priority 1: Message ID (paling reliable)
  if (messageId) {
    primaryKey = `dedup:${roomId}:${messageId}`;
  }
  // Priority 2: Sender + text hash (jika tidak ada messageId)
  else if (senderId && text) {
    const hash = require('crypto')
      .createHash('md5')
      .update(`${senderId}:${text}`)
      .digest('hex')
      .slice(0, 12);
    primaryKey = `dedup:${roomId}:${hash}`;
  }
  // Priority 3: Text only hash
  else if (text) {
    const hash = require('crypto')
      .createHash('md5')
      .update(text)
      .digest('hex')
      .slice(0, 12);
    primaryKey = `dedup:${roomId}:txt:${hash}`;
  }

  if (!primaryKey) return false;

  // Single atomic check-and-set dengan Redis
  const result = await redis.set(primaryKey, "1", "EX", MESSAGE_DEDUP_TTL, "NX");

  // Jika result null, berarti key sudah exist = duplikat
  if (!result) {
    return true; // Duplikat, skip tanpa log
  }

  return false;
}

// ========== DETEKSI ADMIN HANDOFF ==========
function isAdminHandoffSignal(ans) {
  if (!ans) return false;
  const s = String(ans).trim().toLowerCase();
  const patterns = [
    /^admin\.?$/,
    /^<admin>$/,
    /^handoff$/,
    /^route_to_admin$/,
    /#\s*handoff\b/,
    /hubungi.*admin/i,
    /butuh.*bantuan.*manusia/i,
  ];
  return patterns.some((rx) => rx.test(s));
}

// ========== MIME DETECTOR ==========
function guessMime(url = "") {
  const u = url.toLowerCase();
  if (u.endsWith(".png")) return "image/png";
  if (u.endsWith(".webp")) return "image/webp";
  if (u.endsWith(".gif")) return "image/gif";
  if (u.endsWith(".jpg") || u.endsWith(".jpeg")) return "image/jpeg";
  return "image/jpeg";
}

// ========== QONTAK HELPERS (FIXED) ==========
async function sendQontakText(roomId, text) {
  if (!text || !roomId) {
    console.error(`⚠️ Invalid params: roomId=${roomId}, text=${text ? 'exists' : 'empty'}`);
    return null;
  }

  // Sanitize text: remove control characters, limit length
  const sanitizedText = text
    .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '') // Remove control chars
    .replace(/\r\n/g, '\n') // Normalize line breaks
    .trim()
    .slice(0, 4000); // Limit 4000 chars

  if (!sanitizedText) {
    console.error(`⚠️ Text empty after sanitization. Original: "${text.slice(0, 100)}"`);
    return null;
  }

  // Cache response untuk deteksi loop
  lastBotResponses.set(roomId, { text: sanitizedText, time: Date.now() });

  // Cleanup old cache (keep only last 10 rooms)
  if (lastBotResponses.size > 10) {
    const firstKey = lastBotResponses.keys().next().value;
    lastBotResponses.delete(firstKey);
  }

  console.log(`📤 Sending to room ${roomId.slice(-8)}: "${sanitizedText.slice(0, 50)}..."`);

  try {
    const payload = {
      room_id: roomId,
      type: "text",
      text: sanitizedText,
    };

    const response = await axios.post(
      process.env.QONTAK_URL,
      payload,
      {
        headers: {
          Authorization: bearer(process.env.QONTAK_TOKEN || ""),
          "Content-Type": "application/json",
        },
        timeout: 10000, // Naikkan timeout jadi 10 detik
      }
    );

    console.log(`✅ Message sent successfully to ${roomId.slice(-8)}`);
    return response;
  } catch (err) {
    const status = err.response?.status;
    const errorData = err.response?.data;

    // FIX: Ganti 'message' jadi 'err.message'
    console.error(`[${new Date().toISOString()}] ❌ Kirim gagal ${roomId.slice(-8)} [${status}]: ${err.message}`);

    if (status === 422) {
      console.error(`🚫 Room ${roomId.slice(-8)} mungkin closed/archived atau text invalid`);
      console.error(`   Error detail:`, errorData);
      return null;
    }

    // Log full error untuk debugging
    if (errorData) {
      console.error(`   Response data:`, JSON.stringify(errorData, null, 2));
    }

    throw err;
  }
}


const CACHE_TTL = 15; // 15 detik biar aman

async function hasRoomTag(roomId, tag) {
  const cacheKey = `room_tag:${roomId}:${tag}`;

  try {
    // Cek cache dulu
    const cached = await redis.get(cacheKey);
    if (cached !== null) {
      return cached === "true";
    }

    // Ambil dari Qontak
    const resp = await axios.get(`${process.env.QONTAK_BASE_URL}/rooms/${roomId}`, {
      headers: {
        Authorization: bearer(process.env.QONTAK_TOKEN || ""),
        "Content-Type": "application/json",
      },
      timeout: 10000,
    });

    const tags = resp.data?.data?.tags || [];
    const hasTag = tags.includes(tag);

    // Simpan ke cache sebentar
    await redis.set(cacheKey, hasTag, "EX", CACHE_TTL);

    return hasTag;
  } catch (err) {
    console.error(`❌ Cek tag gagal: ${err.response?.data || err.message}`);
    return false; // jangan simpan error ke cache
  }
}



async function addRoomTagAndAssign(roomId, tag, agentIds = []) {
  try {
    console.log(`🏷️ Menambahkan tag '${tag}' ke room ${roomId.slice(-8)}...`);

    const form = new FormData();
    form.append("tag", tag);

    const tagResponse = await axios.post(
      `https://service-chat.qontak.com/api/open/v1/rooms/${roomId}/tags`,
      form,
      {
        headers: {
          Authorization: bearer(process.env.QONTAK_TOKEN || ""),
          ...form.getHeaders(),
        },
        timeout: 10000,
      }
    );

    console.log(`✅ Tag '${tag}' berhasil ditambahkan ke room ${roomId.slice(-8)}`);
    console.log(`📋 Response status: ${tagResponse.status}`);

    // Assign agents jika ada
    if (agentIds && agentIds.length > 0) {
      console.log(`👥 Assign ${agentIds.length} agent(s) ke room ${roomId.slice(-8)}...`);

      const assignPromises = agentIds.map((userId) =>
        axios.post(
          `https://service-chat.qontak.com/api/open/v1/rooms/${roomId}/agents/${userId}`,
          {},
          {
            headers: {
              Accept: "application/json",
              Authorization: bearer(process.env.QONTAK_TOKEN || ""),
              "Content-Type": "application/json",
            },
            timeout: 10000,
          }
        ).then(() => {
          console.log(`✅ Agent ${userId.slice(-8)} berhasil di-assign`);
        }).catch((err) => {
          console.error(`❌ Assign agent ${userId.slice(-8)} gagal:`, err.response?.data || err.message);
        })
      );

      await Promise.allSettled(assignPromises);
    } else {
      console.log(`⚠️ Tidak ada agent yang di-assign (agentIds kosong)`);
    }

    return true;
  } catch (err) {
    const status = err.response?.status;
    const errorData = err.response?.data;

    console.error(`❌ Tag '${tag}' GAGAL ditambahkan ke room ${roomId.slice(-8)}:`);
    console.error(`   Status: ${status}`);
    console.error(`   Error:`, errorData || err.message);

    // Log detail jika 422 (validation error)
    if (status === 422) {
      console.error(`   Kemungkinan: tag sudah ada, room closed, atau invalid`);
    }

    return false;
  }
}







// ========== PROCESS MESSAGES (FIXED) ==========

async function processMessages(roomId, agentSenders) {

  // ✅ CEK TAG ADMIN
  if (await hasRoomTag(roomId, "botassign")) {
    console.log(`🤖 Skip: room ${roomId.slice(-8)} sudah ditangani admin (botassign)`);
    await flushBuffer(roomId);
    return;
  }

  // ✅ LOCKING
  if (!(await acquireProcessingLock(roomId))) {
    console.log(`🔒 Room ${roomId.slice(-8)} sedang diproses`);
    return;
  }

  try {
    // ✅ Rate limit
    if (!(await checkRateLimit(roomId))) {
      await sendQontakText(
        roomId,
        "Mohon ditunggu, kami memerlukan pengecekan lebih lanjut. Mohon hubungi kami kembali jika Anda belum mendapat update segera dari kami."
      );
      return;
    }

    const messages = await flushBuffer(roomId);
    if (!messages.length) {
      console.log(`⚠️ No messages in buffer for room ${roomId.slice(-8)}`);
      return;
    }

    const combinedText = messages
      .filter((m) => m.type === "text")
      .map((m) => m.text)
      .join(" ")
      .trim()
      .slice(0, 500);

    const files = messages.filter((m) => m.type === "file");

    console.log(`🔄 Processing ${roomId.slice(-8)}: ${messages.length} msg(s), ${files.length} file(s)`);

    let visionSummary = "";
    let answer = "";

    // =============================
    // 🔍 Jalankan CHAT_FLOW hanya jika ada file
    // =============================
    if (files.length > 0) {
      const currentImageCount = await incrementImageCounter(roomId);
      if (currentImageCount > MAX_IMAGE_UPLOADS_PER_ROOM) {
        console.log(`🖼️ Image limit exceeded: room ${roomId.slice(-8)}`);
        const sent = await sendQontakText(
          roomId,
          "Mohon ditunggu, kami memerlukan pengecekan lebih lanjut. Mohon hubungi kami kembali jika Anda belum mendapat update segera dari kami."
        );
        if (sent) await addRoomTagAndAssign(roomId, "botassign", agentSenders);
        return;
      }

      // Cek limit flowise khusus vision
      if (!(await checkFlowiseRateLimit(roomId))) {
        await sendQontakText(roomId, "⏳ Mohon tunggu sebentar, sistem sedang memproses permintaan sebelumnya...");
        return;
      }

      try {
        await sendQontakText(roomId, "Terimakasih, kami sedang menganalisis gambar Anda...");

        const respVision = await axios.post(
          process.env.CHAT_FLOW_URL,
          {
            question: combinedText || "Jelaskan gambar ini",
            overrideConfig: { sessionId: roomId },
            uploads: files.slice(0, 1).map((f, i) => ({
              data: f.url,
              type: "url",
              name: `img_${i}${f.url?.toLowerCase().endsWith(".png") ? ".png" : ".jpg"}`,
              mime: guessMime(f.url),
            })),
          },
          {
            headers: {
              Authorization: bearer(process.env.FLOWISE_API_KEY || ""),
              "Content-Type": "application/json",
            },
            timeout: 30000,
          }
        );

        visionSummary = respVision.data?.text?.trim() || "";
        console.log(`👁️ Vision response: ${visionSummary.slice(0, 100)}...`);
      } catch (err) {
        const status = err.response?.status;
        console.error(`❌ Vision error [${status}]: ${err.message}`);
        if (err.response?.data) {
          console.error(`   Detail:`, err.response.data);
        }
        visionSummary = "[Gagal analisis gambar]";
      }
    } else {
      console.log(`ℹ️ Tidak ada file — skip vision flow`);
    }

    // =============================
    // 🧠 Jalankan AGENT_FLOW
    // =============================
    if (!(await checkFlowiseRateLimit(roomId))) {
      await sendQontakText(roomId, "⏳ Mohon ditunggu, kami memerlukan pengecekan lebih lanjut. Mohon hubungi kami kembali jika Anda belum mendapat update segera dari kami.");
      return;
    }

    const maxInputLength = 500;
    const truncatedText = combinedText.length > maxInputLength
      ? combinedText.slice(0, maxInputLength) + "..."
      : combinedText;

    const finalQuestion = visionSummary
      ? `${(truncatedText || "").slice(0, 1000)}\n\n[Gambar]: ${visionSummary.slice(0, 300)}`
      : (truncatedText || "").slice(0, 1000) || "(User tidak mengirim teks)";

    console.log(`🧠 Sending to agent: "${finalQuestion.slice(0, 100)}..."`);

    try {
      const respAgent = await axios.post(
        process.env.AGENT_FLOW_URL,
        {
          question: finalQuestion,
          overrideConfig: {
            sessionId: roomId,
          },
        },
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: bearer(process.env.AGENT_API_KEY || ""),
          },
          timeout: 100000,
        }
      );

      answer = respAgent.data?.text || "";
      console.log(`✅ Agent response received: "${answer.slice(0, 40)}..."`);

      // Tambahan debug jika answer kosong
      if (!answer) {
        console.error(`⚠️ Agent response empty! Full response:`, respAgent.data);
      }
    } catch (err) {
      const status = err.response?.status;
      console.error(`❌ Agent error [${status}]: ${err.message}`);
      if (err.response?.data) {
        console.error(`   Detail:`, err.response.data);
      }
      answer = null;
    }

    // =============================
    // 🗣️ Kirim hasil ke user / eskalasi
    // =============================
    if (isAdminHandoffSignal(answer)) {
      console.log(`👤 Admin handoff detected`);
      const sent = await sendQontakText(roomId, "Baik, saya hubungkan dengan admin. Mohon tunggu.");
      if (sent) await addRoomTagAndAssign(roomId, "botassign", agentSenders);

    } else if (answer && answer.trim()) {
      console.log(`📨 Sending answer to user...`);
      const sent = await sendQontakText(roomId, answer);
      if (!sent) {
        console.error(`⚠️ Failed to send answer, escalating to admin`);
        await addRoomTagAndAssign(roomId, "botassign", agentSenders);
      }


    } else {
      console.log(`⚠️ No valid answer, escalating to admin`);
      const sent = await sendQontakText(roomId, "Mohon ditunggu, kami memerlukan pengecekan lebih lanjut.");
      if (sent) await addRoomTagAndAssign(roomId, "botassign", agentSenders);
    }

  } catch (err) {
    console.error(`❌ Fatal error ${roomId.slice(-8)}: ${err.message}`);
    console.error(`   Stack:`, err.stack);
    await sendQontakText(roomId, "Mohon ditunggu, kami memerlukan pengecekan lebih lanjut.");
    await addRoomTagAndAssign(roomId, "botassign", agentSenders);
  } finally {
    await releaseProcessingLock(roomId);
  }
}


async function deleteFlowiseSession(roomId) {
  try {
    // Gunakan endpoint DELETE yang sudah berhasil dicoba di curl
    const url = `http://101.50.2.61:3000/api/v1/chatmessage/d7ebbe54-8ad0-46dc-a93d-c5736d6afb9a?sessionId=${roomId}`;
    const resp = await axios.delete(url, {
      headers: {
        Authorization: "Bearer fYl5_hXOU342c7cfjJP_XpTNmnfzgH9VcWI39YdFEFI"
      },
      timeout: 10000,
    });

    // Cek apakah response berisi JSON valid
    if (resp.data && resp.data.affected) {
      console.log(`🧹 Session deleted for room: ${roomId}`, resp.data);
    } else {
      console.warn(`⚠️ Response unexpected when deleting session ${roomId}`, resp.data);
    }
    return true;
  } catch (err) {
    console.error(
      `❌ Failed to delete session for ${roomId}:`,
      err.response?.data || err.message
    );
    return false;
  }
}



// ========== WEBHOOK HANDLER ==========
app.post("/webhook/qontak", async (req, res) => {
  const { sender_id, text, room, file, message_id } = req.body || {};
  const channelIntegrationId = req.body.channel_integration_id || room?.channel_integration_id;
  const roomId = room?.id || req.body?.room_id;
  const userMessage = text?.trim();

  // Response 200 langsung
  res.sendStatus(200);


  // Validasi basic
  if (!roomId) return;

  if (room?.resolved_at !== null && room?.resolved_at !== undefined) {
    console.log(`🎯 Room ${roomId.slice(-8)} telah di-resolve, menghapus session...`);

    // Hapus session dari Flowise
    try {
      const deleted = await deleteFlowiseSession(roomId);
      if (deleted) {
        console.log(`✅ Session Flowise untuk room ${roomId.slice(-8)} berhasil dihapus`);
      } else {
        console.warn(`⚠️ Gagal menghapus session Flowise untuk room ${roomId.slice(-8)}`);
      }
    } catch (err) {
      console.error(`❌ Error saat menghapus session Flowise: ${err.message}`);
    }

    return; // Stop processing, room sudah resolved
  }

  // ========== DUPLICATE CHECK PALING AWAL (CRITICAL!) ==========
  if (await isDuplicate(roomId, message_id, userMessage, sender_id)) {
    return; // Silent skip
  }

  // ========== AGENT SENDERS (SKIP) ==========
  const agentSenders = [
    "da80f6d5-8c0c-4a2a-90f2-48453c88aac0",
    "471b3f67-1733-4ad3-9f2a-4963d757b00e",
    // "b61f869b-e94b-48b8-a6cc-3027eac8970a"
  ];

  if (agentSenders.includes(sender_id)) return;

  // ========== BOT RESPONSE DETECTION ==========
  if (userMessage && isBotResponse(userMessage, roomId)) {
    return; // Silent skip
  }

  // ========== ALLOWED SENDERS ==========
  const allowedSenders = (process.env.ALLOWED_SENDER_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // if (sender_id && allowedSenders.length && !allowedSenders.includes(sender_id)) return;

  // ========== ALLOWED CHANNELS ==========
  const allowedChannels = ["58d68cb0-fcdc-4d95-a48b-a94d9bb145e8"];
  if (!allowedChannels.includes(channelIntegrationId)) return;

  // ✅ CRITICAL FIX: CEK TAG BOTASSIGN DI WEBHOOK HANDLER
  // Ini mencegah bot memproses room yang sudah di-assign ke admin

  if (await hasRoomTag(roomId, "botassign")) {
    console.log(`🛑 Skip: room ${roomId.slice(-8)} sudah tagged botassign`);
    return;
  }

  // ✅ Jika sampai sini, berarti valid message
  console.log(`📥 ${roomId.slice(-40)}: ${userMessage?.slice(0, 40) || "(file)"}...`);

  // ========== BUFFER MESSAGES ==========
  await addToBuffer(
    roomId,
    file?.url
      ? { type: "file", url: file.url, text: userMessage || "" }
      : { type: "text", text: userMessage }
  );

  // ========== DEBOUNCE TIMER ==========
  if (bufferTimers[roomId]) {
    clearTimeout(bufferTimers[roomId]);
  }

  bufferTimers[roomId] = setTimeout(() => {
    delete bufferTimers[roomId];
    processMessages(roomId, agentSenders).catch((err) => {
      console.error(`❌ Process error: ${err.message}`);
    });
  }, BUFFER_TIMEOUT);
});


/**
 * ===============================
 * ROUTE: Sinkronisasi Produk
 * ===============================
 * Endpoint ini digunakan untuk mengambil data produk dari Google Sheets (GAS),
 * memetakan data sesuai format database, dan menyimpan/ memperbarui data
 * tersebut di database PostgreSQL.
 *
 * Cara Kerja:
 * 1. Ambil data dari Google Apps Script (GAS)
 * 2. Map & filter data sesuai header Google Sheet
 * 3. Insert atau update data ke database (upsert)
 */

app.get("/sync-products", async (req, res) => {
  try {
    // ===============================
    // 1️⃣ Ambil data produk dari GAS
    // ===============================
    const response = await fetch(GAS_URL);

    // Jika gagal fetch data dari GAS, tampilkan error
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `GAS fetch failed: ${response.status} ${response.statusText}. Response: ${text.substring(0, 200)}...`
      );
    }

    const products = await response.json();

    // Jika data kosong, langsung kembalikan response sukses tapi total 0
    if (!Array.isArray(products) || products.length === 0) {
      return res.json({
        status: "success",
        total: 0,
        message: "Tidak ada produk di GAS",
      });
    }

    // =========================================
    // 2️⃣ Mapping & Filter data sesuai header
    // =========================================
    // Tujuannya untuk memastikan field sesuai dengan tabel database
    const mappedProducts = products
      .map((p) => ({
        id_produk: p["ID Produk"]?.toString().trim() || null,
        merek: p["Merek"] || null,
        nama_produk: p["Nama Produk"] || null,
        deskripsi_produk: p["Deskripsi Produk"] || null,
        komisi_afiliasi:
          p["Komisi Afiliasi %"] !== undefined && p["Komisi Afiliasi %"] !== ""
            ? Number(p["Komisi Afiliasi %"])
            : null,
        supplier: p["Supplier"] || null,
        coverage_negara: p["Coverage Negara"] || null,
        sku: p["SKU"] || null,
        tautan_tiktok: p["Tautan (TikTok Shop)"] || null,
        tautan_web: p["Tautan Web"] || null,
        tautan_tokopedia: p["Tautan Tokopedia"] || null,
      }))
      .filter((p) => p.id_produk); // skip baris tanpa ID Produk

    // =========================================
    // 3️⃣ Insert atau Update data ke Database
    // =========================================
    // Menggunakan UPSERT (INSERT ... ON CONFLICT) untuk menghindari duplikasi
    for (const prod of mappedProducts) {
      await pool.query(
        `INSERT INTO products (
          id_produk, merek, nama_produk, deskripsi_produk, komisi_afiliasi,
          supplier, coverage_negara, sku, tautan_tiktok, tautan_web, tautan_tokopedia,
          created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
        ON CONFLICT (id_produk) DO UPDATE SET
          merek = EXCLUDED.merek,
          nama_produk = EXCLUDED.nama_produk,
          deskripsi_produk = EXCLUDED.deskripsi_produk,
          komisi_afiliasi = EXCLUDED.komisi_afiliasi,
          supplier = EXCLUDED.supplier,
          coverage_negara = EXCLUDED.coverage_negara,
          sku = EXCLUDED.sku,
          tautan_tiktok = EXCLUDED.tautan_tiktok,
          tautan_web = EXCLUDED.tautan_web,
          tautan_tokopedia = EXCLUDED.tautan_tokopedia,
          updated_at = NOW()`,
        [
          prod.id_produk,
          prod.merek,
          prod.nama_produk,
          prod.deskripsi_produk,
          prod.komisi_afiliasi,
          prod.supplier,
          prod.coverage_negara,
          prod.sku,
          prod.tautan_tiktok,
          prod.tautan_web,
          prod.tautan_tokopedia,
        ]
      );
    }

    // ===============================
    // 4️⃣ Response sukses
    // ===============================
    res.json({
      status: "success",
      total: mappedProducts.length,
      message: `Berhasil menyimpan ${mappedProducts.length} produk ke database 🚀`,
    });
  } catch (err) {
    // ===============================
    // Error Handling
    // ===============================
    console.error("❌ Error sinkronisasi ke DB:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});






/**
 * ===============================
 * ROUTE: Ambil Daftar Produk
 * ===============================
 * Endpoint ini digunakan untuk mengambil data produk dari database.
 * Hanya mengembalikan field tertentu: nama_produk, supplier, deskripsi_produk,
 * coverage_negara, dan tautan_web.
 *
 * Fitur:
 * - Pencarian berdasarkan nama_produk
 * - Mengembalikan list produk sesuai query pencarian (jika ada)
 */
app.get("/products", async (req, res) => {
  try {
    // ===============================
    // 1️⃣ Ambil query parameter search saja
    // ===============================
    const search = req.query.search || "";

    // ===============================
    // 2️⃣ Siapkan query dinamis
    // ===============================
    let queryText = `
      SELECT 
        id,
        nama_produk,
        supplier,
        deskripsi_produk,
        coverage_negara,
        tautan_web
      FROM products
      WHERE 1=1
    `;

    const queryParams = [];

    // Jika ada search
    if (search) {
      // Split search menjadi beberapa kata untuk fleksibilitas multi-keyword
      const keywords = search.trim().split(/\s+/);
      const searchClauses = keywords.map((_, i) => {
        const idx = queryParams.length + 1;
        queryParams.push(`%${keywords[i]}%`);
        return `
          nama_produk ILIKE $${idx} OR
          deskripsi_produk ILIKE $${idx} OR
          supplier ILIKE $${idx} OR
          coverage_negara ILIKE $${idx}
        `;
      });

      queryText += ` AND (${searchClauses.join(" OR ")})`;
    }

    // Urutkan hasil
    queryText += ` ORDER BY nama_produk ASC`;

    // ===============================
    // 3️⃣ Eksekusi query
    // ===============================
    const { rows } = await pool.query(queryText, queryParams);

    // ===============================
    // 4️⃣ Response sukses
    // ===============================
    res.json({
      status: "success",
      total: rows.length,
      data: rows.map(row => ({
        nama_produk: row.nama_produk,
        supplier: row.supplier,
        deskripsi_produk: row.deskripsi_produk,
        coverage_negara: row.coverage_negara,
        tautan_web: row.tautan_web
      })),
    });

  } catch (err) {
    console.error("❌ Error mengambil data produk:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});










/* ================================
   POST DATA ICCID & INVOICE
================================ */
app.post("/save_iccid", async (req, res) => {
  try {
    const rows = req.body; // array of objects [{type, order_date, invoice, paket, iccid, code, issue, tgl_issue}, ...]

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ status: "error", message: "No data provided" });
    }

    // helper format tanggal → YYYY-MM-DD
    const formatDate = (value) => {
      if (!value) return null;

      // jika sudah format YYYY-MM-DD, gunakan langsung
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

      // jika format DD.MM.YYYY
      if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(value)) {
        const [day, month, year] = value.split(".");
        return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
      }

      // coba parse date JS
      const d = new Date(value);
      if (!isNaN(d.getTime())) {
        const day = ("0" + d.getDate()).slice(-2);
        const month = ("0" + (d.getMonth() + 1)).slice(-2);
        const year = d.getFullYear();
        return `${year}-${month}-${day}`;
      }

      return null; // fallback jika tidak valid
    };

    const query = `
      INSERT INTO iccid_transactions(type, order_date, invoice, paket, iccid, code, issue, tgl_issue)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(invoice) DO UPDATE
        SET type = EXCLUDED.type,
            paket = EXCLUDED.paket,
            iccid = EXCLUDED.iccid,
            code = EXCLUDED.code,
            issue = EXCLUDED.issue,
            tgl_issue = EXCLUDED.tgl_issue
    `;

    for (const r of rows) {
      await pool.query(query, [
        r.type || "-",
        formatDate(r.order_date),
        r.invoice || "-",
        r.paket || "-",
        r.iccid || "-",
        r.code || "-",
        r.issue ?? false,
        formatDate(r.tgl_issue)
      ]);
    }

    res.json({ status: "success", count: rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: "error", message: err.message });
  }
});




app.get("/transactions_iccid", async (req, res) => {
  try {
    const { invoice, iccid } = req.query;

    let baseQuery = `
      SELECT
        id, type, order_date, invoice, paket,
        iccid, code, issue, tgl_issue, created_at, updated_at
      FROM iccid_transactions
      WHERE 1=1
    `;
    const values = [];
    let idx = 1;

    if (invoice) {
      baseQuery += ` AND invoice ILIKE $${idx++}`;
      values.push(`%${invoice}%`);
    }

    if (iccid) {
      baseQuery += ` AND iccid ILIKE $${idx++}`;
      values.push(`%${iccid}%`);
    }

    baseQuery += ` ORDER BY created_at DESC`;

    const result = await pool.query(baseQuery, values);

    res.json({
      status: "success",
      count: result.rowCount,
      data: result.rows
    });
  } catch (err) {
    console.error("Error fetching transactions_iccid:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});




























/* ================================
   ROUTE DEFAULT
================================ */
app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>API Backend ICCID & Produk</title>
        <style>
          body { font-family: Arial, sans-serif; max-width: 800px; margin: 40px auto; line-height: 1.6; }
          h1 { color: #2c3e50; }
          code { background: #f4f4f4; padding: 2px 6px; border-radius: 4px; }
          .endpoint { margin-bottom: 12px; }
          .note { margin-top: 20px; padding: 10px; background: #fffae6; border-left: 4px solid #f39c12; }
        </style>
      </head>
      <body>
        <h1>🚀 API Backend ICCID & Produk</h1>
        <p>Berikut daftar endpoint yang tersedia:</p>

        <div class="endpoint"><code>POST /cek</code> → Cek data usage ICCID via API gkomunika. Body: { nomor }</div>
        <div class="endpoint"><code>POST /webhook/qontak</code> → Webhook Qontak, otomatis balas via Flowise</div>
        <div class="endpoint"><code>GET /products</code> → Ambil produk dari database. Query: supplier, country. <b>Wajib header x-api-key</b></div>
        <div class="endpoint"><code>GET /sync-products</code> → Sinkronisasi produk dari Google Sheet (GAS) ke database</div>
        <div class="endpoint"><code>POST /save_iccid</code> → Insert/update data ICCID & invoice ke database</div>
        <div class="endpoint"><code>POST /transactions_iccid</code> → Data ICCID dan Invoice</div>
        <div class="note">
          🔑 Gunakan API key pada header <code>x-api-key</code> untuk endpoint yang butuh autentikasi.
        </div>
      </body>
    </html>
  `);
});




app.listen(PORT, () => {
  console.log(`✅ Server gabungan jalan di http://localhost:${PORT} 🚀`);
});
