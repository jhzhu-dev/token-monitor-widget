'use strict';
// 设置窗口：读写配置 + OpenCode 登录状态流

const $ = (id) => document.getElementById(id);
let cfg = null;

// ---------- 载入 ----------
async function load() {
  cfg = await window.api.getConfig();
  $('refreshSec').value = String(cfg.refreshSec);
  $('threshold').value = String(cfg.threshold);
  $('autostart').checked = !!cfg.autostart;

  const zp = cfg.providers.zhipu || {};
  $('zhipuEnabled').checked = !!zp.enabled;
  $('zhipuKey').value = zp.apiKey || '';
  $('zhipuRegion').value = zp.region || 'cn';
  const zpMode = zp.mode === 'apikey' ? 'apikey' : 'login';
  $('zpModeLogin').checked = zpMode === 'login';
  $('zpModeKey').checked = zpMode === 'apikey';
  syncZhipuMode();
  renderZhipuAuth(zp.loggedIn ? 'ok' : 'idle');

  const oc = cfg.providers.opencode || {};
  $('ocEnabled').checked = !!oc.enabled;
  const mode = oc.mode === 'apikey' ? 'apikey' : 'oauth';
  $('ocModeOauth').checked = mode === 'oauth';
  $('ocModeKey').checked = mode === 'apikey';
  $('ocKey').value = oc.apiKey || '';
  syncMode();
  renderAuthState(oc.auth ? 'ok' : 'idle');

  const ds = cfg.providers.deepseek || {};
  $('dsEnabled').checked = !!ds.enabled;
  $('dsKey').value = ds.apiKey || '';
}

