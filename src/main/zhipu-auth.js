'use strict';
// 智谱账号登录：内嵌浏览器登录 Coding Plan 控制台（bigmodel.cn），会话存持久分区（persist:zhipu）
// 取数通道（v5 调试已验证）：
//   登录后 cookie 里有 JWT（bigmodel_token_production）；
//   在 bigmodel.cn 页面上下文中带 Authorization: <JWT> 调用控制台接口
//   （页面上下文自带瑞数 WAF cookie，主进程直连会被 WAF 拦）。
// 接口：/api/monitor/usage/quota/limit（CREDIT_LIMIT 窗口）、/api/biz/subscription/list、
//       /api/biz/account/query-customer-account-report、/api/biz/v1/organization/{org}/projects/{proj}/api_keys

const { BrowserWindow, session } = require('electron');

const PARTITION = 'persist:zhipu';
// Coding Plan 个人总览页（未登录会跳转到登录页，登录后回到此页）
const HOME = 'https://bigmodel.cn/coding-plan/personal/overview';
// JWT 所在 cookie 名
const TOKEN_COOKIE = 'bigmodel_token_production';

// 页面上下文里提取 JWT cookie（用 split 而非正则：模板字符串转义易错，
// 且 document.cookie 的顺序不保证，正则若只匹配开头会漏）
// 注意：注入脚本内用局部变量持有 cookie 名，避免模板插值变成裸标识符
const PROBE_JS = `
(function () {
  var NAME = '${TOKEN_COOKIE}';
  var parts = document.cookie.split(';');
  var jwt = '';
  for (var i = 0; i < parts.length; i++) {
    var kv = parts[i].trim();
    if (kv.indexOf(NAME + '=') === 0) jwt = decodeURIComponent(kv.slice(NAME.length + 1));
  }
  if (!jwt) return 'NOJWT';
  return fetch('/api/monitor/usage/quota/limit', {
    credentials: 'include',
    headers: { Accept: 'application/json', Authorization: jwt },
  }).then(function (r) { return r.text(); })
    .then(function (t) {
      try { var j = JSON.parse(t); return j && (j.success === true || Number(j.code) === 200) ? 'OK' : 'NOAUTH'; }
      catch (e) { return 'NOAUTH'; }
    })
    .catch(function () { return 'ERR'; });
})()
`;

// 取数：读 JWT → 并行调 4 个接口，返回原始文本
const FETCH_JS = `
(function () {
  var NAME = '${TOKEN_COOKIE}';
  var parts = document.cookie.split(';');
  var jwt = '';
  for (var i = 0; i < parts.length; i++) {
    var kv = parts[i].trim();
    if (kv.indexOf(NAME + '=') === 0) jwt = decodeURIComponent(kv.slice(NAME.length + 1));
  }
  if (!jwt) return Promise.resolve({ noJwt: true });
  var org = '', proj = '';
  try { org = localStorage.getItem('Bigmodel-Organization') || ''; } catch (e) {}
  try { proj = localStorage.getItem('Bigmodel-Project') || ''; } catch (e) {}
  var get = function (u) {
    return fetch(u, { credentials: 'include', headers: { Accept: 'application/json', Authorization: jwt } })
      .then(function (r) { return r.text(); })
      .catch(function (e) { return JSON.stringify({ code: 0, msg: String(e) }); });
  };
  var urls = {
    quota: '/api/monitor/usage/quota/limit',
    sub: '/api/biz/subscription/list?pageNum=1&pageSize=5',
    report: '/api/biz/account/query-customer-account-report',
    keys: '/api/biz/v1/organization/' + org + '/projects/' + proj + '/api_keys?keyType=1&usageScene=1&pageNum=1&pageSize=20',
  };
  return Promise.all(Object.keys(urls).map(function (k) { return get(urls[k]); }))
    .then(function (rs) { return { quota: rs[0], sub: rs[1], report: rs[2], keys: rs[3] }; });
})()
`;

function zhipuSession() {
  return session.fromPartition(PARTITION);
}

function withTimeout(promise, ms, tag) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(tag + ' 超时')), ms)),
  ]);
}

// ---------- 登录窗口 ----------
function openLoginWindow({ onSuccess, onClosed }) {
  const win = new BrowserWindow({
    width: 1080,
    height: 760,
    title: '登录智谱（Coding Plan 控制台）',
    autoHideMenuBar: true,
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(HOME);

  let done = false;
  const finish = (ok) => {
    if (done) return;
    done = true;
    clearInterval(poller);
    if (ok) { try { win.close(); } catch { /* */ } onSuccess && onSuccess(); }
    else onClosed && onClosed();
  };

  const poller = setInterval(async () => {
    if (win.isDestroyed()) return finish(false);
    try {
      const url = win.webContents.getURL();
      if (!/^https?:\/\/[^/]*bigmodel\.cn/i.test(url)) return; // 还在第三方 SSO 域，等跳回
      const r = await withTimeout(win.webContents.executeJavaScript(PROBE_JS, true), 10000, '探测');
      if (r === 'OK') finish(true);
    } catch { /* 页面跳转中执行失败，下轮再试 */ }
  }, 2500);

  win.on('closed', () => finish(false));
}

// ---------- 隐藏取数窗口 ----------
let fetchWin = null;
let inFlight = null;

function ensureFetchWin() {
  if (fetchWin && !fetchWin.isDestroyed()) return fetchWin;
  fetchWin = new BrowserWindow({
    show: false,
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false },
  });
  fetchWin.on('closed', () => { fetchWin = null; });
  // 阻止隐藏窗口弹出新窗/导航到外域
  fetchWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return fetchWin;
}

// 返回 { quota, sub, report, keys }（各接口原始文本）；未登录时 { noJwt: true }
async function sessionFetch() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const win = ensureFetchWin();
    await withTimeout(win.loadURL(HOME), 20000, '页面加载');
    await sleep(1500); // 等 WAF 挑战/前端初始化落地
    return await withTimeout(win.webContents.executeJavaScript(FETCH_JS, true), 20000, '接口请求');
  })().finally(() => { inFlight = null; });
  return inFlight;
}

// 会话是否仍有效（探测 JWT + quota 信封成功）
async function probeSession() {
  try {
    const raw = await sessionFetch();
    if (!raw || raw.noJwt) return false;
    const j = JSON.parse(raw.quota);
    return j && (j.success === true || Number(j.code) === 200);
  } catch { return false; }
}

function logout() {
  try { if (fetchWin && !fetchWin.isDestroyed()) fetchWin.destroy(); } catch { /* */ }
  fetchWin = null;
  return zhipuSession().clearStorageData();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { openLoginWindow, sessionFetch, probeSession, logout, PARTITION };
