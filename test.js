import axios from 'axios';
import sharp from 'sharp';
import fs from 'fs';
import OpenAI from 'openai';
import 'dotenv/config'; // otomatis load file .env

// Inisialisasi OpenAI client
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function downloadAndResizeImage(imageUrl, width = 600, height = 400, outputFile = 'gambar_resized.jpeg') {
  try {
    // Download gambar
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const inputBuffer = Buffer.from(response.data, 'binary');
    console.log('Gambar berhasil didownload, ukuran asli:', inputBuffer.length, 'bytes');

    // Resize gambar
    const outputBuffer = await sharp(inputBuffer)
      .resize(width, height, {
        fit: 'contain', 
        background: { r: 255, g: 255, b: 255, alpha: 1 } 
      })
      .toBuffer();

    // Simpan hasil resize
    fs.writeFileSync(outputFile, outputBuffer);
    console.log(`Gambar berhasil diresize menjadi ${width}x${height} dan disimpan ke ${outputFile}`);

    return outputBuffer;
  } catch (err) {
    console.error('Error download atau resize gambar:', err.message);
  }
}
async function analyzeDataRoaming(imageBuffer) {
    try {
      // Konversi buffer ke Base64
      const base64Image = imageBuffer.toString('base64');
  
      const response = await client.responses.create({
        model: 'gpt-4.1-mini',
        input: [
          { role: 'user', content: 'Analisis gambar ini dan jelaskan apakah data roaming aktif atau tidak.' },
          { role: 'user', content: `data:image/jpeg;base64,${base64Image}` } // tambahkan prefix data URI
        ]
      });
  
      console.log('Hasil analisis OpenAI:');
      console.log(response.output_text);
    } catch (err) {
      console.error('Error analisis gambar:', err.message);
    }
  }
  

// Contoh pemakaian lengkap
(async () => {
  const imageUrl = 'https://cdn.qontak.com/uploads/message/file/fb84fc28-d712-4a42-bdb5-96447a77cfd8/1928775971247996.jpeg';
  const resizedBuffer = await downloadAndResizeImage(imageUrl, 600, 400);
  if (resizedBuffer) {
    await analyzeDataRoaming(resizedBuffer);
  }
})();
