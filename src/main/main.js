'use strict';
// Electron 主进程：小窗 / 设置窗 / 托盘 / 定时刷新 / IPC / 通知 / 历史 / OpenCode 登录编排
// 自验模式：electron . --screenshot  → 渲染完成后截图保存到 screenshots/ 并退出（无需人工操作）

const {
  app, BrowserWindow, Tray, Menu, nativeImage,
  ipcMain, shell, Notification, screen,
} = require('electron');
const path = require('path');
const fs = require('fs');

const configStore = require('./config');
const history = require('./history');
const { NotifyCenter } = require('./notify');
const ocAuth = require('./opencode-auth');
const zhipuAuth = require('./zhipu-auth');

const pZhipu = require('../providers/zhipu');
const pOpenCode = require('../providers/opencode');
const pDeepseek = require('../providers/deepseek');
const pDemo = require('../providers/demo');
const { formatAmount } = require('../providers/types');
const icons = require('./icons');

const APP_ID = 'com.zai.token-monitor-widget';
const WIDGET_W = 300;
const WIDGET_H = 400;
const WIDGET_H_COLLAPSED = 46;

const shotMode = process.argv.includes('--screenshot');
const shotDir = path.join(__dirname, '..', '..', 'screenshots');

let cfg;                       // 配置（内存主副本）
let widgetWin = null;
let settingsWin = null;
let tray = null;
let isQuitting = false;
let lastSnapshot = null;
let timer = null;
let nextAt = 0;
let refreshing = false;
let loginInFlight = false;
let moveSaveTimer = null;
const notifier = new NotifyCenter();

// ---------- 工具 ----------
function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  new Notification({ title, body, silent: false, icon: nativeImage.createFromBuffer(iconBuf(icons.tray32)) }).show();
}

function iconBuf(b64) { return Buffer.from(b64, 'base64'); }

function saveCfg() {
  configStore.save(app.getPath('userData'), cfg);
}

function applyAutostart() {
  try {
    app.setLoginItemSettings({ openAtLogin: !!cfg.autostart, args: [] });
  } catch { /* 某些环境受限，忽略 */ }
}

// ---------- 刷新与快照 ----------
async function refreshAll() {
  if (refreshing) return;
  refreshing = true;
  try {
    let providers;
    if (shotMode) {
      providers = pDemo.fetchProvider(); // 仅截图自验用模拟数据
    } else {
      const jobs = [];
      if (cfg.providers.zhipu.enabled) {
        const zc = cfg.providers.zhipu;
        const useSession = zc.mode !== 'apikey' && zc.region !== 'global' && !!zc.loggedIn;
        jobs.push(pZhipu.fetchProvider(zc, useSession ? { sessionFetch: zhipuAuth.sessionFetch } : {}));
      }
      if (cfg.providers.opencode.enabled) {
        jobs.push(pOpenCode.fetchProvider(cfg.providers.opencode, {
          ensureFreshToken: ensureOpenCodeToken,
        }));
      }
      if (cfg.providers.deepseek.enabled) jobs.push(pDeepseek.fetchProvider(cfg.providers.deepseek));
      providers = await Promise.all(jobs);
      // 智谱会话确证失效（JWT 缺失/被拒）→ 落盘标记并提示重新登录
      const zp = providers.find((p) => p.id === 'zhipu');
      if (zp && zp.authLost) {
        cfg.providers.zhipu.loggedIn = false;
        saveCfg();
        broadcast('config-changed', cfg);
        broadcast('zhipu:auth', { stage: 'expired' });
      }
    }

    const now = Date.now();
    lastSnapshot = { updatedAt: now, providers, demo: false };

    // 历史记录（曲线）、DeepSeek 用量推导与阈值告警
    const records = [];
    for (const p of providers) {
      for (const it of p.items || []) {
        const rec = { t: now, provider: p.id, key: it.key };
        if (it.kind === 'percent') rec.pct = it.usedPct;
        if (it.amountNum != null) rec.amount = it.amountNum;
        records.push(rec);
      }
    }
    try {
      history.append(app.getPath('userData'), records);
      attachDeepseekUsage(providers, now);
    } catch { /* 忽略 */ }
    notifier.update(providers, cfg.threshold, notify);
  } catch (e) {
    lastSnapshot = {
      updatedAt: Date.now(),
      providers: [{ id: 'internal', name: '内部错误', ok: false, error: e.message, items: [] }],
      demo: false,
    };
  } finally {
    refreshing = false;
    broadcast('snapshot', lastSnapshot);
  }
}

