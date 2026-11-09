'use strict';
// 调试 v6【生产路径验证】：直接调用生产模块 zhipu-auth.sessionFetch + zhipu.fetchProvider，
// 用已保存的登录会话走完整取数链路（与应用运行时完全相同的代码）
// 运行：先退出主应用，然后 npx electron scripts/debug-zhipu-session.js

const { app } = require('electron');
const path = require('path');

const za = require('../src/main/zhipu-auth');
const zp = require('../src/providers/zhipu');

app.whenReady().then(async () => {
  try {
    app.setPath('userData', path.join(process.env.APPDATA || '', 'token-monitor-widget'));
  } catch (e) { console.log('[warn] setPath:', e.message); }
  setTimeout(() => { console.log('[timeout-forced-exit]'); app.exit(2); }, 90000);

  console.log('--- 1) probeSession（生产登录探测） ---');
  try {
    const ok = await za.probeSession();
    console.log('probeSession =', ok);
  } catch (e) { console.log('probeSession 异常:', e.message); }

  console.log('\n--- 2) sessionFetch（生产取数，原始返回） ---');
  try {
    const raw = await za.sessionFetch();
    if (!raw || raw.noJwt) {
      console.log('noJwt =', !!(raw && raw.noJwt), '→ 未登录/cookie 未取到');
    } else {
      for (const k of ['quota', 'sub', 'report', 'keys']) {
        const t = String(raw[k] || '');
        console.log('\n[' + k + '] ' + t.replace(/\s+/g, ' ').slice(0, 260));
      }
    }
  } catch (e) { console.log('sessionFetch 异常:', e.message); }

  console.log('\n--- 3) fetchProvider（生产解析，最终展示条目） ---');
  try {
    const r = await zp.fetchProvider(
      { mode: 'login', region: 'cn', apiKey: '' },
      { sessionFetch: za.sessionFetch }
    );
    console.log('ok=' + r.ok + '  error=' + (r.error || '无') + '  note=' + (r.note || ''));
    for (const it of r.items) {
      const pct = it.kind === 'percent' ? ' ' + Math.round(it.usedPct) + '%' : '';
      console.log('  - ' + it.label + ' | ' + (it.amountText || '') + pct + (it.sub ? ' | ' + it.sub : ''));
    }
  } catch (e) { console.log('fetchProvider 异常:', e.message); }

  app.exit(0);
});
