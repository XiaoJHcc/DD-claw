# scripts：构建与平台辅助

## 设计要点

- 构建脚本只生成资产与默认值，不读取真实库、cookie 或运行时密钥。构建、开发、测试、类型检查的 npm 前置钩子共用生成流程。
- 生成文件内容未变时不写盘，避免 watch 因 mtime 变化无意义重启。生成物不手改；具体前后端契约见 [面板专题](../docs/modules/panel.md)。
- Windows 注册与 macOS 编译辅助由通知模块调用；平台限制和权限边界见 [notify](../src/notify/AGENTS.md)。不要为了构建或测试隐式提权。
- 开发静态服务只绑定本机；请求路径及图片代理域名必须校验，不扩大文件读取或任意 URL 代理范围。

## 文件分工

| 文件 | 职责 |
|---|---|
| `build-webui.mjs` | 从 `webui/` 生成 `src/panel/webui-assets.gen.ts`，从 `demo/defaults.json` 生成 `src/core/onboarding-defaults.gen.ts` |
| `webui-dev.mjs` | demo 静态服、受限头像缓存映射与微博图片代理；不替代真实后端 |
| `mac-notify.swift` | macOS 原生通知 helper 源码 |
| `register-aumid.ps1` | Windows Toast 的 AUMID / 快捷方式注册 |
| `seed-timeline.mjs` | 手动写入演示时间轴数据；只对明确选定的演示库运行，不在测试或启动时自动执行 |