function scheduleRefresh(immediateMs = 0) {
  if (timer) clearTimeout(timer);
  nextAt = Date.now() + (immediateMs || cfg.refreshSec * 1000);
  timer = setTimeout(async () => {
    await refreshAll();
    scheduleRefresh();
  }, immediateMs || cfg.refreshSec * 1000);
}

// DeepSeek 用量：官方无用量端点，用近 24h 余额历史推导消耗
// 在 history.append 之后调用（当前记录已入史，基线仍取窗口内最早一条）
function attachDeepseekUsage(providers, now) {
  const p = (providers || []).find((x) => x.id === 'deepseek');
  if (!p) return;
  const balItem = (p.items || []).find((i) => i.key.startsWith('balance.') && i.amountNum != null);
  if (!balItem) return;
  const rows = history.query(app.getPath('userData'), 'deepseek', now - 24 * 3600e3)
    .filter((r) => r.key === balItem.key && Number.isFinite(r.amount));
  const { consumption, toppedUp, points } = pDeepseek.computeConsumption(rows);
  // 去掉旧的推导行，追加最新（放余额之后）
  p.items = (p.items || []).filter((i) => i.key !== 'usage.24h');
  p.items.push({
    key: 'usage.24h',
    label: '近24h消耗',
    kind: 'amount',
    amountText: points >= 2 ? formatAmount(consumption, balItem.currency) : '—',
    sub: points < 2 ? '统计中（需≥2次刷新）' : toppedUp ? '期间有充值，按净消耗计' : undefined,
    state: 'ok',
  });
}

async function ensureOpenCodeToken() {
  const auth = cfg.providers.opencode.auth;
  if (!auth || !auth.accessToken) throw new Error('未登录');
  const before = auth.accessToken;
  const token = await ocAuth.ensureFresh(auth);
  if (auth.accessToken !== before) saveCfg(); // 刷新后落盘
  return token;
}

// ---------- 窗口 ----------
function clampIntoWorkArea(win) {
  const wa = screen.getPrimaryDisplay().workArea;
  const [x, y] = win.getPosition();
  const [w, h] = win.getSize();
  const nx = Math.max(wa.x, Math.min(x != null ? x : wa.x + wa.width - w - 40, wa.x + wa.width - w));
  const ny = Math.max(wa.y, Math.min(y != null ? y : wa.y + Math.floor(wa.height / 3), wa.y + wa.height - h));
  win.setPosition(nx, ny);
}

const SNAP_PX = 28; // 距边缘小于该值时吸附

// 贴边：把窗口吸附到当前所在显示器工作区的最近边缘
function snapToEdges(win) {
  try {
    const [x, y] = win.getPosition();
    const [w, h] = win.getSize();
    const wa = screen.getDisplayMatching({ x, y, width: w, height: h }).workArea;
    let nx = x, ny = y;
    if (Math.abs(x - wa.x) < SNAP_PX) nx = wa.x;
    else if (Math.abs(x + w - (wa.x + wa.width)) < SNAP_PX) nx = wa.x + wa.width - w;
    if (Math.abs(y - wa.y) < SNAP_PX) ny = wa.y;
    else if (Math.abs(y + h - (wa.y + wa.height)) < SNAP_PX) ny = wa.y + wa.height - h;
    if (nx !== x || ny !== y) win.setPosition(nx, ny);
    return [nx, ny];
  } catch { return win.getPosition(); }
}

