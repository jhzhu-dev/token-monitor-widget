'use strict';
// 智谱 GLM 开放平台（账号级数据：套餐额度 / 现金余额 / 资源包）
// 两种接入：
//   login  —— 账号登录（main 侧 zhipu-auth 持久会话，同源 fetch，仅 cn 站）
//   apikey —— 开放平台 API Key（Bearer 优先，失败裸 key 重试；cn/global 通用）
// 参考：https://github.com/xian4840-cloud/token-lens  https://github.com/farion1231/cc-switch

const {
  parseDateLoose, formatAmount, formatTokens,
  deepPick, firstNumber, envelopeOk, envelopeMsg,
} = require('./types');

const BASES = { cn: 'https://open.bigmodel.cn', global: 'https://api.z.ai' };
// 部分接口失败时 HTTP 仍 200，真实错误码在 JSON code 里
const AUTH_FAIL_CODES = new Set([401, 403, 1000, 1001, 1002, 1004]);
const LIMIT_TYPE_LABELS = { TOKENS_LIMIT: '套餐额度', PROMPT_LIMIT: '提示词额度' };

// [字段名, 汇总标签, 路径]
const ENDPOINTS = [
  ['quota', '套餐额度', '/api/monitor/usage/quota/limit'],
  ['report', '现金余额', '/api/biz/account/query-customer-account-report'],
  ['packs', '资源包', '/api/biz/tokenAccounts/list/my'],
];

const id = 'zhipu';
const name = '智谱 Coding Plan';

function baseUrl(region) {
  return BASES[region === 'global' ? 'global' : 'cn'];
}

// ---------- API Key 传输 ----------
// 智谱认证两种风格并存（Bearer / 裸 key），先 Bearer，判定为鉴权失败则裸 key 重试
async function authedGet(url, apiKey) {
  let res = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: 'Bearer ' + apiKey },
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON */ }
  const code = json ? Number(json.code) : NaN;
  const authFail =
    res.status === 401 || res.status === 403 ||
    (json && AUTH_FAIL_CODES.has(code));
  if (authFail) {
    res = await fetch(url, {
      headers: { Accept: 'application/json', Authorization: apiKey },
    });
    json = null;
    try { json = await res.json(); } catch { /* 非 JSON */ }
  }
  if (!res.ok) {
    const err = new Error('HTTP ' + res.status + (json && envelopeMsg(json) ? '：' + envelopeMsg(json) : ''));
    err.authFail = authFail || res.status === 401 || res.status === 403;
    throw err;
  }
  if (json && !envelopeOk(json)) {
    const msg = envelopeMsg(json) || 'code ' + json.code;
    const err = new Error(msg);
    err.authFail = AUTH_FAIL_CODES.has(Number(json.code));
    throw err;
  }
  return json;
}

// ---------- 登录会话通道（deps.sessionFetch 由 main 提供，v5 调试验证的真实结构） ----------
// 控制台（bigmodel.cn + JWT cookie）返回的是 CREDIT_LIMIT 窗口（额度制，含绝对数值），
// 与开放平台 API Key 模式的 TOKENS_LIMIT（纯百分比）不同，分开解析。
function fmtInt(n) {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString('en-US');
}

const UNIT_LABELS = { 3: '5小时', 6: '本周' };

function parseCreditLimits(data) {
  const limits = Array.isArray(data && data.limits) ? data.limits : [];
  const level = data && data.level ? String(data.level).toUpperCase() : '';
  const items = limits
    .filter((l) => l && Number.isFinite(Number(l.percentage)))
    .map((l, i) => {
      const used = Number(l.currentValue);
      const total = Number(l.usage);
      const remain = Number(l.remaining);
      const unit = Number(l.unit);
      return {
        key: 'w' + i + '.' + unit,
        label: UNIT_LABELS[unit] || (l.type === 'CREDIT_LIMIT' ? '额度窗口 ' + (i + 1) : String(l.type)),
        kind: 'percent',
        usedPct: Number(l.percentage),
        resetAt: Number(l.nextResetTime) || null,
        sub: Number.isFinite(used) && Number.isFinite(total)
          ? fmtInt(used) + '/' + fmtInt(total) + ' 积分' + (Number.isFinite(remain) ? ' · 余 ' + fmtInt(remain) : '')
          : (level ? '套餐 ' + level : undefined),
      };
    })
    .sort((a, b) => (a.resetAt || 0) - (b.resetAt || 0));
  return { items, level };
}

