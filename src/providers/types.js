'use strict';
// 共享的类型约定与格式化工具（纯函数，可在 Node 与 Electron 中运行）
//
// Provider 统一输出快照条目（item）：
// {
//   key:      唯一标识（同 provider 内），用于历史记录与通知去重
//   label:    显示名，如 "5小时" / "本周" / "现金余额"
//   kind:     'percent' 进度条条目 | 'amount' 金额条目 | 'text' 文本条目
//   usedPct:  percent 条目：已用百分比 0-100
//   amountText: amount/text 条目：格式化后的字符串，如 "¥86.42"
//   amountNum:  amount 条目：数值（用于历史曲线）
//   sub:      次要说明，如 "赠金 ¥10.00" / "到期 2026-12-01"
//   resetAt:  percent 条目：重置时间(ms epoch)，用于倒计时
//   state:    'ok' | 'warn' | 'error'，由 stateFor 计算，渲染层也可覆盖
// }

const CURRENCY_SYMBOL = { CNY: '¥', RMB: '¥', USD: '$' };

function currencySymbol(code) {
  if (!code) return '¥';
  const c = String(code).toUpperCase();
  return CURRENCY_SYMBOL[c] || c + ' ';
}

function formatAmount(n, cur) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  const s = v.toFixed(2);
  const [int, frac] = s.split('.');
  const withSep = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return currencySymbol(cur) + withSep + '.' + frac;
}

// tokens 数量：中文习惯单位（万/亿），如 123.4万
function formatTokens(n) {
  const v = Number(n) || 0;
  const a = Math.abs(v);
  if (a >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (a >= 1e4) return (v / 1e4).toFixed(1) + '万';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return String(Math.round(v));
}

// 宽松的时间解析：兼容 ISO、时间戳、"2026-11-09 20:00:00"（按本地时区）
function parseDateLoose(s) {
  if (s == null || s === '') return null;
  if (typeof s === 'number' && Number.isFinite(s)) {
    return s > 1e12 ? s : s * 1000; // 秒/毫秒时间戳
  }
  let str = String(s).trim();
  if (/^\d{10,13}$/.test(str)) return Number(str) > 1e12 ? Number(str) : Number(str) * 1000;
  str = str.replace(' ', 'T');
  let t = Date.parse(str);
  if (Number.isNaN(t)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) t = Date.parse(str + 'T00:00:00');
    else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(str)) t = Date.parse(str + ':00');
  }
  return Number.isNaN(t) ? null : t;
}

// 剩余重置时间的短文案："3d 2h" / "2h13m" / "45m" / "已重置"
function countdown(resetAt, now = Date.now()) {
  if (!resetAt) return null;
  const diff = resetAt - now;
  if (diff <= 0) return '已重置';
  const m = Math.floor(diff / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h' + String(m % 60).padStart(2, '0') + 'm';
  const d = Math.floor(h / 24);
  return d + 'd' + String(h % 24).padStart(2, '0') + 'h';
}

// 已用百分比 → 状态色：< threshold-20 绿，< threshold 黄，否则红
function stateFor(usedPct, threshold = 80) {
  const p = Number(usedPct);
  if (!Number.isFinite(p)) return 'unknown';
  if (p >= threshold) return 'error';
  if (p >= Math.max(50, threshold - 20)) return 'warn';
  return 'ok';
}

// 从嵌套 JSON 中按候选字段名深搜第一个可数值化的字段（模仿 token-lens 的防御式解析）
function deepPick(obj, aliases, depth = 4) {
  if (obj == null || depth < 0) return undefined;
  if (Array.isArray(obj)) {
    for (const it of obj) {
      const hit = deepPick(it, aliases, depth - 1);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (typeof obj !== 'object') return undefined;
  for (const a of aliases) {
    if (a in obj) {
      const v = toNumber(obj[a]);
      if (v != null) return v;
    }
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object') {
      const hit = deepPick(v, aliases, depth - 1);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

function toNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/,/g, '').trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function firstNumber(...vals) {
  for (const v of vals) {
    const n = toNumber(v);
    if (n != null) return n;
  }
  return null;
}

// 平台响应信封统一判定成功（智谱部分接口 200 + code 才是真实错误码）
function envelopeOk(json) {
  if (!json || typeof json !== 'object') return false;
  if (json.success === true) return true;
  const c = json.code;
  if (c == null) return json.data != null || json.rows != null;
  return Number(c) === 200 || c === '200' || c === 'success';
}

function envelopeMsg(json) {
  if (!json) return '';
  return String(json.msg || json.message || json.error && json.error.message || '').slice(0, 120);
}

module.exports = {
  currencySymbol, formatAmount, formatTokens,
  parseDateLoose, countdown, stateFor,
  deepPick, toNumber, firstNumber, envelopeOk, envelopeMsg,
};
