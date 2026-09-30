const fs = require('fs');

function fixFile(path) {
  let content = fs.readFileSync(path, 'utf8');
  // Replace 4 levels of ../ with 3 levels
  content = content.replace(/\.\.\/\.\.\/\.\.\/\.\.\/lib/g, '../../../lib');
  fs.writeFileSync(path, content);
}

fixFile('app/api/proxy-submit/route.js');
fixFile('app/api/proxy-test/route.js');