// raw: { quota, sub, report, keys } 各接口原始 JSON 文本
// 展示策略：只输出限额用量窗口（5小时/本周），套餐/余额/Key 明细不展示
function parseConsoleContext(raw) {
  const items = [];
  let authOk = false;

  // 套餐额度（CREDIT_LIMIT）
  try {
    const j = JSON.parse(raw.quota);
    if (j && (j.success === true || Number(j.code) === 200)) {
      authOk = true;
      items.push(...parseCreditLimits(j.data || {}).items);
    }
  } catch { /* 响应异常 → authOk=false */ }

  return { items, errors: [], authOk };
}

// ---------- 统一聚合（API Key 模式） ----------
function aggregate(results, region) {
  const items = [];
  const errors = [];
  const parsers = {
    quota: (j) => parseQuota(j, region).items,
    report: (j) => parseReport(j, region).items,
    packs: (j) => parsePackages(j, region).items,
  };
  for (const r of results) {
    if (!r.error && r.json) {
      try { items.push(...parsers[r.field](r.json)); continue; }
      catch (e) { errors.push(r.label + '解析失败：' + e.message); continue; }
    }
    errors.push(r.label + '：' + (r.error || '未知错误'));
  }
  const authFailed = results.length > 0 && results.every((r) => r.authFail);
  const error = errors.length ? (authFailed ? 'Key 无效或已过期（' + errors[0] + '…）' : errors.join('；')) : null;
  return { items, error, authFailed };
}

async function fetchProvider(cfg, deps = {}) {
  const region = cfg.region === 'global' ? 'global' : 'cn';
  const key = String(cfg.apiKey || '').trim();
  const useSession = cfg.mode !== 'apikey' && region === 'cn' && typeof deps.sessionFetch === 'function';

  // 登录模式：页面会话取数（CREDIT_LIMIT 结构），失败且有 Key 则回退 API Key 通道
  if (useSession) {
    let raw = null;
    let sessionErr = null;
    try { raw = await deps.sessionFetch(); }
    catch (e) { sessionErr = e.message; }
    if (raw && !raw.noJwt) {
      const r = parseConsoleContext(raw);
      if (r.authOk) {
        return {
          id, name, ok: r.items.length > 0,
          error: r.errors.length ? r.errors.join('；') : null,
          items: r.items, note: '账号登录',
        };
      }
      // quota 鉴权失败 → 会话过期（配了 Key 则落到下方回退）
      if (!key) {
        return { id, name, ok: false, authLost: true, error: '登录已过期，请到设置重新登录智谱账号', items: [] };
      }
    } else if (!key) {
      // raw 为 null 是暂时性错误（页面加载超时等），不视为登录失效，保住 loggedIn 标志
      const noJwt = !!(raw && raw.noJwt);
      return {
        id, name, ok: false, authLost: noJwt,
        error: noJwt
          ? '登录已过期，请到设置重新登录智谱账号'
          : '登录会话暂时不可用（' + (sessionErr || '超时') + '），下次刷新重试',
        items: [],
      };
    }
  }

  if (!key) {
    const msg = cfg.mode !== 'apikey'
      ? '未登录智谱账号 —— 打开设置点击「登录智谱账号」'
      : '未配置 API Key';
    return { id, name, ok: false, error: msg, items: [] };
  }

  const settled = await Promise.allSettled(
    ENDPOINTS.map(([field, , path]) => authedGet(baseUrl(region) + path, key))
  );
  const results = settled.map((s, i) => {
    const [field, label] = [ENDPOINTS[i][0], ENDPOINTS[i][1]];
    if (s.status === 'fulfilled') return { field, label, json: s.value, error: null, authFail: false };
    return { field, label, json: null, error: s.reason && s.reason.message, authFail: !!(s.reason && s.reason.authFail) };
  });
  const agg = aggregate(results, region);
  return { id, name, ok: agg.items.length > 0, error: agg.error, items: agg.items };
}

