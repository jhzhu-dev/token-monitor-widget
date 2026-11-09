'use strict';
// OpenCode Go 订阅额度（账号级：5h 滚动 / 每周 / 每月，均为百分比）
// 用量端点与响应结构参考 cc-switch issue #6350：
//   GET https://opencode.ai/zen/go/v1/usage
//   Authorization: Bearer <key-or-token>   User-Agent: opencode/cli
//   → { usage: { rolling: {percent, resetsAt}, weekly: {...}, monthly: {...} } }
// OAuth 设备码流程（client_id=opencode-cli）见 src/main/opencode-auth.js

const { parseDateLoose, stateFor } = require('./types');

const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
const WINDOWS = [['rolling', '5小时'], ['weekly', '本周'], ['monthly', '本月']];

const id = 'opencode';
const name = 'OpenCode Go';

function parseUsage(json) {
  const u = (json && json.usage) || json || {};
  const items = [];
  for (const [key, label] of WINDOWS) {
    const w = u[key];
    if (!w || typeof w !== 'object') continue;
    const pct = Number(w.percent ?? w.usage_percent ?? w.usedPercent);
    if (!Number.isFinite(pct)) continue;
    items.push({
      key: 'usage.' + key,
      label,
      kind: 'percent',
      usedPct: pct,
      resetAt: parseDateLoose(w.resetsAt || w.reset_at || w.resetAt),
      sub: w.limit != null ? '上限 $' + w.limit : undefined,
    });
  }
  return { items };
}

async function fetchProvider(cfg, deps = {}) {
  const apiKey = String(cfg.apiKey || '').trim();
  let token = apiKey;
  let authMode = 'apikey';
  let note;

  if (cfg.mode === 'oauth' && typeof deps.ensureFreshToken === 'function') {
    try {
      token = await deps.ensureFreshToken();
      authMode = 'oauth';
    } catch (e) {
      if (!apiKey) return { id, name, ok: false, error: '登录已过期（' + e.message + '），请重新登录或改用 API Key', items: [] };
      token = apiKey;
      authMode = 'apikey';
      note = 'OAuth 刷新失败，已回退 API Key';
    }
  }
  if (!token) return { id, name, ok: false, error: '未登录且未配置 API Key', items: [] };

  const call = async (t) => {
    const headers = { Authorization: 'Bearer ' + t, 'User-Agent': 'opencode/cli' };
    if (cfg.orgId) headers['x-org-id'] = String(cfg.orgId);
    return fetch(USAGE_URL, { headers });
  };

  let res = await call(token);
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON */ }

  // OAuth token 被用量端点拒绝时自动回退到 API Key（cc-switch 已验证 key 可用）
  if (authMode === 'oauth' && (res.status === 401 || res.status === 403) && apiKey) {
    res = await call(apiKey);
    json = null;
    try { json = await res.json(); } catch { /* 非 JSON */ }
    authMode = 'apikey';
    note = 'OAuth 被用量端点拒绝，已回退 API Key';
  }

  if (!res.ok) {
    const msg = json && (json.message || json.error) ? String(json.message || json.error) : '';
    return { id, name, ok: false, error: 'HTTP ' + res.status + (msg ? '：' + msg.slice(0, 120) : ''), items: [] };
  }

  let parsed;
  try { parsed = parseUsage(json); } catch (e) {
    return { id, name, ok: false, error: '响应解析失败：' + e.message, items: [] };
  }
  if (!parsed.items.length) {
    return { id, name, ok: false, error: '响应中无额度数据（订阅是否生效？）', items: [] };
  }
  return { id, name, ok: true, error: null, items: parsed.items, note };
}

module.exports = { id, name, fetchProvider, parseUsage, USAGE_URL };
// stateFor 在此 re-export 供测试用例引用
module.exports.stateFor = stateFor;
