'use strict';
// 解析器单测（纯 Node，无网络）：fixtures 按调研到的真实响应结构内联
// 运行：npm test

const assert = require('assert');
const T = require('../src/providers/types');
const zhipu = require('../src/providers/zhipu');
const opencode = require('../src/providers/opencode');
const deepseek = require('../src/providers/deepseek');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.log('  ✗', name, '\n    ', e.message); }
}

console.log('== types ==');
ok('parseDateLoose: ISO 带时区', () => {
  assert.strictEqual(T.parseDateLoose('2026-11-09T20:00:00Z'), Date.parse('2026-11-09T20:00:00Z'));
});
ok('parseDateLoose: "YYYY-MM-DD HH:mm:ss" 按本地时区', () => {
  const got = T.parseDateLoose('2026-11-09 20:00:00');
  const exp = Date.parse('2026-11-09T20:00:00');
  assert.strictEqual(got, exp);
});
ok('parseDateLoose: 秒级时间戳 ×1000', () => {
  assert.strictEqual(T.parseDateLoose(1762708800), 1762708800000);
});
ok('parseDateLoose: 空值 → null', () => {
  assert.strictEqual(T.parseDateLoose(''), null);
  assert.strictEqual(T.parseDateLoose(null), null);
});
ok('formatTokens: 万/亿/k', () => {
  assert.strictEqual(T.formatTokens(1234567), '123.5万');
  assert.strictEqual(T.formatTokens(123456789), '1.23亿');
  assert.strictEqual(T.formatTokens(1500), '1.5k');
  assert.strictEqual(T.formatTokens(42), '42');
});
ok('formatAmount: 千分位与币种', () => {
  assert.strictEqual(T.formatAmount(86.4, 'CNY'), '¥86.40');
  assert.strictEqual(T.formatAmount(1234.5, 'USD'), '$1,234.50');
});
ok('countdown: 分/时/天', () => {
  const now = Date.now();
  assert.strictEqual(T.countdown(now + 45 * 60000, now), '45m');
  assert.strictEqual(T.countdown(now + 2 * 3600e3 + 13 * 60000, now), '2h13m');
  assert.strictEqual(T.countdown(now + 3 * 86400e3, now), '3d00h');
  assert.strictEqual(T.countdown(now - 1, now), '已重置');
});
ok('stateFor: 阈值分档', () => {
  assert.strictEqual(T.stateFor(30), 'ok');
  assert.strictEqual(T.stateFor(65), 'warn');
  assert.strictEqual(T.stateFor(85), 'error');
  assert.strictEqual(T.stateFor(NaN), 'unknown');
});
ok('deepPick: 嵌套字段别名深搜', () => {
  const json = { code: 200, data: { account: { availableBalance: '86.42', rechargeAmount: '500' } } };
  assert.strictEqual(T.deepPick(json, ['availableBalance', 'balance']), 86.42);
});
ok('envelopeOk: success/code 双风格', () => {
  assert.ok(T.envelopeOk({ success: true }));
  assert.ok(T.envelopeOk({ code: 200, data: {} }));
  assert.ok(!T.envelopeOk({ code: 1002, msg: '无效的key' }));
  assert.ok(!T.envelopeOk(null));
});

