'use strict';
// OpenCode Console OAuth 设备码流程（RFC 8626）
// 端点与 client_id 参考 pi-opencode-zen (MIT, https://github.com/Naab2k3/pi-opencode-zen)：
//   POST https://opencode.ai/console/auth/device/code  body {client_id: "opencode-cli"}
//   POST https://opencode.ai/console/auth/device/token
//     轮询 grant_type=urn:ietf:params:oauth:grant-type:device_code
//     刷新 grant_type=refresh_token
// 注意：token 端点可能对轮询错误返回 HTTP 400，需读 JSON body 判断

const DEVICE_CODE_URL = 'https://opencode.ai/console/auth/device/code';
const DEVICE_TOKEN_URL = 'https://opencode.ai/console/auth/device/token';
const CLIENT_ID = 'opencode-cli';
const USER_AGENT = 'opencode/cli';
const SLOW_DOWN_PENALTY_MS = 5000;
// 提前 5 分钟视为过期，主动刷新
const EXPIRE_EARLY_MS = 5 * 60 * 1000;

async function postForm(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, json };
}

// 实测响应的 verification_uri 是相对路径（如 "/console/device"），
// 必须拼接域名成绝对 URL，否则 shell.openExternal 会当文件路径打开资源管理器
function absUrl(u) {
  if (typeof u !== 'string' || !u.trim()) return null;
  const s = u.trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('/')) return 'https://opencode.ai' + s;
  return null;
}

async function requestDeviceCode() {
  const { status, json } = await postForm(DEVICE_CODE_URL, { client_id: CLIENT_ID });
  if (status !== 200 || !json || !json.device_code) {
    throw new Error('获取设备码失败 HTTP ' + status + (json && json.error ? '：' + json.error : ''));
  }
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: absUrl(json.verification_uri) || 'https://opencode.ai/console/device',
    verificationUriComplete: absUrl(json.verification_uri_complete),
    interval: Math.max(1, Number(json.interval) || 5),
    expiresIn: Number(json.expires_in) || 600,
  };
}

// 轮询 token 端点直到授权成功/拒绝/超时。onStage 用于向设置窗口回传进度。
async function pollForToken(dc, onStage = () => {}) {
  const deadline = Date.now() + dc.expiresIn * 1000;
  let interval = dc.interval * 1000;
  onStage({ stage: 'waiting', userCode: dc.userCode });
  while (Date.now() < deadline) {
    await sleep(interval);
    const { status, json } = await postForm(DEVICE_TOKEN_URL, {
      client_id: CLIENT_ID,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: dc.deviceCode,
    });
    const err = json && json.error;
    if (json && json.access_token) {
      return toAuth(json);
    }
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') { interval += SLOW_DOWN_PENALTY_MS; continue; }
    if (err === 'access_denied') throw new Error('你在浏览器中拒绝了授权');
    if (err === 'expired_token') throw new Error('设备码已过期，请重新登录');
    // 意外错误（允许 HTTP 400 携带 JSON body）
    if (status !== 200 && status !== 400) throw new Error('轮询失败 HTTP ' + status);
    if (err && err !== 'authorization_pending') throw new Error('授权错误：' + err);
  }
  throw new Error('授权超时，请重试');
}

async function refreshAuth(refreshToken) {
  const { status, json } = await postForm(DEVICE_TOKEN_URL, {
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  if (!json || !json.access_token) {
    const err = new Error('刷新失败 HTTP ' + status + (json && json.error ? '：' + json.error : ''));
    err.expired = err.expired || json && ['invalid_grant', 'expired_token'].includes(json.error);
    throw err;
  }
  return toAuth(json);
}

// 过期前 5 分钟自动刷新；不可刷新（invalid_grant）时抛错由上层要求重新登录
async function ensureFresh(auth) {
  if (!auth || !auth.accessToken) throw new Error('未登录');
  if (auth.expiresAt - Date.now() > EXPIRE_EARLY_MS) return auth.accessToken;
  if (!auth.refreshToken) throw new Error('缺少 refresh token，请重新登录');
  const fresh = await refreshAuth(auth.refreshToken);
  // 服务端可能不返回新 refresh_token：沿用旧的
  if (!fresh.refreshToken) fresh.refreshToken = auth.refreshToken;
  Object.assign(auth, fresh);
  return auth.accessToken;
}

function toAuth(json) {
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || null,
    // expires_in 默认保守 10 分钟；提前 5 分钟过期
    expiresAt: Date.now() + (Number(json.expires_in) || 600) * 1000 - EXPIRE_EARLY_MS,
    userCode: null,
  };
}

// 多工作区：GET /console/api/orgs
async function listOrgs(accessToken) {
  const res = await fetch('https://opencode.ai/console/api/orgs', {
    headers: { Authorization: 'Bearer ' + accessToken, 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) return [];
  let json = null;
  try { json = await res.json(); } catch { return []; }
  const arr = Array.isArray(json) ? json : json && (json.orgs || json.data || json.items);
  return Array.isArray(arr) ? arr : [];
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = {
  requestDeviceCode, pollForToken, refreshAuth, ensureFresh, listOrgs,
  DEVICE_CODE_URL, DEVICE_TOKEN_URL,
};
