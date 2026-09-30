const fs = require('fs');
let code = fs.readFileSync('app/api/session/health/route.js', 'utf8');

code = code.replace(
  'return NextResponse.json({',
  `return NextResponse.json({\n    warehouseId: process.env.WAREHOUSE_ID || '89623',`
);

fs.writeFileSync('app/api/session/health/route.js', code);
