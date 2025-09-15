// test2.js
const fetch = require("node-fetch"); // pakai require, bukan import

async function query(data) {
  try {
    const response = await fetch(
      "http://101.50.2.61:3000/api/v1/prediction/72aea920-9032-4a9c-b81f-631b36400eed", // ganti dengan flow-id kamu
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // kalau Flowise pakai API Key, aktifkan ini:
          "Authorization": "Bearer vqLafP9tgAZvSaOq2BuqQfe41P7ZxR425QnQNIqZSEI"
        },
        body: JSON.stringify(data)
      }
    );

    const text = await response.text();
    console.log("Raw response:", text);

    try {
      return JSON.parse(text);
    } catch (err) {
      console.error("❌ Gagal parse JSON:", err.message);
      return null;
    }
  } catch (err) {
    console.error("❌ Error fetch:", err.message);
    return null;
  }
}

query({
  question: "",
  uploads: [
    {
      data: "https://cdn.qontak.com/uploads/message/file/fb84fc28-d712-4a42-bdb5-96447a77cfd8/1928775971247996.jpeg",
      type: "url",
      name: "Flowise.jpeg",
      mime: "image/jpeg"
    }
  ]
})
  .then((response) => {
    console.log("Parsed response:", response);
  })
  .catch((err) => {
    console.error("❌ Error fetch:", err);
  });
