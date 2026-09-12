# PWA 首页缓存故障恢复

前置：隔离 localhost 静态服务提供当前 `public/sw.js` 和可切换 HTTP 200/503/断连状态的测试首页；使用新浏览器上下文，不干扰 59001。Chromium 和 WebKit 分别验证。

1. 在旧 `codexweb-shell-v2` 缓存放入一份虚构错误页面，加载有效首页并注册当前 SW。预期新 v3 缓存建立，旧缓存删除。
2. 将首页服务改为 503，再导航/刷新。预期仍显示先前有效首页，不能缓存 503 错误文本。
3. 模拟断网或关闭首页请求连接后再次刷新。预期回退有效缓存；WebKit 自动化的离线开关可能产生内部导航错误，因此用临时服务关闭 HTTP 连接验证 fetch 失败分支，并明确记录方式。
4. 恢复服务并修改首页标记，再刷新。预期网络新内容显示并更新缓存。另用单测覆盖无缓存的 HTTP 错误、缓存写入失败和恢复后的离线读取。
5. 对 JS/CSS 请求返回 200 HTML，再制造断网；不能将 HTML 作为脚本/样式缓存或回退。已有正确类型的旧资源可在 404/断网时继续使用。Cache Storage 不可访问时，成功的网络响应仍能加载。

结果判断只针对页面外壳恢复；不代表模型、历史加载或外部服务可离线使用。性能：每次导航仍只有一次网络 fetch，不增加轮询；只缓存成功响应。清理：关闭临时服务和浏览器上下文，删除自己建立的测试缓存。

## 0.2.19 封测：重复启动唤起已有窗口

前置：支持 Launch Handler 的 Chromium 浏览器，已安装当前 PWA，更新应用 manifest 后测试。静态 manifest 和自定义品牌的动态 manifest 均声明 `launch_handler.client_mode = focus-existing`。

操作：已有窗口时分别从开始菜单、桌面快捷方式或任务栏启动；关闭全部 PWA 窗口后再启动。

预期：有窗口时优先把现有窗口提到前台，保留当前会话页面；没有窗口时正常新建。浏览器未实现 Launch Handler 时沿用其默认行为。本次按用户要求仅核对实际生成的 manifest 字段，不进行操作系统安装/启动矩阵。

验证：`pnpm exec vitest run src/server/webUiBrandingStore.test.ts` 已覆盖实际 HTTP manifest；静态 JSON 同步检查。新增字段不增加脚本、定时器、请求或跨窗口消息。清理：关闭自己建立的测试窗口。

规范依据：[Chrome Launch Handler](https://developer.chrome.com/docs/web-platform/launch-handler/)。
