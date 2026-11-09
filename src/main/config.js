'use strict';
// 配置持久化：%APPDATA%\token-monitor-widget\config.json
// 注意：API Key / OAuth token 明文存于用户目录（仅本机），v1 接受此权衡

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  refreshSec: 60,           // 刷新间隔（秒）
  threshold: 80,            // 告警阈值（已用百分比）
  autostart: false,         // 开机自启
  collapsed: false,         // 小窗是否折叠
  window: { x: null, y: null }, // 窗口位置持久化
  providers: {
    zhipu:    { enabled: true, apiKey: '', region: 'cn', mode: 'login', loggedIn: false },
    opencode: { enabled: true, mode: 'oauth', apiKey: '', orgId: '', auth: null },
    deepseek: { enabled: true, apiKey: '' },
  },
};

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const k of Object.keys(patch || {})) {
    const pv = patch[k];
    if (isPlainObject(pv) && isPlainObject(out[k])) out[k] = deepMerge(out[k], pv);
    else if (pv !== undefined) out[k] = pv;
  }
  return out;
}

function load(userDataDir) {
  const file = path.join(userDataDir, 'config.json');
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* 首次运行或损坏 → 用默认 */ }
  return deepMerge(DEFAULTS, saved);
}

function save(userDataDir, cfg) {
  const file = path.join(userDataDir, 'config.json');
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
}

module.exports = { DEFAULTS, load, save, deepMerge };
