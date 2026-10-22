# SSE 通知订阅合同

前提：在隔离的测试服务/临时会话上操作，不改变 5900/59001 的账号或会话。自动回归运行 `pnpm exec vitest run src/server/routes/notificationRoutes.test.ts src/server/routes/threadSearchRoutes.test.ts src/server/terminalManager.test.ts src/server/accountNotificationService.test.ts`。

操作：用 HTTP 客户端打开 `GET /codex-api/events`，检查 ready 事件、text/event-stream、no-cache/no-transform、X-Accel-Buffering=no；保持连接 15 秒应收到 `: ping`。产生一次 runtime、终端和自动化通知，每次源事件只显示一个带 atIso 的 data。关闭/中止连接，再重新连接，重复十次。

预期：每连接只注册三组源订阅和一个 keepalive。关闭或 aborted 后 timer 清除，订阅释放，关闭响应不再写入通知；其他连接继续接收。非 GET/错误路径不注册资源。自动回归包含真实 AppServerProcess 通知→HTTP SSE 的十次打开/断开，以及虚拟时钟的精确 15 秒边界；终端与自动化源映射使用可控订阅源，不证明真实进程/自动化压力或 UI 挂载验收。

清理/回滚：关闭本次所有 HTTP 客户端和临时端口；保留真实会话/工作区。代码可独立 revert，无 schema 变化。


## 0.2.22-dev.8 离线订阅组合

前置：本轮审核依赖可用；不启动HTTP监听。运行`node docs/baseline/022/dev8-review-20261020/notification-routes-offline.cjs`，检查两个同时连接及十次后续连接、GOAL副本、close/aborted与15秒定时器。预期每连接一套三源订阅和一个timer，关闭A后B继续收事件，全部关闭后均为0。清理只销毁内存夹具及脚本随机配置目录；保留真实SSE、慢客户端背压和浏览器验收缺口。

## dev.8 真实WS/SSE与关闭组合（2026-10-20审核）

前置：已有明确浏览器授权，核实4173的cwd和独立合成CODEX_HOME；可用本轮已安装dev.8审计镜像。不连接5900/59001/5173，浏览器运行时不修改仓库文件。

1. 执行`node docs/baseline/022/dev8-review-20261020/realtime-transport.cjs`，核对双start唯一连接、三源各一次、WS关闭后重连一次、503/挂起/缺WS回退一条SSE、EventSource原生重连及停止清理。预期无重复订阅，停止后的2500ms回退与第二次2000ms重连均取消。
2. 按`docs/baseline/022/dev8-review-20261020/run-commands.json`的`realtime-shutdown`命令，在network=none、无端口映射的容器运行安装包。分别保持一条正常WS/SSE再向自建CLI子进程发SIGTERM；另做无客户端、先关闭WS/SSE三个对照。预期正常空闲退出0，连接/订阅及时释放。当前dev.8打开连接的两组约5秒后exit1，R57未修复；三个对照通过。
3. 核对两份结果无harnessError，8个临时服务资源清零，5个子进程退出与随机home删除。两脚本目前均预期exit1，不能把失败合同改为成功断言；真实普通通知传输通过不代表API代理WS或慢消费者压力通过。

清理：脚本只关闭自建客户端、随机loopback服务与容器子进程，Docker使用--rm；保留本轮4173，不重启长期服务。本批没有产品修改或回滚操作。
