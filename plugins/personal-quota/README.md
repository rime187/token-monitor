# 我的 AI 额度

这是 Token Monitor v0.93.1 的中文首页插件。使用主窗口的「置顶」模式，将窗口调至约 340 × 400，即可同时看到四项读数。点「额度详情」查看原生账户明细。

## 接入账户

打开右下角设置中的「AI 工具额度」。Codex 使用已登录的本机账号。Antigravity 可以读取正在运行的客户端，也可以在设置中连接 Google 账号。Grok Bot 使用与 The X Subscription 关联的 Cursor 账号。DeepSeek 需要 DSH 实际扣费账户的 API Key。ChatGPT iOS 普通聊天额度请在 ChatGPT 中查看。

## 修改和安装

- 改固定顺序、显示数值、中文提示或详情跳转，编辑同目录的 `ui.mjs`。四行分别取 Codex 的短时和周窗口、Antigravity 剩余最少的模型组、Cursor 已确认的 X 共享额度、DeepSeek 原币种余额。
- 改字号、颜色和间距，编辑 `panel.css`。保留 340 × 400 窗口下两档缩放的四行可见性。
- 更新时先调高 `manifest.json` 中的版本号，再从仓库根目录运行以下 PowerShell 命令。打包脚本使用新的输出文件名。

```powershell
node --test tests/plugin-personal-quota/overview.test.js
$version = (Get-Content -Raw plugins/personal-quota/manifest.json | ConvertFrom-Json).version
New-Item -ItemType Directory -Path dist -Force | Out-Null
node scripts/build-plugin-package.js plugins/personal-quota "dist/personal-quota-$version.tmplugin"
```

在「设置 → 插件」导入新包，启用插件并将其设为首页内容。原版应用管理登录、刷新与数据存储；插件仅使用宿主提供的额度快照。
