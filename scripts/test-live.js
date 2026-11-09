'use strict';
// 真实端点连通性冒烟测试（无需任何凭证）
// 预期：余额/额度端点对无鉴权请求返回 401/403 或鉴权错误信封；
//       OpenCode 设备码端点无需登录即可签发 device_code（验证设备码流程可用）
// 运行：npm run test:live

const ocAuth = require('../src/main/opencode-auth');

const CHECKS = [
  ['DeepSeek 余额端点', 'GET https://api.deepseek.com/user/balance', async () => {
    const r = await fetch('https://api.deepseek.com/user/balance', { headers: { Accept: 'application/json' } });
    return `HTTP ${r.status}（预期 401）→ ${r.status === 401 ? 'PASS' : 'CHECK'}`;
  }],
  ['智谱 套餐额度端点', 'GET https://open.bigmodel.cn/api/monitor/usage/quota/limit', async () => {
    const r = await fetch('https://open.bigmodel.cn/api/monitor/usage/quota/limit', { headers: { Accept: 'application/json' } });
    let body = '';
    try { body = JSON.stringify(await r.json()).slice(0, 80); } catch { /* */ }
    return `HTTP ${r.status}（预期 401/403 或错误信封）${body ? ' ' + body : ''}`;
  }],
  ['智谱 账户报表端点', 'GET https://open.bigmodel.cn/api/biz/account/query-customer-account-report', async () => {
    const r = await fetch('https://open.bigmodel.cn/api/biz/account/query-customer-account-report', { headers: { Accept: 'application/json' } });
    return `HTTP ${r.status}（预期 401/403 或错误信封）`;
  }],
  ['OpenCode 用量端点', 'GET https://opencode.ai/zen/go/v1/usage', async () => {
    const r = await fetch('https://opencode.ai/zen/go/v1/usage', { headers: { 'User-Agent': 'opencode/cli' } });
    return `HTTP ${r.status}（预期 401）`;
  }],
  ['OpenCode 设备码端点', 'POST https://opencode.ai/console/auth/device/code', async () => {
    const dc = await ocAuth.requestDeviceCode();
    const masked = dc.deviceCode ? dc.deviceCode.slice(0, 4) + '…' : 'N/A';
    return `签发成功 device_code=${masked} user_code=${dc.userCode} interval=${dc.interval}s → 设备码流程可用`;
  }],
];

(async () => {
  console.log('真实端点连通性测试（无凭证）\n');
  let hardFail = 0;
  for (const [name, target, fn] of CHECKS) {
    try {
      const msg = await fn();
      console.log(`  ● ${name}\n    ${target}\n    ${msg}\n`);
    } catch (e) {
      // 设备码端点必须成功，其余端点网络层异常才算硬失败
      const isHard = name.includes('设备码');
      if (isHard) hardFail++;
      console.log(`  ● ${name}\n    ${target}\n    ${isHard ? '✗ FAIL' : '⚠ 网络异常'}：${e.message}\n`);
    }
  }
  if (hardFail) {
    console.log('设备码端点不可达 —— OpenCode 登录功能依赖它，请检查网络/代理。');
    process.exit(1);
  }
  console.log('完成：带真实凭证的端到端验证请在设置窗口填入 Key 后观察小窗数据。');
})();