console.log('== zhipu ==');
ok('parseQuota: level + 双窗口 limits', () => {
  const json = {
    success: true,
    data: {
      level: 'pro',
      limits: [
        { type: 'TOKENS_LIMIT', percentage: 42.5, nextResetTime: '2026-11-09 20:00:00' },
        { type: 'TOKENS_LIMIT', percentage: 18, nextResetTime: '2026-11-16 00:00:00' },
      ],
    },
  };
  const { items, level } = zhipu.parseQuota(json);
  assert.strictEqual(level, 'PRO');
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].usedPct, 42.5);
  assert.strictEqual(items[0].kind, 'percent');
  assert.ok(items[0].resetAt);
  assert.match(items[1].label, /套餐额度/);
});
ok('parseReport: availableBalance + 赠金，忽略累计充值', () => {
  const json = {
    code: 200,
    data: { account: { availableBalance: '86.42', rechargeAmount: '500.00', giveAmount: '10.00' } },
  };
  const { items } = zhipu.parseReport(json);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].label, '现金余额');
  assert.strictEqual(items[0].amountText, '¥86.42');
  assert.match(items[0].sub, /赠金 ¥10\.00/);
});
ok('parsePackages: 过滤过期包，TOKENS 单位', () => {
  const json = {
    code: 200,
    data: {
      rows: [
        { resourcePackageName: 'GLM-4.6包', consumeType: 'TOKENS', availableBalance: 1500000, status: 'EFFECTIVE', expireTime: '2026-12-31 00:00:00' },
        { resourcePackageName: '过期包', consumeType: 'TOKENS', availableBalance: 999999, status: 'EXPIRED' },
        { resourcePackageName: '次数包', consumeType: 'TIMES', remainAmount: 88, status: 'ACTIVE' },
      ],
    },
  };
  const { items } = zhipu.parsePackages(json);
  assert.strictEqual(items.length, 2);
  assert.match(items[0].amountText, /万 tokens/);
  assert.match(items[0].sub, /到期/);
  assert.match(items[1].amountText, /次/);
});
ok('baseUrl: cn/global 站点切换', () => {
  assert.strictEqual(zhipu.baseUrl('cn'), 'https://open.bigmodel.cn');
  assert.strictEqual(zhipu.baseUrl('global'), 'https://api.z.ai');
});
ok('parseCreditLimits: CREDIT_LIMIT 窗口按重置时间排序（v5 真实结构）', () => {
  const data = {
    level: 'pro',
    limits: [
      { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 60000, currentValue: 28923, remaining: 31076, percentage: 48, nextResetTime: 1794273521978 },
      { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 12000, currentValue: 2169, remaining: 9830, percentage: 18, nextResetTime: 1794219247616 },
    ],
  };
  const { items } = zhipu.parseCreditLimits(data);
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].label, '5小时');
  assert.strictEqual(items[0].usedPct, 18);
  assert.strictEqual(items[0].resetAt, 1794219247616);
  assert.match(items[0].sub, /2,169\/12,000 积分/);
  assert.match(items[0].sub, /余 9,830/);
  assert.strictEqual(items[1].label, '本周');
  assert.strictEqual(items[1].usedPct, 48);
});
ok('parseConsoleContext: 只输出限额窗口条目（忽略套餐/余额/Key 明细）', () => {
  const raw = {
    quota: JSON.stringify({ code: 200, success: true, data: { level: 'pro', limits: [
      { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 12000, currentValue: 2169, remaining: 9830, percentage: 18, nextResetTime: 1794219247616 },
      { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 60000, currentValue: 28923, remaining: 31076, percentage: 48, nextResetTime: 1794273521978 },
    ] } }),
    sub: JSON.stringify({ code: 200, data: [{ productName: 'GLM Coding Pro', status: 'VALID', valid: '2026-12-09 10:00:00-2027-03-09 10:00:00' }] }),
    report: JSON.stringify({ code: 200, success: true, data: { balance: 0E-9, rechargeAmount: 150.0, giveAmount: 0.180985, availableBalance: 0E-9 } }),
    keys: JSON.stringify({ total: 10, data: [
      { apiKey: '6338fb5fadfd483fb86381d87b8e8c89', name: '默认项目(265036)', lastUseTime: '2026-07-07' },
    ] }),
  };
  const r = zhipu.parseConsoleContext(raw);
  assert.ok(r.authOk);
  const labels = r.items.map((i) => i.label);
  assert.deepStrictEqual(labels, ['5小时', '本周']);
  for (const notWant of ['当前套餐', '现金余额', 'API Keys']) {
    assert.ok(!labels.includes(notWant), '不应出现 ' + notWant);
  }
});
ok('parseConsoleContext: quota 鉴权失败 → authOk=false', () => {
  const raw = { quota: '{"code":1001,"msg":"Header中未收到Authorization参数"}', sub: '{}', report: '{}', keys: '{}' };
  const r = zhipu.parseConsoleContext(raw);
  assert.strictEqual(r.authOk, false);
});

