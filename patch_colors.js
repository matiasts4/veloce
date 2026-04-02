const fs = require('fs');

let content = fs.readFileSync('app/page.tsx', 'utf8');

const updated = content
  .replace(
    `                  ? "border-amber-500/40 shadow-[0_0_15px_rgba(245,158,11,0.15)] ring-1 ring-amber-500/20"`,
    `                  : status === "transcribing"
                  ? "border-cyan-400/40 shadow-[0_0_15px_rgba(34,211,238,0.15)] ring-1 ring-cyan-400/20"
                  : status === "processing"
                  ? "border-amber-500/40 shadow-[0_0_15px_rgba(245,158,11,0.15)] ring-1 ring-amber-500/20"`
  )
  .replace(
    `(status === "transcribing" || status === "processing") ? "bg-amber-500/80" : `,
    `status === "transcribing" ? "bg-cyan-400/80" : 
                        status === "processing" ? "bg-amber-500/80" : `
  )
  .replace(
    `(status === "transcribing" || status === "processing") ? "text-amber-500/90" : `,
    `status === "transcribing" ? "text-cyan-400/90" : 
                  status === "processing" ? "text-amber-500/90" : `
  );

fs.writeFileSync('app/page.tsx', updated, 'utf8');
console.log("Colors patched");
