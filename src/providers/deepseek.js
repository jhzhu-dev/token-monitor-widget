'use strict';
// DeepSeek 开放平台：按量付费账户余额（无订阅套餐）
// GET https://api.deepseek.com/user/balance  Authorization: Bearer <key>
// → { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_balance }] }
// 文档：https://api-docs.deepseek.com/zh-cn/api/get-user-balance

const { formatAmount } = require('./types');

const BALANCE_URL = 'https://api.deepseek.com/user/balance';

const id = 'deepseek';
const name = 'DeepSeek';

function parseBalance(json) {
  const infos = (json && Array.isArray(json.balance_infos)) ? json.balance_infos : [];
  const items = [];
  infos.forEach((info, i) => {
    const total = Number(info.total_balance);
    if (!Number.isFinite(total)) return;
    const granted = Number(info.granted_balance) || 0;
    const topped = Number(info.topped_balance) || 0;
    const suffix = infos.length > 1 ? ' ' + (info.currency || i + 1) : '';
    items.push({
      key: 'balance.' + i,
      label: '账户余额' + suffix,
      kind: 'amount',
      amountNum: total,
      amountText: formatAmount(total, info.currency),
      currency: info.currency || 'CNY',
      sub: granted > 0 ? '其中赠金 ' + formatAmount(granted, info.currency) + '（充值 ' + formatAmount(topped, info.currency) + '）' : undefined,
      state: json.is_available === false || total <= 0 ? 'error' : 'ok',
    });
  });
  return { items };
}

// 近 24h 消耗：官方无用量端点，用本地余额历史推导（基线取窗口内最早一条记录）
// rows: [{t, amount}]（main 侧已按 key=balance.N 与时间窗过滤）
// → { consumption: number|null, toppedUp: boolean, points: number }
function computeConsumption(rows) {
  const pts = (rows || [])
    .filter((r) => Number.isFinite(r.amount))
    .sort((a, b) => a.t - b.t);
  if (pts.length < 2) return { consumption: null, toppedUp: false, points: pts.length };
  const base = pts[0].amount;
  const last = pts[pts.length - 1].amount;
  const delta = base - last;
  return {
    // 货币显示两位小数，同时规避浮点误差（如 9.799999...）
    consumption: Math.round(Math.max(0, delta) * 100) / 100,
    toppedUp: delta < -0.005, // 余额不降反升 → 期间有充值
    points: pts.length,
  };
}

async function fetchProvider(cfg) {
  const key = String(cfg.apiKey || '').trim();
  if (!key) return { id, name, ok: false, error: '未配置 API Key', items: [] };

  let res;
  try {
    res = await fetch(BALANCE_URL, { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' } });
  } catch (e) {
    return { id, name, ok: false, error: '网络错误：' + e.message, items: [] };
  }
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON */ }
  if (res.status === 401) return { id, name, ok: false, error: 'Key 无效或已过期', items: [] };
  if (!res.ok) {
    const msg = json && json.error && json.error.message ? '：' + json.error.message : '';
    return { id, name, ok: false, error: 'HTTP ' + res.status + msg, items: [] };
  }
  const parsed = parseBalance(json);
  if (!parsed.items.length) return { id, name, ok: false, error: '响应中无余额数据', items: [] };
  return { id, name, ok: true, error: null, items: parsed.items };
}

module.exports = { id, name, fetchProvider, parseBalance, computeConsumption, BALANCE_URL };