// ---------- 解析器（两种传输共用） ----------
// GET /api/monitor/usage/quota/limit → { success, data: { level, limits: [{type, percentage, nextResetTime}] } }
function parseQuota(json, region = 'cn') {
  const data = (json && json.data) || {};
  const level = data.level ? String(data.level).toUpperCase() : '';
  const limits = Array.isArray(data.limits) ? data.limits : [];
  const cur = region === 'global' ? 'USD' : 'CNY';
  const counts = {};
  const items = limits.map((l, i) => {
    const type = l.type || (l.limitType || 'TOKENS_LIMIT');
    counts[type] = (counts[type] || 0) + 1;
    const base = LIMIT_TYPE_LABELS[String(type)] || String(type);
    // 多个同类型条目（如 5h 与周窗口分开返回）时加序号区分
    const label = limits.length > 1 && counts[type] > 1 ? base + ' ' + counts[type] : base;
    const pct = firstNumber(l.percentage, l.percent, l.usedPercentage);
    if (pct == null) return null;
    return {
      key: 'quota' + i + '.' + String(type),
      label,
      kind: 'percent',
      usedPct: pct,
      resetAt: parseDateLoose(l.nextResetTime || l.resetTime),
      sub: level ? '套餐 ' + level : undefined,
      currencyNote: cur,
    };
  }).filter(Boolean);
  return { items, level };
}

// GET /api/biz/account/query-customer-account-report → availableBalance（注意 rechargeAmount 是累计充值）
const BALANCE_ALIASES = [
  'availableBalance', 'balance', 'cashBalance', 'cash_balance',
  'rechargeBalance', 'chargeBalance', 'toppedUpBalance', 'topped_up_balance',
];
function parseReport(json, region = 'cn') {
  const cur = region === 'global' ? 'USD' : 'CNY';
  const available = deepPick(json, BALANCE_ALIASES);
  if (available == null) return { items: [] };
  const gift = deepPick(json, ['voucherBalance', 'giftBalance', 'grantedBalance', 'bonusBalance', 'giveAmount']);
  const items = [{
    key: 'cash',
    label: '现金余额',
    kind: 'amount',
    amountNum: available,
    amountText: formatAmount(available, cur),
    currency: cur,
    sub: gift != null && gift > 0 ? '赠金 ' + formatAmount(gift, cur) : undefined,
    state: available > 0 ? 'ok' : 'error',
  }];
  return { items };
}

// GET /api/biz/tokenAccounts/list/my → rows[]（状态 EFFECTIVE/ACTIVE 有效）
const PKG_VALUE_ALIASES = ['availableBalance', 'tokenBalance', 'remainAmount', 'balance', 'amount', 'tokens'];
const PKG_NAME_ALIASES = ['resourcePackageName', 'packageName', 'name', 'suitableModel', 'suitableScene', 'tokenNo'];
function parsePackages(json, region = 'cn') {
  const cur = region === 'global' ? 'USD' : 'CNY';
  const d = json && json.data;
  const rows = (json && json.rows)
    || (Array.isArray(d) ? d : null)
    || (d && (d.rows || d.list || d.records || d.items))
    || [];
  if (!Array.isArray(rows)) return { items: [] };
  const items = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const st = String(r.status || r.state || 'EFFECTIVE').toUpperCase();
    if (st && !['EFFECTIVE', 'ACTIVE', 'NORMAL', 'VALID'].includes(st)) continue;
    let val = firstNumber(...PKG_VALUE_ALIASES.map((k) => r[k]));
    if (val == null) continue;
    const mag = firstNumber(r.tokensMagnitude, r.magnitude);
    if (mag != null && mag > 1) val *= mag;
    const pkgName = PKG_NAME_ALIASES.map((k) => r[k]).find((v) => v) || '资源包';
    const consume = String(r.consumeType || r.unit || 'TOKENS').toUpperCase();
    let text;
    if (consume === 'TIMES') text = formatTokens(val) + ' 次';
    else if (consume === 'AMOUNT' || consume === 'CASH') text = formatAmount(val, cur);
    else text = formatTokens(val) + ' tokens';
    const expire = parseDateLoose(r.expireTime || r.validEnd || r.endTime);
    items.push({
      key: 'pkg.' + (r.tokenNo || r.bundleNo || pkgName),
      label: String(pkgName).slice(0, 24),
      kind: consume === 'AMOUNT' || consume === 'CASH' ? 'amount' : 'text',
      amountNum: val,
      amountText: text,
      currency: consume === 'AMOUNT' || consume === 'CASH' ? cur : undefined,
      sub: expire ? '到期 ' + new Date(expire).toISOString().slice(0, 10) : undefined,
      state: val > 0 ? 'ok' : 'error',
    });
  }
  return { items: items.slice(0, 8) };
}

module.exports = {
  id, name, fetchProvider,
  parseQuota, parseReport, parsePackages, baseUrl, aggregate,
  parseCreditLimits, parseConsoleContext, ENDPOINTS,
};
