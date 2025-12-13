const pool = require("../db/connection");


async function save_chat(body) {
  try {

    // const resolvedAt = body.resolved_at ?? body.room?.resolved_at;

    // // Jika tiket sudah resolved → kirim semua riwayat chat
    // if (resolvedAt && Number(resolvedAt) > 0) {
    //   const roomId = body.room?.id || body.room_id;
    //   console.log("📤 Mengirim data chat ke Flowise untuk room:", roomId);

    //   await send_all_chat_to_flowise(roomId);
    //   return;
    // }

    const roomId = body.room?.id || body.room_id;

    // 🔥 Tentukan participant_type
    let participantType = "Customer"; // default

    if (body.room?.participants) {
      const p = body.room.participants.find(x => x.id === body.sender_id);

      if (p?.type === "agent") participantType = "Agent";
      else if (p?.type === "internal") participantType = "Staf Internal";
    }

    const query = `
      INSERT INTO chat_history (
        room_id, sender_id, name, participant_type, channel_account,
        account_uniq_id, text, resolved_at, created_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
    `;

    const params = [
      roomId,
      body.sender_id,
      body.room?.name || null,
      participantType,                      // ⬅️ sudah diganti
      body.room?.channel_account || null,
      body.room?.account_uniq_id || null,
      body.text || null,
      body.resolved_at || null
    ];

    await pool.query(query, params);

    console.log("💾 Data chat berhasil disimpan");

  } catch (err) {
    console.error("save_chat error:", err.message);
  }
}

// async function send_all_chat_to_flowise(roomId) {
//   try {
//     // 1. Ambil semua chat berdasarkan room_id
//     const result = await pool.query(
//       `SELECT room_id, sender_id, name, participant_type, channel_account, 
//               account_uniq_id, text 
//        FROM chat_history 
//        WHERE room_id = $1 
//        ORDER BY created_at ASC`,
//       [roomId]
//     );

//     if (result.rows.length === 0) {
//       console.log("⚠️ Tidak ada chat ditemukan");
//       return;
//     }

//     const chats = result.rows;

//     // 2. Tentukan data meta

//     const customer = chats.find(x => x.participant_type === "Customer");
//     const agent = chats.find(x => x.participant_type === "Agent");

//     const customerName = customer?.name || "Customer";
//     const agentName = agent?.name || "Agent";
//     const channel = customer?.channel_account || "-";
//     const phone = customer?.account_uniq_id || "-";

//     // 3. Gabungkan semua text chat
//     const allText = chats
//       .map(c => `${c.participant_type}: ${c.text}`)
//       .join("\n");

//     // 4. Bentuk prompt string akhir
//     const finalPrompt =
//       `Customer Name: ${customerName}. Customer Phone: ${phone}. Channel: ${channel}. Agent Name: ${agentName}.\n\n` +
//       `Chat History: ${allText}`;


//     console.log("Prompt final yang dikirim ke Flowise:\n", finalPrompt);

//     // 5. Kirim ke Flowise
//     const response = await fetch(
//       "http://101.50.2.61:3000/api/v1/prediction/96e09b89-9cc6-44d9-a3ca-50978d0a1fe1",
//       {
//         method: "POST",
//         headers: { "Content-Type": "application/json" },
//         body: JSON.stringify({
//           question: finalPrompt,
//           overrideConfig: {
//             sessionId: roomId
//           }
//         })
//       }
//     );
//     const jsonOutput = await response.json();
//     // console.log("📥 Response dari Flowise:", jsonOutput);
//     //proses mengirim ke lark
//     try {
//       await postToLark(jsonOutput);
//       if (roomId) {
//         await deleteChatHistory(roomId);
//       } else {
//         console.warn("⚠️ Tidak ada room_id, tidak bisa hapus chat history.");
//       }
//     } catch (error) {
//       console.error("Gagal kirim ke Lark:", error.message);
//     }
//     return jsonOutput;

//   } catch (err) {
//     console.error("❌ send_all_chat_to_flowise error:", err.stack || err.message);
//     return null;
//   }
// }
// ===============================
//  POST DATA KE LARK BITABLE
// ===============================
// const lark = require('@larksuiteoapi/node-sdk');

// const client = new lark.Client({
//   appId: 'cli_a9b08d686d785e1c',
//   appSecret: 'OspfJ0odyeu3UBhY72x52dnBspfO8eZl',
//   disableTokenCache: false
// });

// const LARK_APP_TOKEN = "YjFIbHekKaIMs7sYdcaj0EVBp2b";
// const LARK_TABLE_ID = "tbljwPpANEL0gDAh";

// async function postToLark(jsonOutput) {
//   try {
//     if (!jsonOutput) throw new Error("jsonOutput kosong");

//     let parsedData = {};

//     if (jsonOutput.text) {
//       try {
//         parsedData = JSON.parse(jsonOutput.text);
//         console.log("📋 Parsed Data dari Flowise:", parsedData);
//       } catch (e) {
//         console.error("❌ Gagal parse jsonOutput.text:", e);
//         throw new Error("Format response Flowise tidak valid");
//       }
//     }

//     // ✅ PERBAIKAN: Pakai object biasa, BUKAN Map!
//     const fieldsData = {
//       'sentimen': parsedData.setiment || parsedData.sentiment || '',
//       'category_kendala': parsedData.category || '',
//       'detail_kendala': parsedData['detail kendala'] || '',
//       'result': parsedData.result || '',
//       'product_bermasalah': parsedData['product bermasalah'] || '',
//       'nama_customer': parsedData['name customer'] || '',
//       'nomor_telepon': parsedData['nomor telpon'] || '',
//       'nama_channel': parsedData.channel || ''
//     };

//     console.log("📤 Fields yang akan dikirim:", fieldsData);

//     // ✅ PERBAIKAN: Pakai .create() bukan .batchCreate() untuk single record
//     const res = await client.bitable.appTableRecord.create({
//       path: {
//         app_token: LARK_APP_TOKEN,
//         table_id: LARK_TABLE_ID
//       },
//       data: {
//         fields: fieldsData  // ⚠️ Plain object, bukan Map!
//       }
//     });

//     console.log("✅ Berhasil kirim ke Lark");


//     //hapus sessions di flowise
//      try {
//       const url = `http://101.50.2.61:3000/api/v1/chatmessage/96e09b89-9cc6-44d9-a3ca-50978d0a1fe1?sessionId=${room_id}`;

//       const resp = await axios.delete(url, {
//         timeout: 10000,
//       });

//       console.log("✔️ Session berhasil dihapus dari API eksternal:", resp.data);

//     } catch (apiErr) {
//       console.error("⚠️ Gagal hapus session ke API eksternal:", apiErr.message);
  
//     }
//     return res;

//   } catch (err) {
//     console.error("ERROR kirim ke Lark SDK:");

//     if (err.response?.data) {
//       console.error(JSON.stringify(err.response.data, null, 2));
//     } else {
//       console.error(err.message);
//     }

//     throw err;
//   }
// }



//delete chat history di database
async function deleteChatHistory(room_id) {
  try {
    console.log(`Menjalankan deleteChatHistory untuk room_id: ${room_id}`);
    const result = await pool.query(
      `DELETE FROM chat_history WHERE room_id = $1`,
      [room_id]
    );
   
    return true;
  } catch (err) {
    console.error("Gagal menjalankan deleteChatHistory:", err.message);
    return false;
  }
}










module.exports = { save_chat };
