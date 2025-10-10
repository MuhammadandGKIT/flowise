const MAX_CONTEXT_MESSAGES = 10;
const BUFFER_TIMEOUT = 0;

const bufferStore = {};
const bufferTimers = {};

// ====== HELPERS ======
const bearer = (t = "") => (/^bearer\s+/i.test(t) ? t : `Bearer ${t}`);

function isAdminHandoffSignal(ans) {
  if (!ans) return false;
  const s = String(ans).trim().toLowerCase();
  const patterns = [
    /^admin\.?$/,
    /^<admin>$/,
    /^handoff$/,
    /^route_to_admin$/,
    /#\s*handoff\b/,
  ];
  return patterns.some((rx) => rx.test(s));
}

function guessMime(url = "") {
  const u = url.toLowerCase();
  if (u.endsWith(".png")) return "image/png";
  if (u.endsWith(".webp")) return "image/webp";
  if (u.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

function buildMergedLastMessage({ combinedText, visionSummary, files }) {
  const parts = [];
  if (combinedText) parts.push(combinedText);
  if (visionSummary) parts.push(`[Ringkasan gambar] ${visionSummary}`);
  if (files?.length) parts.push(`Files: ${files.map((f) => f.url).join(", ")}`);
  return parts.join("\n\n").trim();
}

async function sendQontakText(roomId, text) {
  return axios.post(
    process.env.QONTAK_URL,
    { room_id: roomId, type: "text", text },
    {
      headers: {
        Authorization: bearer(process.env.QONTAK_TOKEN || ""),
        "Content-Type": "application/json",
      },
    }
  );
}

// ====== QONTAK TAG + ASSIGN HELPERS ======
async function hasRoomTag(roomId, tag) {
  try {
    const resp = await axios.get(
      `${process.env.QONTAK_BASE_URL}/rooms/${roomId}`,
      {
        headers: {
          Authorization: bearer(process.env.QONTAK_TOKEN || ""),
          "Content-Type": "application/json",
        },
      }
    );
    const tags = resp.data?.data?.tags || [];
    return tags.includes(tag);
  } catch (err) {
    console.error("❌ Gagal cek tags room:", err.response?.data || err.message);
    return false;
  }
}

async function addRoomTagAndAssign(roomId, tag, agentIds = []) {
  try {
    // Tambah tag
    const form = new FormData();
    form.append("tag", tag);

    await axios.post(
      `https://service-chat.qontak.com/api/open/v1/rooms/${roomId}/tags`,
      form,
      {
        headers: {
          Authorization: `Bearer ${process.env.QONTAK_TOKEN}`,
          ...form.getHeaders(),
        },
      }
    );
    console.log(`✅ Tag '${tag}' berhasil ditambahkan ke room ${roomId}`);

    // Assign ke agent
    for (const userId of agentIds) {
      try {
        await axios.post(
          `https://service-chat.qontak.com/api/open/v1/rooms/${roomId}/agents/${userId}`,
          {},
          {
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${process.env.QONTAK_TOKEN}`,
              "Content-Type": "application/json",
            },
          }
        );
        console.log(`✅ Room ${roomId} berhasil di-assign ke agent ${userId}`);
      } catch (err) {
        console.error(
          `❌ Gagal assign room ${roomId} ke agent ${userId}:`,
          err.response?.data || err.message
        );
      }
    }
  } catch (err) {
    console.error(
      `❌ Gagal menambah tag '${tag}' untuk room ${roomId}:`,
      err.response?.data || err.message
    );
  }
}

// ====== REDIS HELPERS ======
async function pushToRedis(roomKey, role, text) {
  await client.rPush(roomKey, JSON.stringify({ role, text }));
}

async function buildFullContext(roomKey, summaryKey) {
  const recentRaw = await client.lRange(roomKey, -MAX_CONTEXT_MESSAGES, -1);
  const recentMessages = recentRaw
    .map((s) => { try { return JSON.parse(s); } catch { return null; } })
    .filter(Boolean);

  const contextText = recentMessages
    .map((msg) => {
      if (msg.role === "user") return `User: ${msg.text}`;
      if (msg.role === "agent") return `Agent: ${msg.text}`;
      if (msg.role === "context") return `Context: ${msg.text}`;
      return null;
    })
    .filter(Boolean)
    .join("\n");

  const prevSummary = (await client.get(summaryKey)) || "";
  return prevSummary
    ? `Ringkasan: ${prevSummary}\nPercakapan terbaru:\n${contextText}`
    : contextText;
}

async function updateSummary(roomKey, summaryKey) {
  const recentRaw = await client.lRange(roomKey, -30, -1);
  if (!recentRaw?.length) return;

  const lines = [];
  for (const s of recentRaw) {
    try {
      const m = JSON.parse(s);
      if (!m?.text) continue;
      const t = String(m.text).replace(/\s+/g, " ").trim();
      if (!t) continue;
      if (m.role === "user") lines.push(`U: ${t}`);
      else if (m.role === "agent") lines.push(`A: ${t}`);
      else if (m.role === "context") lines.push(`C: ${t}`);
    } catch {}
  }
  if (!lines.length) return;

  let summary = lines.join("\n");
  const MAX_SUMMARY_LEN = 1500;
  if (summary.length > MAX_SUMMARY_LEN) {
    summary = summary.slice(0, MAX_SUMMARY_LEN) + " …";
  }

  await client.set(summaryKey, summary);
  console.log(
    "📝 Local summary diperbarui (Redis):",
    summary.slice(0, 120),
    summary.length > 120 ? "…" : ""
  );
}

// ====== WEBHOOK ======
app.post("/webhook/qontak", async (req, res) => {
  const { sender_id, text, room, file } = req.body || {};
  if (
    sender_id &&
    process.env.ALLOWED_SENDER_ID &&
    sender_id !== process.env.ALLOWED_SENDER_ID
  ) return res.sendStatus(200);

  const userMessage = text?.trim();
  const fileUrl = file?.url || null;
  const roomId = room?.id || req.body?.room_id;
  const roomName = room?.name || "";

  if (!roomId || !sender_id) return res.sendStatus(200);
  if (!userMessage && !fileUrl) return res.sendStatus(200);

  // Skip jika sudah ada tag "agent"
  if (await hasRoomTag(roomId, "agent")) {
    console.log("🚫 Chat tidak diteruskan (ada tag 'agent')");
    return res.sendStatus(200);
  }

  console.log(
    `📥 [${new Date().toISOString()}] ${sender_id} (room=${roomId}${
      roomName ? " / " + roomName : ""
    }): ${userMessage || "(file)"}`
  );

  const roomKey = `sender:${sender_id}:messages`;
  const summaryKey = `sender:${sender_id}:summary`;

  if (!bufferStore[roomId]) bufferStore[roomId] = [];
  bufferStore[roomId].push(
    fileUrl ? { type: "file", url: fileUrl, text: userMessage || "" } : { type: "text", text: userMessage }
  );

  if (fileUrl) {
    sendQontakText(roomId, "📷 Gambar Anda diterima dan sedang dianalisis...").catch(() => {});
  }

  if (bufferTimers[roomId]) clearTimeout(bufferTimers[roomId]);

  bufferTimers[roomId] = setTimeout(async () => {
    const messages = bufferStore[roomId] || [];
    bufferStore[roomId] = [];
    bufferTimers[roomId] = null;

    const combinedText = messages.filter(m => m.type === "text").map(m => m.text).join(" ").trim();
    const files = messages.filter(m => m.type === "file");

    let visionSummary = "";
    let answer = "";

    try {
      if (files.length > 0) {
        const respVision = await axios.post(process.env.CHAT_FLOW_URL, {
          question: combinedText || "",
          uploads: files.map((f, i) => ({
            data: f.url,
            type: "url",
            name: `Flowise_${i}${f.url?.toLowerCase().endsWith(".png") ? ".png" : ".jpg"}`,
            mime: guessMime(f.url),
          })),
        }, { headers: { Authorization: bearer(process.env.FLOWISE_API_KEY || ""), "Content-Type": "application/json" }});

        visionSummary = respVision.data?.text?.trim() || "";
      }

      const lastMessage = buildMergedLastMessage({ combinedText, visionSummary, files }) || "(User mengirim gambar)";
      await pushToRedis(roomKey, "user", lastMessage);

      const fullContext = await buildFullContext(roomKey, summaryKey);

      const respAgent = await axios.post(
        process.env.AGENT_FLOW_URL,
        { question: lastMessage, context: fullContext, sessionId: sender_id },
        { headers: { "Content-Type": "application/json", Authorization: bearer(process.env.AGENT_API_KEY || "") } }
      );

      answer = respAgent.data?.text || "";

      if (answer) await pushToRedis(roomKey, "agent", answer);

      const totalMessages = await client.lLen(roomKey);
      if (totalMessages % 10 === 0) await updateSummary(roomKey, summaryKey);

      const isHandoff = isAdminHandoffSignal(answer);
      if (isHandoff) {
        await sendQontakText(roomId, "Silakan sampaikan pertanyaan atau pesan Anda, saya akan membantu Anda untuk berkomunikasi dengan admin.").catch(() => {});

        // Tambah tag + assign agent
        if (!(await hasRoomTag(roomId, "agent"))) {
          await addRoomTagAndAssign(roomId, "agent", [
            "da80f6d5-8c0c-4a2a-90f2-48453c88aac0",
            "471b3f67-1733-4ad3-9f2a-4963d757b00e"
          ]);
        }
      } else if (answer) {
        await sendQontakText(roomId, answer);
      }
    } catch (err) {
      console.error("❌ Error Flowise/AgentFlow:", err.response?.data || err.message);
      try { await sendQontakText(roomId, "..").catch(() => {}); } catch {}
    }
  }, BUFFER_TIMEOUT);

  res.sendStatus(200);
});