// ---------- 保存 ----------
async function save() {
  const patch = {
    refreshSec: Number($('refreshSec').value) || 60,
    threshold: clamp(Number($('threshold').value) || 80, 50, 95),
    autostart: $('autostart').checked,
    providers: {
      zhipu: {
        enabled: $('zhipuEnabled').checked,
        apiKey: $('zhipuKey').value.trim(),
        region: $('zhipuRegion').value,
        mode: $('zhipuRegion').value === 'global' ? 'apikey' : ($('zpModeLogin').checked ? 'login' : 'apikey'),
      },
      opencode: {
        enabled: $('ocEnabled').checked,
        mode: $('ocModeOauth').checked ? 'oauth' : 'apikey',
        apiKey: $('ocKey').value.trim(),
      },
      deepseek: {
        enabled: $('dsEnabled').checked,
        apiKey: $('dsKey').value.trim(),
      },
    },
  };
  $('btnSave').disabled = true;
  $('saveTip').textContent = '保存中…';
  try {
    await window.api.saveConfig(patch);
    $('saveTip').textContent = '已保存并刷新 ✓';
  } catch (e) {
    $('saveTip').textContent = '保存失败：' + e.message;
  } finally {
    $('btnSave').disabled = false;
    setTimeout(() => { $('saveTip').textContent = ''; }, 2500);
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ---------- OpenCode 登录 UI ----------
function syncMode() {
  $('oauthBlock').hidden = !$('ocModeOauth').checked;
  $('keyBlock').hidden = !$('ocModeKey').checked;
}

function renderAuthState(state, detail) {
  const el = $('ocAuthStatus');
  el.className = 'status';
  const hasAuth = cfg && cfg.providers.opencode && cfg.providers.opencode.auth;
  switch (state) {
    case 'idle':
      el.textContent = hasAuth ? '已登录 ✓（token 过期前自动续期）' : '未登录 —— 点击「登录」开始浏览器授权';
      if (hasAuth) el.classList.add('ok');
      $('ocLogoutBtn').hidden = !hasAuth;
      $('ocLoginBtn').textContent = hasAuth ? '重新登录' : '登录 OpenCode（浏览器授权）';
      break;
    case 'code':
      el.innerHTML = '请在浏览器完成授权，设备码：<code>' + esc(detail.userCode) + '</code> · 等待确认…' +
        (detail.uri ? '<br>若浏览器未打开，请手动访问：<span class="url">' + esc(detail.uri) + '</span>' : '');
      $('ocLoginBtn').disabled = true;
      $('ocLogoutBtn').hidden = true;
      break;
    case 'waiting':
      el.innerHTML = '等待浏览器授权确认… 设备码：<code>' + esc(detail.userCode) + '</code>';
      break;
    case 'success':
      el.classList.add('ok');
      el.textContent = '登录成功 ✓ 已保存 token';
      $('ocLoginBtn').disabled = false;
      $('ocLoginBtn').textContent = '重新登录';
      $('ocLogoutBtn').hidden = false;
      break;
    case 'error':
      el.classList.add('err');
      el.textContent = '登录失败：' + (detail || '未知错误');
      $('ocLoginBtn').disabled = false;
      $('ocLogoutBtn').hidden = !(hasAuth);
      break;
    case 'busy':
      el.textContent = '登录流程进行中…';
      break;
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 智谱登录 UI ----------
function syncZhipuMode() {
  const loginMode = $('zpModeLogin').checked;
  $('zpLoginBlock').hidden = !loginMode;
  $('zpKeyBlock').hidden = loginMode;
}

function renderZhipuAuth(state, detail) {
  const el = $('zpAuthStatus');
  el.className = 'status';
  const loggedIn = cfg && cfg.providers.zhipu && cfg.providers.zhipu.loggedIn;
  switch (state) {
    case 'idle':
    case 'ok':
      el.textContent = loggedIn ? '已登录 ✓（会话保存在本机）' : '未登录 —— 点击「登录智谱账号」打开登录窗口';
      if (loggedIn) el.classList.add('ok');
      $('zpLogoutBtn').hidden = !loggedIn;
      $('zpLoginBtn').textContent = loggedIn ? '重新登录' : '登录智谱账号（弹窗）';
      break;
    case 'window':
      el.textContent = '登录窗口已打开，请在窗口中完成登录（支持手机号/邮箱/扫码）…';
      $('zpLoginBtn').disabled = true;
      break;
    case 'success':
      el.classList.add('ok');
      el.textContent = '登录成功 ✓ 已开始拉取账号数据';
      $('zpLoginBtn').disabled = false;
      $('zpLogoutBtn').hidden = false;
      break;
    case 'closed':
      el.textContent = loggedIn ? '已登录 ✓（登录窗口已关闭）' : '登录窗口已关闭，未完成登录';
      if (loggedIn) el.classList.add('ok');
      $('zpLoginBtn').disabled = false;
      $('zpLogoutBtn').hidden = !loggedIn;
      break;
    case 'expired':
      el.classList.add('err');
      el.textContent = '登录已过期，请重新登录';
      $('zpLoginBtn').disabled = false;
      $('zpLogoutBtn').hidden = true;
      break;
    case 'error':
      el.classList.add('err');
      el.textContent = '登录失败：' + (detail || '未知错误');
      $('zpLoginBtn').disabled = false;
      break;
  }
}

// 密码框 显示/隐藏
function bindToggle(btnId, inputId) {
  $(btnId).addEventListener('click', () => {
    const inp = $(inputId);
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });
}

// ---------- 绑定 ----------
function bind() {
  $('ocModeOauth').addEventListener('change', syncMode);
  $('ocModeKey').addEventListener('change', syncMode);
  $('zpModeLogin').addEventListener('change', syncZhipuMode);
  $('zpModeKey').addEventListener('change', syncZhipuMode);
  $('zhipuRegion').addEventListener('change', () => {
    if ($('zhipuRegion').value === 'global') {
      $('zpModeKey').checked = true;
      syncZhipuMode();
    }
  });
  bindToggle('zhipuShow', 'zhipuKey');
  bindToggle('ocShow', 'ocKey');
  bindToggle('dsShow', 'dsKey');

  $('btnSave').addEventListener('click', save);
  $('ocLoginBtn').addEventListener('click', () => {
    // OAuth 模式无需先保存即可登录
    renderAuthState('busy');
    window.api.loginOpenCode();
  });
  $('ocLogoutBtn').addEventListener('click', async () => {
    await window.api.logoutOpenCode();
    if (cfg && cfg.providers.opencode) cfg.providers.opencode.auth = null;
    renderAuthState('idle');
  });
  $('zpLoginBtn').addEventListener('click', () => {
    renderZhipuAuth('window');
    window.api.loginZhipu();
  });
  $('zpLogoutBtn').addEventListener('click', async () => {
    renderZhipuAuth('window');
    await window.api.logoutZhipu();
    if (cfg && cfg.providers.zhipu) cfg.providers.zhipu.loggedIn = false;
    renderZhipuAuth('idle');
  });

  window.api.onZhipuAuth((msg) => renderZhipuAuth(msg.stage, msg.error));

  window.api.onOpenCodeAuth((msg) => {
    switch (msg.stage) {
      case 'code': renderAuthState('code', { userCode: msg.userCode }); break;
      case 'waiting': renderAuthState('waiting', { userCode: msg.userCode }); break;
      case 'success': renderAuthState('success'); break;
      case 'error': renderAuthState('error', msg.error); break;
      case 'busy': renderAuthState('busy'); break;
    }
  });

  // 小窗/托盘改了配置时同步本窗口并刷新登录状态展示
  window.api.onConfigChanged((c) => {
    cfg = c;
    renderZhipuAuth(c.providers.zhipu.loggedIn ? 'ok' : 'idle');
    renderAuthState('idle');
  });
}

(async function init() {
  bind();
  await load();
})();
