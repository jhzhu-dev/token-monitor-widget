# Token 监控小窗（Windows 桌面端）

常驻桌面的悬浮小窗，聚合监控 AI 平台套餐余量：

| 平台 | 接入方式 | 显示内容 |
|---|---|---|
| 智谱 GLM Coding Plan | API Key（直连账号级接口） | 套餐额度（5h/周窗口，账号所有 Key 共享）、现金余额、资源包余量 |
| OpenCode Go | **OAuth 登录**（设备码流程，token 自动续期）或 API Key | 5小时 / 本周 / 本月额度（账号级，百分比） |
| DeepSeek | API Key | 账户余额、赠金、**近 24h 消耗**（余额历史推导） |

## 功能

- 悬浮小卡片：无边框、置顶、可拖动（位置记忆）、可折叠成迷你摘要条
- 托盘图标：显示/隐藏、设置、立即刷新、置顶开关、开机自启、退出
- 定时自动刷新（30s~5min 可配），用量 ≥ 阈值时进度条变红 + Windows 通知（每窗口每重置周期只弹一次）
- 每个平台内嵌最近 24h 用量曲线（sparkline）
- 演示模式：无凭证时自动用模拟数据渲染

## 快速开始

```bash
cd token-monitor-widget
npm install        # .npmrc 已配置 npmmirror 镜像，国内可直接装
npm start
```

首次启动进入演示模式。右下角托盘图标 → 设置…，填入各平台凭证后保存即生效。

## 凭证获取

- **智谱**：[open.bigmodel.cn](https://open.bigmodel.cn) 控制台 → API Keys 创建（国际版在设置里切换 api.z.ai）。一把 Key 即可读到账号全域数据（套餐额度/余额/资源包均为账号级）。
- **OpenCode**：设置里选「OAuth 登录」→ 点登录 → 浏览器打开 opencode.ai 授权页 → 输入设备码确认。token 过期前 5 分钟自动续期；也可改用 Console 创建的 API Key。
- **DeepSeek**：[platform.deepseek.com](https://platform.deepseek.com) → API Keys 创建。

## 数据文件

- 配置：`%APPDATA%\token-monitor-widget\config.json`（API Key / token 明文存于本机用户目录）
- 历史曲线：`%APPDATA%\token-monitor-widget\history.jsonl`

## 开发

```bash
npm test              # 解析器单测（24 项，无网络）
npm run test:live     # 真实端点连通性冒烟（无凭证）
npm run screenshot    # 自动截图小窗+设置窗到 screenshots/（临时 userData，不污染真实配置）
npm run screenshot -- --collapsed   # 折叠态截图
```

结构：`src/providers/*` 平台适配器（纯函数解析，可独立单测）；`src/main/*` Electron 主进程（窗口/托盘/调度/IPC/通知/历史/OAuth）；`src/renderer/*` 小窗与设置窗口 UI。

## 已知限制

- **按单 Key 分列明细**：智谱与 OpenCode 官方均无公开接口，只能逆向控制台私有接口（不稳定），本版本不做。
- **DeepSeek 用量**：官方无用量端点，"近24h消耗" 由本地余额历史推导，需要运行一段时间积累数据；期间充值会按净消耗计并标注。
- **OpenCode OAuth**：用量端点理论上接受 API Key；若 OAuth token 被端点拒绝会自动回退到已填的 API Key（设置里两者都配最稳）。
- 智谱查询走的是控制台私有端点（社区工具验证），官方如调整可能失效。
- 打包发布可用 `electron-builder`（本仓库未预置配置），开发期 `npm start` 即可。
