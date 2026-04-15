#!/usr/bin/env node
// Generates 100x22 PNG tray icons for Veloce — cyan palette, bar chart design
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = 100;
const H = 22;
const ICON_DIR = path.join(__dirname, 'src-tauri', 'icons');

// ── PNG writer ────────────────────────────────────────────────────────────────
function writeUint32BE(b, v, o) {
  b[o]=(v>>>24)&0xff; b[o+1]=(v>>>16)&0xff; b[o+2]=(v>>>8)&0xff; b[o+3]=v&0xff;
}
function makeCRC() {
  const t = new Uint32Array(256);
  for (let i=0;i<256;i++){let c=i;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[i]=c;}
  return t;
}
const CRC_TABLE = makeCRC();
function crc32(buf,s,l){let c=0xffffffff;for(let i=s;i<s+l;i++)c=CRC_TABLE[(c^buf[i])&0xff]^(c>>>8);return(c^0xffffffff)>>>0;}
function chunk(type,data){
  const t=Buffer.from(type,'ascii'),out=Buffer.allocUnsafe(4+4+data.length+4);
  writeUint32BE(out,data.length,0);t.copy(out,4);data.copy(out,8);
  writeUint32BE(out,crc32(out,4,4+data.length),8+data.length);return out;
}
function png(pixels,w,h){
  const sig=Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr=Buffer.allocUnsafe(13);
  writeUint32BE(ihdr,w,0);writeUint32BE(ihdr,h,4);
  ihdr[8]=8;ihdr[9]=6;ihdr[10]=0;ihdr[11]=0;ihdr[12]=0;
  const raw=Buffer.allocUnsafe(h*(1+w*4));
  for(let y=0;y<h;y++){
    raw[y*(1+w*4)]=0;
    for(let x=0;x<w;x++){
      const s=(y*w+x)*4,d=y*(1+w*4)+1+x*4;
      raw[d]=pixels[s];raw[d+1]=pixels[s+1];raw[d+2]=pixels[s+2];raw[d+3]=pixels[s+3];
    }
  }
  return Buffer.concat([sig,chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw,{level:6})),chunk('IEND',Buffer.alloc(0))]);
}

// ── Pixel helpers ─────────────────────────────────────────────────────────────
function canvas(){return new Uint8Array(W*H*4);}
function px(p,x,y,r,g,b,a=255){
  if(x<0||x>=W||y<0||y>=H)return;
  const i=(y*W+x)*4;p[i]=r;p[i+1]=g;p[i+2]=b;p[i+3]=a;
}
function rect(p,x,y,w,h,r,g,b,a=255){
  for(let dy=0;dy<h;dy++)for(let dx=0;dx<w;dx++)px(p,x+dx,y+dy,r,g,b,a);
}

// ── Colors ────────────────────────────────────────────────────────────────────
// Veloce cyan palette
const CYAN_BRIGHT = [0, 210, 255];    // #00D2FF  — active bars
const CYAN_MID    = [0, 160, 200];    // #00A0C8  — mid highlights
const CYAN_DIM    = [0, 60,  80];     // #003C50  — background track (idle)
const GRAY_IDLE   = [60, 80, 95];     // #3C505F  — bars when not recording

// ── Layout ───────────────────────────────────────────────────────────────────
const NUM_BARS = 9;
const BAR_W = 6, BAR_GAP = 4;
const TOTAL_BAR_W = NUM_BARS * BAR_W + (NUM_BARS - 1) * BAR_GAP; // 86
const OX = Math.floor((W - TOTAL_BAR_W) / 2); // 7
const MY = 3;                                   // margin top/bottom
const MAX_H = H - MY * 2;                       // 16

// Organic envelope: center bars tallest
const MULTS = [0.40, 0.62, 0.80, 0.93, 1.00, 0.93, 0.80, 0.62, 0.40];

function draw(state) {
  // state: 'idle' | 0..4
  const p = canvas();
  const isIdle = state === 'idle';

  for (let i = 0; i < NUM_BARS; i++) {
    const x      = OX + i * (BAR_W + BAR_GAP);
    const mult   = MULTS[i];
    const maxH   = Math.round(MAX_H * mult);
    const baseY  = H - MY;

    let fraction;
    if (isIdle)         fraction = 0.10;   // very short — Veloce is running but quiet
    else if (state===0) fraction = 0.14;   // level 0 = listening but silent
    else                fraction = state / 4;

    const activeH = Math.max(2, Math.round(maxH * fraction));

    // Background track
    if (isIdle) {
      rect(p, x, baseY - maxH, BAR_W, maxH, ...GRAY_IDLE, 35);
      rect(p, x, baseY - activeH, BAR_W, activeH, ...GRAY_IDLE, 130);
    } else {
      rect(p, x, baseY - maxH, BAR_W, maxH, ...CYAN_DIM, 60);
      rect(p, x, baseY - activeH, BAR_W, activeH, ...CYAN_BRIGHT, 255);
      // Top glow highlight
      if (activeH > 1) {
        rect(p, x + 1, baseY - activeH, BAR_W - 2, 1, ...CYAN_MID, 200);
      }
    }
  }

  return p;
}

// ── Write files ───────────────────────────────────────────────────────────────
const files = [
  { name: '32x32.png',              state: 'idle' },   // replaces the W square logo in tray
  { name: '32x32-recording.png',    state: 0      },
  { name: '32x32-recording-v1.png', state: 1      },
  { name: '32x32-recording-v2.png', state: 2      },
  { name: '32x32-recording-v3.png', state: 3      },
  { name: '32x32-recording-v4.png', state: 4      },
];

for (const f of files) {
  const pixels = draw(f.state);
  const buf    = png(pixels, W, H);
  fs.writeFileSync(path.join(ICON_DIR, f.name), buf);
  console.log(`✓ ${f.name}  (${W}×${H}  ${buf.length}B)`);
}

// Restore Veloce's real app icon from backup if it exists
const REAL_ICON = path.join(ICON_DIR, 'veloce_icon_source_square.png');
const ICON_128  = path.join(ICON_DIR, '128x128.png');
// Note: 32x32.png is only used for the TRAY — the app icon (128x128) stays untouched

console.log('\n✅ Done. Tray uses cyan bar design. App icon (128x128) unchanged.');
