require("dotenv").config();
const { google } = require("googleapis");
const { createConnection } = require("./db");
const { parsePhoneNumberFromString } = require("libphonenumber-js");

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const RANGE = "Sheet2!A1:Z"; // Now including all columns up to Z

async function getAuthClient() {
  return new google.auth.JWT(
    process.env.GOOGLE_CLIENT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    ["https://www.googleapis.com/auth/spreadsheets.readonly"]
  );
}

async function fetchSheetData(auth) {
  const sheets = google.sheets({ version: "v4", auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: RANGE,
  });
  return response.data.values || [];
}

function parsePhoneNumber(phone) {
  if (!phone) return { country_code: "", phone_number: "" };
  const cleanedPhone = phone.replace(/^p:/, "").trim();
  const parsed = parsePhoneNumberFromString(cleanedPhone);
  if (parsed && parsed.isValid()) {
    return { country_code: `+${parsed.countryCallingCode}`, phone_number: parsed.nationalNumber };
  }
  return { country_code: "", phone_number: phone };
}

function formatDate(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return "";
  const [day, month, year] = dateStr.split('_');
  if (!day || !month || !year) return "";
  const monthMap = {
    january: '01', february: '02', march: '03', april: '04',
    may: '05', june: '06', july: '07', august: '08',
    september: '09', october: '10', november: '11', december: '12'
  };
  return `${year}-${monthMap[month.toLowerCase()] || '01'}-${day.replace(/\D/g, '')}`;
}

async function processCustomerAndLead(connection, leadData) {
    if (!Array.isArray(leadData)) {
      console.error("❌ Invalid lead data format:", leadData);
      return;
    }
  
    try {
      // Extract values
      const created_time = leadData[1] || ""; // B column → lead_date
      const ad_name = leadData[3] || ""; // D column → ad_copy
      const adset_name = leadData[5] || ""; // F column → ad_set
      const campaign_name = leadData[7] || ""; // H column → lead_type
      const form_name = leadData[9] || ""; // J column → destination
      const platform = leadData[11] || ""; // L column → sources
      const prefered_date_of_departure = leadData[12] || ""; // M column → start_date
      const people_count = leadData[13] || ""; // N column → people_count
      const full_name = leadData[14] || ""; // O column → name
      const email = leadData[15] || ""; // P column
      const phone_number = leadData[16] || ""; // Q column
      const city = leadData[17] || ""; // R column → origincity
  
      const formattedStartDate = formatDate(prefered_date_of_departure);
      const { country_code, phone_number: parsedPhone } = parsePhoneNumber(phone_number);
  
      // Check if the customer exists
      const [customerResults] = await connection.promise().query(
        "SELECT id, customer_status FROM customers WHERE phone_number = ? AND country_code = ?",
        [parsedPhone, country_code]
      );
  
      let customerId;
      let customerStatus = "new";
  
      if (customerResults.length > 0) {
        customerId = customerResults[0].id;
        customerStatus = customerResults[0].customer_status || "existing";
      } else {
        const [insertResult] = await connection.promise().query(
          "INSERT INTO customers (name, email, phone_number, country_code, customer_status) VALUES (?, ?, ?, ?, ?)",
          [full_name.trim(), email.trim(), parsedPhone.trim(), country_code.trim(), customerStatus]
        );
        customerId = insertResult.insertId;
      }
  
      // Prepare values
      const values = [
        created_time.trim(), ad_name.trim(), adset_name.trim(), campaign_name.trim(),
        platform.trim(), formattedStartDate, people_count.trim(), full_name.trim().toLowerCase(),
        email.trim().toLowerCase(), parsedPhone.trim(), country_code.trim(), city.trim(),
        platform.trim(), form_name.trim(), "Meta", "Facebook (Paid)", customerId, customerStatus
      ];
  
      console.log("🔹 Prepared Data:", values);
  
      // Check for existing lead
      const [existingLead] = await connection.promise().query(
        "SELECT * FROM addleads WHERE lead_date = ? AND phone_number = ? AND country_code = ?",
        [created_time.trim(), parsedPhone.trim(), country_code.trim()]
      );
  
      if (existingLead.length === 0) {
        await connection.promise().query(
          `INSERT INTO addleads 
            (lead_date, ad_copy, ad_set, lead_type, sources, start_date, people_count, name, email, 
             phone_number, country_code, origincity, channel, destination, 
             primarySource, secondarysource, customerid, customer_status) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          values
        );
        console.log(`✅ Lead added for customer: ${full_name} (Customer ID: ${customerId})`);
      } else {
        console.log(`⚠️ Skipped duplicate lead for: ${email} / ${parsedPhone}`);
  
        // **Update customer_status in addleads if necessary**
        const existingLeadId = existingLead[0].id;
        await connection.promise().query(
          "UPDATE addleads SET customer_status = ? WHERE leadid = ?",
          [customerStatus, existingLeadId]
        );
        console.log(`🔄 Updated customer_status for lead ID ${existingLeadId} to ${customerStatus}`);
      }
    } catch (error) {
      console.error("❌ Error processing customer and lead:", error);
    }
  }
  
  

  
async function insertIntoDB(data) {
  if (data.length <= 1) return;
  const connection = createConnection();
  try {
    for (const row of data.slice(1)) {
      if (!row[1]) continue; // Skip if created_time is empty
      await processCustomerAndLead(connection, row);
    }
  } catch (error) {
    console.error("❌ Error inserting into DB:", error);
  } finally {
    connection.end();
  }
}

async function syncData() {
  console.log("🔄 Syncing data from Google Sheets...");
  try {
    const auth = await getAuthClient();
    const data = await fetchSheetData(auth);
    if (data.length > 0) {
      await insertIntoDB(data);
      console.log("✅ Sync complete!");
    } else {
      console.log("❌ No new data found.");
    }
  } catch (error) {
    console.error("❌ Error syncing data:", error);
  }
}

module.exports = { syncData };