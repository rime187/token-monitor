# 我的 AI 额度

这是 Token Monitor v0.93.1 的中文首页插件。使用主窗口的「置顶」模式，将窗口调至约 340 × 400，即可同时看到四项读数。点「额度详情」查看原生账户明细。

## 接入账户

打开右下角设置中的「AI 工具额度」。Codex 使用已登录的本机账号。Antigravity 可以读取正在运行的客户端，也可以在设置中连接 Google 账号。ChatGPT iOS 普通聊天额度请在 ChatGPT 中查看。

- **Grok Bot** 显示 The X Subscription 的共享额度。Windows 上，如果宿主尚未读到共享额度，在已登录同一订阅的 Cursor 中打开「Settings → Plan & Usage」。小窗首页显示时会读取该页上的每周已用百分比，换算为剩余百分比，并显示官方给出的重置日期。首页每分钟刷新一次。用量页关闭后，小窗保留数值、采集时间，并标为「上次读取」。
- **DeepSeek** 使用 DSH 实际扣费账户的 API Key。在「AI 工具额度 → DeepSeek」保存一次后，首页会随宿主刷新，显示官方接口返回的币种和余额。可用 DSH 的「设置 → 账号与余额」核对。

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

在「设置 → 插件」导入新包，启用插件并将其设为首页内容。宿主管理 API Key 和额度快照。插件通过 Windows 辅助功能读取 Cursor 可见用量控件，只在插件自己的数据目录保存最近一次成功的读数。
