'use strict';
// 演示模式：无凭证时用模拟数据渲染，便于验收 UI / 测试告警与曲线
// 数据做缓慢随机游走，让 24h 曲线和状态色变化可观察

const { formatAmount, formatTokens } = require('./types');

const id = 'demo';

// 简单随机游走：向 target 缓慢漂移并叠加小抖动
function walk(state, target, step) {
  state.v += (Math.random() - 0.5) * step + (target - state.v) * 0.05;
  return state.v;
}

const S = {
  zp5h: { v: 42 }, zpWeek: { v: 18 }, cash: { v: 86.42 },
  ocRoll: { v: 14 }, ocWeek: { v: 31 }, ocMonth: { v: 9 },
  ds: { v: 120.55 }, pkg: { v: 1234567 }, dsUse: { v: 12.3 },
};

function section(pid, pname, items) {
  return { id: pid, name: pname, ok: true, error: null, items };
}

function fetchProvider() {
  const zp5h = Math.max(2, Math.min(98, walk(S.zp5h, 55, 6)));
  const zpWeek = Math.max(2, Math.min(98, walk(S.zpWeek, 22, 3)));
  const cash = Math.max(1, walk(S.cash, 60, 1.5));
  const ocRoll = Math.max(2, Math.min(98, walk(S.ocRoll, 35, 8)));
  const ocWeek = Math.max(2, Math.min(98, walk(S.ocWeek, 40, 4)));
  const ocMonth = Math.max(2, Math.min(98, walk(S.ocMonth, 15, 2)));
  const ds = Math.max(1, walk(S.ds, 90, 1));
  const pkg = Math.max(1000, S.pkg.v - Math.random() * 4000);

  const now = Date.now();
  const in5h = now + 3 * 3600e3 + 13 * 60e3;
  const inWeek = now + 2 * 86400e3 + 4 * 3600e3;
  const inMonth = now + 18 * 86400e3;

  return [
    section('zhipu', '智谱 Coding Plan', [
      { key: 'quota0', label: '5小时', kind: 'percent', usedPct: zp5h, resetAt: in5h, sub: Math.round(zp5h * 120) + '/12,000 积分' },
      { key: 'quota1', label: '本周', kind: 'percent', usedPct: zpWeek, resetAt: inWeek, sub: Math.round(zpWeek * 600) + '/60,000 积分' },
    ]),
    section('opencode', 'OpenCode Go', [
      { key: 'usage.rolling', label: '5小时', kind: 'percent', usedPct: ocRoll, resetAt: in5h },
      { key: 'usage.weekly', label: '本周', kind: 'percent', usedPct: ocWeek, resetAt: inWeek },
      { key: 'usage.monthly', label: '本月', kind: 'percent', usedPct: ocMonth, resetAt: inMonth },
    ]),
    section('deepseek', 'DeepSeek', [
      { key: 'balance.0', label: '账户余额', kind: 'amount', amountNum: ds, amountText: formatAmount(ds, 'CNY'), sub: '其中赠金 ' + formatAmount(10, 'CNY'), state: 'ok' },
      { key: 'usage.24h', label: '近24h消耗', kind: 'amount', amountText: formatAmount(walk(S.dsUse, 12, 0.8), 'CNY'), state: 'ok' },
    ]),
  ];
}

module.exports = { id, name: '演示数据', fetchProvider };
