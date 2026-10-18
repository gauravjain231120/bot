const { getStockDb } = require("./stock");

const DEFAULT_MYNTRA_RTD_CUTOFF = "13:00"; // 1:00 PM IST

async function getMyntraRtdCutoff() {
  try {
    const db = await getStockDb();
    const doc = await db.collection("settings").findOne({ _id: "myntra_rtd" });
    if (doc && typeof doc.value === "string") return doc.value;
    if (doc && typeof doc.value?.cutoffTime === "string") return doc.value.cutoffTime;
    return DEFAULT_MYNTRA_RTD_CUTOFF;
  } catch (err) {
    return DEFAULT_MYNTRA_RTD_CUTOFF;
  }
}

async function getMyntraHolidays() {
  try {
    const db = await getStockDb();
    const doc = await db.collection("settings").findOne({ _id: "myntra_holidays" });
    if (doc && Array.isArray(doc.value)) {
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
      return doc.value.filter((d) => typeof d === "string" && d >= today).sort();
    }
    return [];
  } catch (err) {
    console.error("Failed to fetch Myntra holidays:", err.message);
    return [];
  }
}

module.exports = {
  DEFAULT_MYNTRA_RTD_CUTOFF,
  getMyntraRtdCutoff,
  getMyntraHolidays,
};
