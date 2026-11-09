'use strict';
// 零依赖生成托盘/窗口图标 PNG（手工编码 PNG：RGBA + zlib deflate + CRC32）
// 图案：圆角深色方块 + 三根绿色柱状图（呼应"用量监控"）
// 输出 src/main/icons.js：base64 内联模块，供主进程 nativeImage 使用

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ---- PNG 编码 ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  // 每行前置 filter byte 0
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const off = y * (1 + width * 4);
    raw[off] = 0;
    rgba.copy(raw, off + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- 图案绘制 ----
function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, r, g, b, a = 255) => {
    const i = (y * size + x) * 4;
    // alpha 混合（抗锯齿用）
    const sa = a / 255;
    px[i] = Math.round(r * sa + px[i] * (1 - sa));
    px[i + 1] = Math.round(g * sa + px[i + 1] * (1 - sa));
    px[i + 2] = Math.round(b * sa + px[i + 2] * (1 - sa));
    px[i + 3] = Math.max(px[i + 3], a);
  };
  const u = size / 32; // 以 32px 设计稿为基准的缩放

  const inRoundedRect = (x, y, x0, y0, x1, y1, r) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return 0;
    const cx = Math.max(x0 + r, Math.min(x, x1 - r));
    const cy = Math.max(y0 + r, Math.min(y, y1 - r));
    const d = Math.hypot(x - cx, y - cy);
    return Math.max(0, Math.min(1, r - d + 0.5));
  };
  const inBar = (x, y, x0, x1, yTop) => (x >= x0 && x <= x1 && y >= yTop && y <= 25 * u ? 1 : 0);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = x + 0.5, fy = y + 0.5;
      // 背板：深灰蓝圆角方块（3.5,3.5)-(28.5,28.5)，圆角 7
      const bg = inRoundedRect(fx, fy, 3.5 * u, 3.5 * u, 28.5 * u, 28.5 * u, 7 * u);
      if (bg > 0) set(x, y, 24, 28, 36, Math.round(255 * bg));
      // 三根柱子（绿色 #22c55e 系），高度递增，底边 25
      const bars = [
        [9, 11.5, 17],
        [14.5, 17, 13.5],
        [20, 22.5, 9.5],
      ];
      for (const [bx0, bx1, yTop] of bars) {
        const b = inBar(fx, fy, bx0 * u, bx1 * u, yTop * u);
        if (b > 0) set(x, y, 34, 197, 94, Math.round(255 * b));
      }
    }
  }
  return encodePNG(size, size, px);
}

const icons = {
  tray16: drawIcon(16).toString('base64'),
  tray32: drawIcon(32).toString('base64'),
  app64: drawIcon(64).toString('base64'),
};

const out = path.join(__dirname, '..', 'src', 'main', 'icons.js');
fs.writeFileSync(
  out,
  '// 由 scripts/gen-icons.js 生成，勿手改\n' +
  "'use strict';\n" +
  'module.exports = {\n' +
  Object.entries(icons).map(([k, v]) => `  ${k}: '${v}',`).join('\n') +
  '\n};\n',
  'utf8'
);
console.log('icons written:', out, `(${icons.tray16.length}b / ${icons.tray32.length}b base64)`);
