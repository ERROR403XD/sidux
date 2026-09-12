# 0.2.19：主动文件预览的兼容性边界

前置：`pnpm run build`；本机 Chromium `/snap/bin/chromium`。仅操作脚本自建的临时 CODEX_HOME/HTML/SVG/文本文件；管理探针仅 GET 问题摘要，不含真实数据。

操作：运行 `node scripts/test-preview-isolation-compatibility.cjs`。它使用实际打包服务器的 local-browse/local-image/local-edit 路由，在浏览器导航响应中分别加入无 CSP、`sandbox allow-scripts`、`sandbox allow-scripts allow-same-origin`。子资源走真实网络以保留浏览器 CORS 判断；Ace 仅用离线 API 替身，保存走真实 PUT。

预期：默认与 allow-same-origin 模式下模块、相对 JSON、编辑保存均成功，但 HTML/SVG 可读取同源管理接口；严格 opaque 模式下三项功能失败、管理响应不可读。这不是完整 CSRF 防御验收，也不证明所有跨源写入均被阻断。

本轮决定：保留现有手动主动预览的风险，不施加破坏现有工作流的全局 CSP，不增加自动/内嵌主动预览。未来扩大预览前，需要独立来源与能力接口的完整设计和回归；不能靠叠加 allow-same-origin 例外宣称已隔离。

结果：实际隔离端口及 1000×700 截图记录在 `output/0219-final/preview-isolation.json`；截图 `output/playwright/0219-preview-isolation-{baseline,opaque,same-origin}.png`。清理：脚本停止自己的服务器并移除自建临时目录，原应用头部与生产服务不变。
