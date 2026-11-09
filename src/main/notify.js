'use strict';
// 阈值告警：percent 条目越过阈值时弹系统通知
// 去重键 = provider:item:resetAt（或当日桶），每窗口每次重置周期只弹一次
// 启动后首次观察即超阈值也告警一次（避免重启后沉默），靠去重键防重复

const { countdown } = require('../providers/types');

class NotifyCenter {
  constructor() {
    this.notified = new Set();   // "id:key:bucket" → 已通知
    this.seen = new Set();       // 观察过的条目（用于计算"越过"）
  }

  // snapshot.providers: [{id, name, items: [...]}]
  update(providers, threshold, show) {
    const fired = [];
    for (const p of providers || []) {
      for (const item of p.items || []) {
        if (item.kind !== 'percent' || !Number.isFinite(item.usedPct)) continue;
        const bucket = item.resetAt || 'day-' + new Date().toISOString().slice(0, 10);
        const dedupKey = p.id + ':' + item.key + ':' + bucket;
        const over = item.usedPct >= threshold;
        const prevOver = this.seen.has(dedupKey + '#over');
        this.seen.add(dedupKey + '#over');

        if (!over) continue;
        if (this.notified.has(dedupKey)) continue;
        // 已观察过且此前未超阈值 → 是真正的"越过"时刻；首次观察即超阈值也通知一次
        this.notified.add(dedupKey);
        const left = item.resetAt ? countdown(item.resetAt) : null;
        const body = '已用 ' + Math.round(item.usedPct) + '%' +
          (left && left !== '已重置' ? '，' + left + '后重置' : '') + '（阈值 ' + threshold + '%）';
        fired.push({ title: p.name + ' · ' + item.label, body });
        show(p.name + ' · ' + item.label, body);
      }
    }
    // 清理长期不活跃的去重键，防内存增长
    if (this.notified.size > 200) this.notified.clear();
    return fired;
  }
}

module.exports = { NotifyCenter };
