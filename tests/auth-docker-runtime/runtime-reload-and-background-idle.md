# 开发重启与后台终端空闲检查（0.2.9）

## dev.8 审核：旧终态不能清除新回合活动记录

前提：仅在network=none、无端口映射的独立容器运行 `docs/baseline/022/dev8-review-20261020/stale-runtime-activity-container.cjs`，精确命令见同目录run-commands。使用已安装dev.8、合成IPC与新建home；不对宿主服务发送事件，不执行候选替换、账号切换或生产activate。

1. 同会话old完成后，通过真实delivery端点启动保持inProgress的new。确认活动接口、列表、直接读取与空闲检查均认为当前忙碌。
2. 分别重放old的completed（嵌套turn.id）、cancelled（顶层turnId）。底层new不改变，预期活动接口仍包含会话、列表active、`checkIdle().idle=false`。
3. 把old cancelled放在new started通知之后、turn/start回执之前；等待回执期间pending必须可见，放行accepted回执后仍不能清掉new的活动标记。
4. 以不重放、另一会话终态作对照；直接thread/read与合成持久文件须一直指向相同new/inProgress。最终只完成new，所有组才允许返回idle。

当前dev.8证据：5组31检查22通过/9失败，三组旧终态分别破坏活动、列表与空闲检查，记R62 P1；保持正确断言及exit1。事件为受控合成IPC重放，不证明原生自然出现频率，也没有执行切换来制造实际会话损失。

清理：释放本轮暂停回执，先关自有SSE，再停止自有容器CLI；核对自有子进程已退出，删除本轮随机home和容器，保留宿主4173/5173/59001/5900。

前置：确认 4173 的 PID/cwd 属于当前源码和独立测试 home，队列为空；59001 使用已验收候选。不要对 5173、5900 或全局 Codex 任务触发本测试。

1. 记录 4173 的队列、调度器状态和 WebSocket 通知。修改并恢复 Vite 配置中的无行为注释，触发三次真实配置重启；每次等待日志明确出现 server restarted。
2. 每次重启后读取 `/codex-api/thread-queue-state`，应为 200；调度器 ready 且无错误、RPC 可用，不出现“发送服务已停止”。旧 middleware 释放后，新实例仍可访问同一运行态；最后持有者退出只关闭一次。
3. 用独立原生会话启动一个有明确超时的内部后台命令，等其主回合完成，确认原生后台列表仍有该命令。
4. 执行 `CODEXAPP_IDLE_CHECK_URL=http://127.0.0.1:59001 node scripts/check-codexapp-idle.cjs`。即使 activeTurns=0，也应报告 backgroundThreads 非零并退出 3。脚本只检查，不停止命令，不读完整历史/输出。
5. 尝试切换独立测试账号/供应方，应被后台终端状态阻止并提示先处理 Codex 后台终端，账号不变、进程不丢失。仅检查供应方公共前置保护时，可 POST 一个不存在的 `/codex-api/free-mode/<专用测试标记>` 路径：有后台进程时应先返回 409，即使保护失效也不能落入真实配置写入分支。此检查不能替代真实双账号切换。测试凭据须来自隔离测试环境；不复制生产认证。
6. 明确停止该测试进程并重新检查，backgroundThreads=0 后才允许后续已授权操作。无法读取、未知会话状态、分页重复或数量/时间超过上限时必须阻止，不把未知状态当空闲。
7. 单测覆盖最多 200 个已加载线程、最多四路并发、存在性查询 limit=1；不支持该原生能力的旧 CLI 报 unsupported，不冒充已核对进程数为 0。

清理：恢复配置原字节、停止仅本测试创建的后台命令；保留候选 home 与账号数据。确认 4173 仍可用，生产进程不变。不得为了通过空闲检查自动清空队列或批量停止进程。


## 0.2.21-dev.2：回收中的 worker 不可借用

前提：隔离测试运行时，不使用生产会话；运行 `src/server/accountResourcePool.test.ts` 的可控 dispose 场景。
1. 容量 1，先分配 A；分配 B 触发异步回收 A，但先不完成 dispose。
2. 同 key 请求 A，及读取可用 worker：必须返回可重试 worker_reclaiming，getAvailable/availableValues 不暴露 A。
3. 让等待超过 disposeTimeoutMs：调用可结束，但原资源仍隔离、占容量，不创建 B；随后实际 dispose 完成，才允许新分配。
4. 用测试模拟显式替换同 key 对象：旧 dispose 完成不能删除新对象或超额创建。
5. 运行关联账号路由/自动化准备回归，确认等待 idle 检查时已有的复用保护不退化。

预期：不存在回收对象被重新初始化后丢失池跟踪；错误可重试但不盲目创建资源。清理：测试自行释放 dispose promise；无生产操作。
