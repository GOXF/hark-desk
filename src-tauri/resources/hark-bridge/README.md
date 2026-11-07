# hark-bridge 资源目录

CI（.github/workflows/hark-windows.yml）在打包前把以下两个文件放到这里，
由 `tauri.windows.conf.json` 的 `bundle.resources`（`resources/hark-bridge/*` → `hark-bridge/`）打进安装包：

- `HarkBridge.exe`：由仓库根目录 `bridge-go/` 编译（`go build -trimpath -ldflags '-s -w'`）
- `cloudflared.exe`：Cloudflare 官方 windows-amd64 版本（必须和 HarkBridge.exe 在同一目录）

这两个 exe 不入库（见 .gitignore）。本 README 保证 glob 在本地开发时也能匹配到文件。
本地调试可以自己放进来，或设置环境变量 `HARK_BRIDGE_EXE` 指向 HarkBridge.exe。
