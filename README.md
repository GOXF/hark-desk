# Hark Desk

Codex 风格的 Hark 桌面客户端（Tauri 2 + WebView2）。

- **最左：账号栏**（头像），每个账号独立数据目录，登录一次一直保持，互不串号；右键改名/删除。
- **中间：项目树**，像 Codex 一样按项目分组收藏对话；「📌 收藏当前对话」把右侧当前页面存进项目。
- **右侧：对话区**，直接嵌入该账号登录后的 Hark 官方页面，云浏览器 / 云电脑实时画面、卡片、上传、登录表单等全部原样可用。
- **设置 → 注入样式**：可写 CSS 隐藏 Hark 页面自带的侧栏，让右侧看起来和外壳一体。

## 结构
- `index.html`、`src/`：外壳界面（原生 JS + Vite）。
- `src-tauri/src/main.rs`：窗口与多 WebView 管理（`ui` 铺满窗口，`acct-<id>` 盖在右侧对话区）。
- Hark 页面不拿任何 IPC 权限（见 `src-tauri/capabilities/default.json`）。
- 数据：`%APPDATA%\com.goxf.harkdesk\`（`state.json` 界面数据，`profiles\<账号>` 各账号登录数据）。

## 开发 / 构建
```bash
npm install
npx tauri icon app-icon.png   # 第一次生成图标
npx tauri dev                 # 开发
npx tauri build               # 打包（Windows 出 NSIS 安装包）
```
推送 `main` 会在 GitHub Actions（windows-latest）自动构建，产物在 Actions 的 artifact；推 `v*` 标签发 Release。
