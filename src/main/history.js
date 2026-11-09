'use strict';
// 用量历史：history.jsonl 追加写，供 24h sparkline 查询
// 每行：{ t, provider, key, pct?, amount? }；文件超 512KB 时裁剪保留最近 3000 行

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 512 * 1024;
const KEEP_LINES = 3000;

function fileOf(userDataDir) {
  return path.join(userDataDir, 'history.jsonl');
}

function append(userDataDir, records) {
  if (!records || !records.length) return;
  const file = fileOf(userDataDir);
  fs.mkdirSync(userDataDir, { recursive: true });
  const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(file, lines, 'utf8');
  try {
    if (fs.statSync(file).size > MAX_BYTES) compact(file);
  } catch { /* 忽略统计失败 */ }
}

function compact(file) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n').filter(Boolean);
  fs.writeFileSync(file, lines.slice(-KEEP_LINES).join('\n') + '\n', 'utf8');
}

function query(userDataDir, providerId, sinceMs) {
  const file = fileOf(userDataDir);
  let content = '';
  try { content = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of content.split('\n')) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (providerId && rec.provider !== providerId) continue;
    if (sinceMs && rec.t < sinceMs) continue;
    out.push(rec);
  }
  return out;
}

module.exports = { append, query };