console.log('== opencode ==');
ok('parseUsage: rolling/weekly/monthly 三窗口', () => {
  const json = {
    usage: {
      rolling: { percent: 12.4, resetsAt: '2026-11-09T20:00:00Z' },
      weekly: { percent: 25, resetsAt: '2026-11-13T00:00:00Z' },
      monthly: { percent: 9, resetsAt: '2026-11-30T00:00:00Z' },
    },
  };
  const { items } = opencode.parseUsage(json);
  assert.strictEqual(items.length, 3);
  assert.deepStrictEqual(items.map((i) => i.label), ['5小时', '本周', '本月']);
  assert.strictEqual(items[0].usedPct, 12.4);
  assert.ok(items[0].resetAt);
});
ok('parseUsage: 缺窗口时跳过', () => {
  const { items } = opencode.parseUsage({ usage: { rolling: { percent: 5, resetsAt: '2026-11-09T20:00:00Z' } } });
  assert.strictEqual(items.length, 1);
});
ok('parseUsage: 非法 percent 跳过不抛错', () => {
  const { items } = opencode.parseUsage({ usage: { rolling: { percent: 'abc' } } });
  assert.strictEqual(items.length, 0);
});

console.log('== deepseek ==');
ok('parseBalance: 余额 + 赠金说明', () => {
  const json = {
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '86.42', granted_balance: '10.00', topped_balance: '76.42' }],
  };
  const { items } = deepseek.parseBalance(json);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].amountText, '¥86.42');
  assert.match(items[0].sub, /赠金 ¥10\.00/);
});
ok('parseBalance: is_available=false → error 状态', () => {
  const json = { is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0.00' }] };
  const { items } = deepseek.parseBalance(json);
  assert.strictEqual(items[0].state, 'error');
});
ok('parseBalance: 无 balance_infos → 空数组', () => {
  assert.deepStrictEqual(deepseek.parseBalance({}).items, []);
});
ok('computeConsumption: 常规消耗 = 基线 - 当前', () => {
  const rows = [
    { t: 1000, amount: 100 }, { t: 2000, amount: 95.5 }, { t: 3000, amount: 90.2 },
  ];
  const r = deepseek.computeConsumption(rows);
  assert.strictEqual(r.consumption, 9.8);
  assert.strictEqual(r.toppedUp, false);
  assert.strictEqual(r.points, 3);
});
ok('computeConsumption: 充值后余额上升 → 净消耗 0 + toppedUp 标记', () => {
  const rows = [{ t: 1000, amount: 90 }, { t: 2000, amount: 190 }];
  const r = deepseek.computeConsumption(rows);
  assert.strictEqual(r.consumption, 0);
  assert.strictEqual(r.toppedUp, true);
});
ok('computeConsumption: 少于 2 条记录 → null（统计中）', () => {
  const r = deepseek.computeConsumption([{ t: 1000, amount: 100 }]);
  assert.strictEqual(r.consumption, null);
  assert.strictEqual(r.points, 1);
  assert.deepStrictEqual(deepseek.computeConsumption([]), { consumption: null, toppedUp: false, points: 0 });
});
ok('computeConsumption: 乱序输入自动排序', () => {
  const r = deepseek.computeConsumption([{ t: 3000, amount: 80 }, { t: 1000, amount: 100 }]);
  assert.strictEqual(r.consumption, 20);
});

console.log('\n结果:', pass, '通过,', fail, '失败');
process.exit(fail ? 1 : 0);
