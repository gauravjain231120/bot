const fs = require('fs');

let code = fs.readFileSync('lib/checkAmazonOrders.js', 'utf8');

// Reset the messed up sendPayload lines
code = code.replace(/    payload\.engineMode = engineMode;\n    payload\.engineMode = engineMode;\n  const res = await sendPayload\(payload, 'amazon'\);/g, "    payload.engineMode = engineMode;\n    const res = await sendPayload(payload, 'amazon');");

// Check if the second sendPayload has engineMode
if (!code.includes("  payload.engineMode = engineMode;\n  const res = await sendPayload(payload, 'amazon');")) {
  code = code.replace("  const res = await sendPayload(payload, 'amazon');", "  payload.engineMode = engineMode;\n  const res = await sendPayload(payload, 'amazon');");
}

// Fix the signature of sendAmazonOrderAlert
code = code.replace(
  "async function sendAmazonOrderAlert(order, { openCount = null, onUnits = async () => {} } = {}) {",
  "async function sendAmazonOrderAlert(order, { openCount = null, onUnits = async () => {}, engineMode = null } = {}) {"
);

// Fix the caller inside alertNewAmazonOrders
code = code.replace(
  "          onUnits: (units) => (doc.units ? null : seen.updateOne({ _id: id, units: null }, { $set: { units } })),\n        });",
  "          onUnits: (units) => (doc.units ? null : seen.updateOne({ _id: id, units: null }, { $set: { units } })),\n          engineMode\n        });"
);

fs.writeFileSync('lib/checkAmazonOrders.js', code);