function createWidget() {
  widgetWin = new BrowserWindow({
    width: WIDGET_W,
    height: cfg.collapsed ? WIDGET_H_COLLAPSED : WIDGET_H,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  widgetWin.setAlwaysOnTop(true, 'screen-saver');
  widgetWin.loadFile(path.join(__dirname, '..', 'renderer', 'widget', 'index.html'));

  widgetWin.once('ready-to-show', () => {
    clampIntoWorkArea(widgetWin);
    if (!shotMode) widgetWin.show();
    else widgetWin.showInactive();
  });

  // 贴边吸附 + 位置持久化（拖动结束后节流保存；snap 幂等不会自触发循环）
  widgetWin.on('moved', () => {
    snapToEdges(widgetWin);
    if (moveSaveTimer) clearTimeout(moveSaveTimer);
    moveSaveTimer = setTimeout(() => {
      const [x, y] = widgetWin.getPosition();
      cfg.window.x = x; cfg.window.y = y;
      saveCfg();
    }, 500);
  });

  // 关窗 = 隐藏到托盘，真正的退出走托盘菜单
  widgetWin.on('close', (e) => {
    if (!isQuitting && !shotMode) {
      e.preventDefault();
      widgetWin.hide();
    }
  });

  // 恢复持久化位置
  if (cfg.window.x != null && cfg.window.y != null) {
    widgetWin.setPosition(cfg.window.x, cfg.window.y);
  }
}

function getSettingsWin() {
  if (settingsWin && !settingsWin.isDestroyed()) return settingsWin;
  settingsWin = new BrowserWindow({
    width: 460,
    height: 660,
    title: 'Token 监控 · 设置',
    frame: false,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    resizable: false,
    show: false,
    icon: nativeImage.createFromBuffer(iconBuf(icons.app64)),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings', 'settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => { settingsWin = null; });
  return settingsWin;
}

// ---------- 托盘 ----------
function createTray() {
  const img = nativeImage.createFromBuffer(iconBuf(icons.tray16));
  tray = new Tray(img);
  const menu = Menu.buildFromTemplate([
    { label: '显示 / 隐藏小窗', click: () => toggleWidget() },
    { label: '设置…', click: () => getSettingsWin() },
    { label: '立即刷新', click: () => refreshAll() },
    { type: 'separator' },
    { label: '窗口置顶', type: 'checkbox', checked: true, click: (mi) => widgetWin && widgetWin.setAlwaysOnTop(mi.checked, 'screen-saver') },
    { label: '开机自启', type: 'checkbox', checked: !!cfg.autostart, click: (mi) => { cfg.autostart = mi.checked; saveCfg(); applyAutostart(); broadcast('config-changed', cfg); } },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setToolTip('Token 套餐监控');
  tray.setContextMenu(menu);
  tray.on('click', () => toggleWidget());
}

function toggleWidget() {
  if (!widgetWin) return;
  if (widgetWin.isVisible()) widgetWin.hide();
  else { widgetWin.show(); widgetWin.focus(); }
}

// ---------- OpenCode 登录 ----------
function sendAuth(payload) { broadcast('opencode:auth', payload); }

async function loginOpenCode() {
  if (loginInFlight) { sendAuth({ stage: 'busy' }); return; }
  loginInFlight = true;
  try {
    const dc = await ocAuth.requestDeviceCode();
    const link = dc.verificationUriComplete || dc.verificationUri;
    sendAuth({ stage: 'code', userCode: dc.userCode, uri: link });
    if (/^https?:\/\//i.test(link)) {
      try { await shell.openExternal(link); }
      catch { /* 打开浏览器失败也继续，设置窗口已显示链接 */ }
    }
    const auth = await ocAuth.pollForToken(dc, (s) => sendAuth(s));
    // 自动抓取 org（订阅挂在 org 下时，用量请求需带 x-org-id；用户手动填过则不覆盖）
    try {
      const orgs = await ocAuth.listOrgs(auth.accessToken);
      if (orgs.length && !cfg.providers.opencode.orgId) {
        const oid = orgs[0].id || orgs[0].org_id || orgs[0].orgId;
        if (oid) cfg.providers.opencode.orgId = String(oid);
      }
    } catch { /* org 获取失败不影响登录 */ }
    cfg.providers.opencode.auth = auth;
    saveCfg();
    sendAuth({ stage: 'success' });
    refreshAll();
  } catch (e) {
    sendAuth({ stage: 'error', error: e.message });
  } finally {
    loginInFlight = false;
  }
}

// ---------- 智谱登录 ----------
function sendZhipu(payload) { broadcast('zhipu:auth', payload); }

function loginZhipu() {
  sendZhipu({ stage: 'window' });
  zhipuAuth.openLoginWindow({
    onSuccess: async () => {
      // 立即验证会话可用（隐藏窗口取数）
      const ok = await zhipuAuth.probeSession();
      if (ok) {
        cfg.providers.zhipu.loggedIn = true;
        cfg.providers.zhipu.mode = 'login';
        saveCfg();
        sendZhipu({ stage: 'success' });
        broadcast('config-changed', cfg);
        refreshAll();
      } else {
        sendZhipu({ stage: 'error', error: '登录后数据探测失败，请重试或改用 API Key' });
      }
    },
    onClosed: () => sendZhipu({ stage: 'closed' }),
  });
}

async function logoutZhipu() {
  cfg.providers.zhipu.loggedIn = false;
  saveCfg();
  await zhipuAuth.logout();
  broadcast('config-changed', cfg);
  refreshAll();
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('get-snapshot', () => lastSnapshot);
  ipcMain.handle('get-config', () => cfg);
  ipcMain.handle('save-config', async (e, patch) => {
    cfg = configStore.deepMerge(cfg, patch);
    saveCfg();
    applyAutostart();
    scheduleRefresh(300); // 保存后立即刷新
    await refreshAll();
    broadcast('config-changed', cfg);
    return cfg;
  });
  ipcMain.handle('refresh-now', async () => { await refreshAll(); scheduleRefresh(); return lastSnapshot; });
  ipcMain.handle('set-collapsed', (e, v) => {
    cfg.collapsed = !!v;
    saveCfg();
    if (widgetWin && !widgetWin.isDestroyed()) {
      widgetWin.setSize(WIDGET_W, v ? WIDGET_H_COLLAPSED : WIDGET_H);
      clampIntoWorkArea(widgetWin);
    }
    return cfg.collapsed;
  });
  ipcMain.handle('open-settings', () => getSettingsWin());
  ipcMain.handle('history:get', (e, providerId) => {
    return history.query(app.getPath('userData'), providerId, Date.now() - 24 * 3600e3);
  });
  ipcMain.handle('opencode:login', () => { loginOpenCode(); return true; });
  ipcMain.handle('opencode:logout', () => {
    cfg.providers.opencode.auth = null;
    saveCfg();
    refreshAll();
    return true;
  });
  ipcMain.handle('zhipu:login', () => { loginZhipu(); return true; });
  ipcMain.handle('zhipu:logout', () => { logoutZhipu(); return true; });
  ipcMain.handle('quit-app', () => { isQuitting = true; app.quit(); });
  ipcMain.on('renderer-ready', () => { if (shotMode) doScreenshot(); });
}

// ---------- 自验截图 ----------
async function doScreenshot() {
  try {
    fs.mkdirSync(shotDir, { recursive: true });
    await sleep(900); // 等快照渲染/曲线绘制
    const img = await widgetWin.webContents.capturePage();
    fs.writeFileSync(path.join(shotDir, 'widget.png'), img.toPNG());
    console.log('[shot] widget saved');
    if (process.argv.includes('--screenshot-settings')) {
      getSettingsWin();
      await sleep(1500);
      const img2 = await settingsWin.webContents.capturePage();
      fs.writeFileSync(path.join(shotDir, 'settings.png'), img2.toPNG());
      console.log('[shot] settings saved');
    }
  } catch (e) {
    console.error('[shot] failed:', e.message);
  } finally {
    app.exit(0);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------- 启动 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (widgetWin) { widgetWin.show(); widgetWin.focus(); }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId(APP_ID); // Windows 通知需要
    if (shotMode) {
      // 截图自验用临时 userData，不读写真实配置/历史
      const tmp = path.join(app.getPath('temp'), 'token-monitor-shot-' + Date.now());
      fs.mkdirSync(tmp, { recursive: true });
      app.setPath('userData', tmp);
    }
    cfg = configStore.load(app.getPath('userData'));
    if (shotMode) {
      if (process.argv.includes('--collapsed')) cfg.collapsed = true;
    } else {
      // 恢复智谱登录态：持久分区里若会话仍有效，自动置回 loggedIn
      const zc = cfg.providers.zhipu;
      if (zc.mode !== 'apikey' && zc.region !== 'global' && !zc.loggedIn && !zc.apiKey) {
        const ok = await zhipuAuth.probeSession();
        zc.loggedIn = ok;
        if (ok) { saveCfg(); broadcast('config-changed', cfg); broadcast('zhipu:auth', { stage: 'ok' }); }
      }
    }
    applyAutostart();
    registerIpc();
    createWidget();
    createTray();
    await refreshAll();
    scheduleRefresh();
  });

  app.on('window-all-closed', () => {
    // 托盘常驻：不随窗口关闭退出（截图模式除外）
    if (shotMode) app.quit();
  });
}
