const lark = require('@larksuiteoapi/node-sdk');

const client = new lark.Client({
  appId: 'cli_a9b08d686d785e1c',
  appSecret: 'OspfJ0odyeu3UBhY72x52dnBspfO8eZl',
});

const LARK_APP_TOKEN = "KUYPwIUPBi1aLnk39cyjqYvNpgp";
const LARK_TABLE_ID = "tblpeMeWa6gPpLVf";

async function debugLarkTable() {
  try {
    console.log("🔍 Mengecek fields di table...\n");
    
    // Get all fields
    const fieldsRes = await client.bitable.appTableField.list({
      path: {
        app_token: LARK_APP_TOKEN,
        table_id: LARK_TABLE_ID
      }
    });
    
    console.log("📋 Available Fields:");
    if (fieldsRes.data && fieldsRes.data.items) {
      fieldsRes.data.items.forEach(field => {
        console.log(`  - ${field.field_name} (ID: ${field.field_id}, Type: ${field.type})`);
      });
    }
    
    console.log("\n✅ Sekarang test insert record...\n");
    
    // Test insert dengan field names yang benar
    const testData = {
      fields: {
        'sentiment': 'netral',
        'category_kendala': 'esim',
        'detail_kendala': 'Test insert',
        'result': 'pending',
        'product_bermasalah': '',
        'nama_customer': 'Test Customer',
        'nomor_telepon': '628123456789',
        'nama_channel': 'Test Channel'
      }
    };
    
    console.log("📤 Data yang dikirim:", testData);
    
    const insertRes = await client.bitable.appTableRecord.create({
      path: {
        app_token: LARK_APP_TOKEN,
        table_id: LARK_TABLE_ID
      },
      data: testData
    });
    
    console.log("\n✅ Berhasil insert!", insertRes);
    
  } catch (err) {
    console.error("\n❌ Error:", err);
    if (err.response) {
      console.error("Response detail:", JSON.stringify(err.response, null, 2));
    }
  }
}

debugLarkTable();