const fs = require('fs');
let code = fs.readFileSync('lib/checkAmazonOrders.js', 'utf8');

code = code.replace(
  'async function alertNewAmazonOrders(db, orders) {',
  'async function alertNewAmazonOrders(db, orders, engineMode = null) {'
);

code = code.replace(
  'const { newCount, deferred } = await alertNewAmazonOrders(db, orders, null, engineMode);',
  'const { newCount, deferred } = await alertNewAmazonOrders(db, orders, engineMode);'
);

code = code.replace(
  'const engineMode = proxyData ? \'local\' : \'cloud\';\n  const engineMode = proxyData ? \'local\' : \'cloud\';',
  'const engineMode = proxyData ? \'local\' : \'cloud\';'
);

fs.writeFileSync('lib/checkAmazonOrders.js', code);
