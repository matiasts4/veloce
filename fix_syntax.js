const fs = require('fs');

let content = fs.readFileSync('app/page.tsx', 'utf8');

content = content.replace(
  `                  : (status === "transcribing" || status === "processing")\n                  : status === "transcribing"`,
  `                  : status === "transcribing"`
);

fs.writeFileSync('app/page.tsx', content, 'utf8');
console.log("Syntax fixed");
