const fs = require('fs');

// Patch Myntra
let mynCode = fs.readFileSync('lib/checkOrders.js', 'utf8');

mynCode = mynCode.replace(
  'async function sendOrderAlert(order, headers, { attempt = 1, openCount = null, onUnits = async () => {}, rebuild = false } = {}) {',
  'async function sendOrderAlert(order, headers, { attempt = 1, openCount = null, onUnits = async () => {}, rebuild = false, engineMode = null } = {}) {'
);

mynCode = mynCode.replace(
  '    const res = await sendPayload(payload, \'myntra\');',
  '    payload.engineMode = engineMode;\n    const res = await sendPayload(payload, \'myntra\');'
);

mynCode = mynCode.replace(
  '  const res = await sendPayload(payload, \'myntra\');',
  '  payload.engineMode = engineMode;\n  const res = await sendPayload(payload, \'myntra\');'
);

mynCode = mynCode.replace(
  'async function alertNewOrders(db, orders, headers) {',
  'async function alertNewOrders(db, orders, headers, engineMode = null) {'
);

mynCode = mynCode.replace(
  '          onUnits: (units) => (doc.units ? null : seenOrders.updateOne({ _id: id, units: null }, { $set: { units } })),',
  '          onUnits: (units) => (doc.units ? null : seenOrders.updateOne({ _id: id, units: null }, { $set: { units } })),\n          engineMode,'
);

mynCode = mynCode.replace(
  'const { newCount, deferred } = await alertNewOrders(db, orders, headers);',
  'const engineMode = proxyData ? \'local\' : \'cloud\';\n  const { newCount, deferred } = await alertNewOrders(db, orders, headers, engineMode);'
);

fs.writeFileSync('lib/checkOrders.js', mynCode);


// Patch Amazon
let amzCode = fs.readFileSync('lib/checkAmazonOrders.js', 'utf8');

amzCode = amzCode.replace(
  'async function sendAmazonOrderAlert(order, headers, { attempt = 1, openCount = null, onUnits = async () => {}, rebuild = false } = {}) {',
  'async function sendAmazonOrderAlert(order, headers, { attempt = 1, openCount = null, onUnits = async () => {}, rebuild = false, engineMode = null } = {}) {'
);

amzCode = amzCode.replace(
  '    const res = await sendPayload(payload, \'amazon\');',
  '    payload.engineMode = engineMode;\n    const res = await sendPayload(payload, \'amazon\');'
);

amzCode = amzCode.replace(
  '  const res = await sendPayload(payload, \'amazon\');',
  '  payload.engineMode = engineMode;\n  const res = await sendPayload(payload, \'amazon\');'
);

amzCode = amzCode.replace(
  'async function alertNewAmazonOrders(db, orders, headers) {',
  'async function alertNewAmazonOrders(db, orders, headers, engineMode = null) {'
);

amzCode = amzCode.replace(
  '          onUnits: (units) => (doc.units ? null : seenOrders.updateOne({ _id: id, units: null }, { $set: { units } })),',
  '          onUnits: (units) => (doc.units ? null : seenOrders.updateOne({ _id: id, units: null }, { $set: { units } })),\n          engineMode,'
);

amzCode = amzCode.replace(
  'const { newCount, deferred } = await alertNewAmazonOrders(db, orders);',
  'const engineMode = proxyData ? \'local\' : \'cloud\';\n  const { newCount, deferred } = await alertNewAmazonOrders(db, orders, null, engineMode);'
);
// note Amazon doesn't pass headers in runCheckAmazonOrders

fs.writeFileSync('lib/checkAmazonOrders.js', amzCode);
