'use strict';
// 小窗渲染：进度条 / 金额 / 重置倒计时 / 24h sparkline / 折叠

const $ = (id) => document.getElementById(id);
const root = $('root');

let lastSnapshot = null;
let collapsed = false;
let sparkCache = new Map(); // providerId → 上次绘制数据，避免重复取历史// ---------- 工具 ----------
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtClock(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function fmtReset(resetAt, now) {
  if (!resetAt) return '';
  const diff = resetAt - now;
  if (diff <= 0) return '已重置';
  const m = Math.floor(diff / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h' + String(m % 60).padStart(2, '0') + 'm';
  return Math.floor(h / 24) + 'd' + String(h % 24).padStart(2, '0') + 'h';
}

function stateClass(pct) {
  if (!Number.isFinite(pct)) return 'unknown';
  if (pct >= 80) return 'err';
  if (pct >= 60) return 'warn';
  return 'ok';
}

// ---------- 渲染 ----------
function render(snap) {
  if (!snap) return;
  lastSnapshot = snap;
  const now = Date.now();

  $('updatedAt').textContent = '更新于 ' + fmtClock(snap.updatedAt);

  // 顶部状态点：任一 provider 报错 → 红点
  const anyErr = (snap.providers || []).some((p) => p.error);
  $('liveDot').className = 'dot' + (anyErr ? ' err' : '');

  const list = $('list');
  const html = [];
  for (const p of snap.providers || []) {
    html.push('<section class="sec" data-pid="' + esc(p.id) + '">');
    html.push('<div class="sec-head"><span class="sec-name">' + esc(p.name) + '</span>');
    if (p.note) html.push('<span class="sec-note">' + esc(p.note) + '</span>');
    html.push('</div>');
    if (p.error) html.push('<div class="err-line">' + esc(p.error) + '</div>');
    for (const it of p.items || []) html.push(renderItem(it, now));
    html.push('<canvas class="spark" width="276" height="26"></canvas>');
    html.push('</section>');
  }
  list.innerHTML = html.join('');
  // CSP 不允许内联 style 属性 → 由 JS 应用柱条宽度
  list.querySelectorAll('.bar-fill').forEach((el) => { el.style.width = el.dataset.w + '%'; });
  renderMini(snap);
  drawSparks();
}

function renderItem(it, now) {
  if (it.kind === 'percent') {
    const pct = it.usedPct;
    const cls = stateClass(pct);
    const sub = it.sub ? '<span>' + esc(it.sub) + '</span>' : '<span></span>';
    // 宽度经 data-w 由 JS 设置（CSP style-src 'self' 会剥离内联 style 属性）
    return '<div class="item">' +
      '<span class="item-label">' + esc(it.label) + '</span>' +
      '<div class="bar-wrap">' +
        '<div class="bar"><div class="bar-fill ' + cls + '" data-w="' + Math.max(0, Math.min(100, pct)) + '"></div></div>' +
        '<div class="meta">' + sub + '<span class="reset">' + (it.resetAt ? '↺ ' + fmtReset(it.resetAt, now) : '') + '</span></div>' +
      '</div>' +
      '<span class="pct ' + cls + '">' + Math.round(pct) + '%</span>' +
      '</div>';
  }
  // amount / text：主值 + 副说明右对齐两行，避免长文本截断
  const st = it.state === 'error' ? ' err' : '';
  return '<div class="item">' +
    '<span class="item-label">' + esc(it.label) + '</span>' +
    '<span class="spacer"></span>' +
    '<span class="val-col">' +
      '<span class="value' + st + '">' + esc(it.amountText || it.amountNum || '') + '</span>' +
      (it.sub ? '<span class="sub">' + esc(it.sub) + '</span>' : '') +
    '</span>' +
    '</div>';
}

// 收起条：按平台徽章化展示关键数字（智谱/OC 取 5h 窗口百分比，DS 取余额）
const CHIP_META = {
  zhipu: { cls: 'c-zhipu', name: '智谱' },
  opencode: { cls: 'c-opencode', name: 'OC' },
  deepseek: { cls: 'c-deepseek', name: 'DS' },
};
function renderMini(snap) {
  const parts = [];
  for (const p of snap.providers || []) {
    const meta = CHIP_META[p.id] || { cls: '', name: p.name.slice(0, 2) };
    // 出错且无任何数据 → 徽章红色 !
    if (p.error && !(p.items || []).length) {
      parts.push('<span class="chip ' + meta.cls + '"><span class="n">' + esc(meta.name) + '</span><span class="v err">!</span></span>');
      continue;
    }
    const pct = (p.items || []).find((i) => i.kind === 'percent');
    if (pct) {
      const cls = stateClass(pct.usedPct);
      parts.push('<span class="chip ' + meta.cls + '"><span class="n">' + esc(meta.name) + '</span><span class="v ' + cls + '">' + Math.round(pct.usedPct) + '%</span></span>');
      continue;
    }
    const amt = (p.items || []).find((i) => i.amountText);
    if (amt) {
      const cls = amt.state === 'error' ? 'err' : 'ok';
      parts.push('<span class="chip ' + meta.cls + '"><span class="n">' + esc(meta.name) + '</span><span class="v ' + cls + '">' + esc(amt.amountText) + '</span></span>');
    }
  }
  $('miniText').innerHTML = parts.join('');
}

// ---------- 24h sparkline ----------
// 只画主指标（第一个 percent 条目；无 percent 则第一个 amount 条目），避免不同窗口混在一条曲线里
function primaryKey(p) {
  if (!p) return null;
  const pctItem = (p.items || []).find((i) => i.kind === 'percent');
  if (pctItem) return { key: pctItem.key, isAmount: false };
  const amt = (p.items || []).find((i) => i.amountNum != null);
  return amt ? { key: amt.key, isAmount: true } : null;
}

async function drawSparks() {
  const secs = document.querySelectorAll('.sec[data-pid]');
  for (const sec of secs) {
    const pid = sec.dataset.pid;
    const primary = primaryKey((lastSnapshot.providers || []).find((x) => x.id === pid));
    let rows = [];
    if (primary) {
      const all = sparkCache.has(pid) ? sparkCache.get(pid) : await window.api.getHistory(pid).catch(() => []);
      sparkCache.set(pid, all);
      rows = all.filter((r) => r.key === primary.key && (r.pct != null || r.amount != null));
    }
    drawSpark(sec.querySelector('canvas.spark'), rows, primary && primary.isAmount);
  }
}

function drawSpark(canvas, rows, isAmount) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const pts = rows.map((r) => ({ t: r.t, v: r.pct != null ? r.pct : r.amount }))
    .sort((a, b) => a.t - b.t);
  if (pts.length < 2) {
    ctx.fillStyle = 'rgba(255,255,255,0.30)';
    ctx.font = '9px "Segoe UI", sans-serif';
    ctx.fillText('24h 曲线 · 数据积累中', 4, H - 8);
    return;
  }
  let min = Math.min(...pts.map((p) => p.v)), max = Math.max(...pts.map((p) => p.v));
  if (isAmount) { const pad = (max - min) * 0.15 || max * 0.1 || 1; min -= pad; max += pad; }
  else { min = Math.min(min, 0); max = Math.max(max, 100); }
  const t0 = pts[0].t, t1 = Math.max(pts[pts.length - 1].t, t0 + 1);
  const X = (t) => ((t - t0) / (t1 - t0)) * (W - 4) + 2;
  const Y = (v) => H - 4 - ((v - min) / (max - min || 1)) * (H - 8);

  const last = pts[pts.length - 1].v;
  const color = isAmount ? '#6ea8fe' : (last >= 80 ? '#f87171' : last >= 60 ? '#fbbf24' : '#34d399');

  // 渐变填充
  ctx.beginPath();
  ctx.moveTo(X(pts[0].t), Y(pts[0].v));
  for (const p of pts) ctx.lineTo(X(p.t), Y(p.v));
  ctx.lineTo(X(pts[pts.length - 1].t), H - 2);
  ctx.lineTo(X(pts[0].t), H - 2);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, color + '33');
  grad.addColorStop(1, color + '05');
  ctx.fillStyle = grad;
  ctx.fill();

  // 折线
  ctx.beginPath();
  ctx.moveTo(X(pts[0].t), Y(pts[0].v));
  for (const p of pts) ctx.lineTo(X(p.t), Y(p.v));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // 末点
  ctx.beginPath();
  ctx.arc(X(pts[pts.length - 1].t), Y(last), 2, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

// ---------- 折叠 / 交互 ----------
async function setCollapsed(v) {
  collapsed = v;
  root.className = v ? 'collapsed' : 'expanded';
  $('btnCollapse').textContent = v ? '▴' : '▾';
  $('btnCollapse').title = v ? '展开' : '折叠';
  try { await window.api.setCollapsed(v); } catch { /* ignore */ }
}

function bindUI() {
  $('btnCollapse').addEventListener('click', () => setCollapsed(!collapsed));
  // 双击标题栏也可切换折叠（拖动与双击不冲突）
  $('header').addEventListener('dblclick', () => setCollapsed(!collapsed));
  $('btnRefresh').addEventListener('click', async () => {
    $('btnRefresh').classList.add('spin');
    sparkCache.clear();
    try { await window.api.refreshNow(); } finally { setTimeout(() => $('btnRefresh').classList.remove('spin'), 700); }
  });
  $('btnSettings').addEventListener('click', () => window.api.openSettings());
}

// 定时刷新倒计时 + 倒计时文案每秒走动
setInterval(() => {
  if (!lastSnapshot) return;
  const now = Date.now();
  // 重置倒计时文案刷新（不重建 DOM，只更新 .reset 文本）
  document.querySelectorAll('.sec').forEach((sec) => {
    const pid = sec.dataset.pid;
    const p = (lastSnapshot.providers || []).find((x) => x.id === pid);
    if (!p) return;
    const nodes = sec.querySelectorAll('.item');
    (p.items || []).forEach((it, i) => {
      if (it.kind !== 'percent' || !it.resetAt || !nodes[i]) return;
      const r = nodes[i].querySelector('.reset');
      if (r) r.textContent = '↺ ' + fmtReset(it.resetAt, now);
    });
  });
}, 1000);

// ---------- 启动 ----------
(async function init() {
  bindUI();
  window.api.onSnapshot((snap) => { sparkCache.clear(); render(snap); });
  const cfg = await window.api.getConfig().catch(() => null);
  if (cfg) {
    if (cfg.collapsed) setCollapsed(true);
    $('nextIn').textContent = '每 ' + cfg.refreshSec + 's 自动刷新';
    window.api.onConfigChanged((c) => { $('nextIn').textContent = '每 ' + c.refreshSec + 's 自动刷新'; });
  }
  const snap = await window.api.getSnapshot();
  render(snap);
  window.api.ready(); // 通知主进程渲染完成（截图自验用）
})();
