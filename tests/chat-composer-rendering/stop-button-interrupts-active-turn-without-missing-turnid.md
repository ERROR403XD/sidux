### Feature: Stop button interrupts active turn without missing turnId

#### Prerequisites
- App is running from this repository.
- At least one thread can run a long response (for example, request a large code explanation).

#### Steps
1. Send a prompt that keeps the assistant generating for several seconds.
2. Immediately click the `Stop` button before the first assistant chunk fully completes.
3. Confirm generation halts.
4. Repeat with a resumed/existing in-progress thread (reload app while a turn is running, then click `Stop`).
5. While the first stop request is pending, click `Stop` again, then switch to another running thread and release the first request.

#### Expected Results
- No error appears saying `turn/interrupt requires turnId`.
- Turn is interrupted successfully in both immediate-stop and resumed-thread scenarios.
- The duplicate stop does not send a second `turn/interrupt`; the first response cannot clear the newer selected thread's running state.
- Thread state exits in-progress and the stop control returns to idle.

#### Rollback/Cleanup
- None.
### 0.2.22 R8：缺少回合 ID 时的停止重入

前提：隔离运行中会话，仅有运行状态而尚未取得 activeTurnId；延迟详情响应。

操作：快速点击停止两次，详情返回后观察 interrupt 请求。另一次让详情失败后重试；等待期间切会话，再切账号/停止轮询。

预期：第一个 await 前已锁定操作，同一操作只取一次详情、发送一次 interrupt。详情失败能解除锁；旧失败不写入新会话，账号/生命周期失效后不再发送旧 interrupt，旧 finally 不清除新操作状态。

清理：恢复详情请求，结束本轮测试回合；保留原候选历史。

### 0.2.22：停止入口与重启后的请求槽

前提：隔离运行时与合成运行中会话，已知/未知activeTurnId各一条；通过前端fixture控制轮询生命周期和详情/interrupt延迟，明亮与深色各一轮。

操作：停止轮询后显式读取会话历史，使其报告运行中，再触发保留的停止动作；随后恢复轮询。另挂起旧详情或interrupt，停止/重启，在同ID会话开始新回合并触发停止，再释放旧成功/失败。

预期：停止期间不发interrupt或额外详情请求；旧详情不继续发送旧interrupt或恢复旧turnId；旧成功/失败不清新回合状态、覆盖当前错误或追加同步。新操作可立即开始，旧finally不释放其busy槽；新操作自己的完成才释放busy。正常缺turnId、同账号切会话及重复提交合同保留。

清理/回滚：解除延迟fixture、恢复轮询并结束合成回合，只删除本轮合成数据。撤销入口守卫提交会恢复停止后新写缺口；已经接受的服务请求不撤回。本合同不代表真实模型停止时延或实际浏览器验收。

资源所有权：完整interrupt与busy/token由 `threadMutationController` 持有，已知/缺失turnId、persist gate与当前错误/状态提交顺序保持。父层只装配status/activeTurn/history/turn/sync窄命令和只读busy，account/stop由owner统一释放两种请求槽。仅撤销结构提交可恢复父层所有权，保留前一批停止入口守卫。

### dev.8审核R36：同一会话旧停止与新回合

前提：独立合成环境；X的interrupt响应可延迟，X结束后同一账号/同一会话开始Y，Y已有推理、命令和计划。离线组合命令：`node docs/baseline/022/dev8-review-20261020/interrupt-offline.cjs`。

操作：释放X的成功响应，分别让后续同步成功、延迟、列表失败、历史失败；另释放X的失败响应。对照正常停止、重复停止、账号切换、stop/start和选中其它会话。

预期：X的迟到响应不清除Y的运行状态/ID/流式内容，不给Y添加X的错误；正常停止仍按既有合同完成。当前dev.8离线结果12通过/8失败，确认R36，尚未修复；不是浏览器或原生模型复现。

清理：脚本关闭自有控制器和虚拟定时器，无服务和运行数据写入；后续浏览器复验仅清理自身合成会话。

### dev.8 原生取消与进程重建对照（2026-10-20审核）

前置：本轮dev.8审计镜像和Codex0.162.1；network=none、无宿主端口或运行态挂载。按`docs/baseline/022/dev8-review-20261020/run-commands.json`的native-cancel-recovery两条命令执行，分别默认memories与AUDIT_MEMORIES=0。供应方为容器内固定流，不调用真实云模型。

1. 对A/B各通过真实delivery启动原生回合；取消A，核对A上游断开、历史interrupted，B继续完成。
2. 在A下一回合活动期间重试同delivery ID，再用旧turnId取消。预期只有一次生成，旧turnId收到明确拒绝（当前HTTP502），新回合保持活动并可完成。
3. 结束产品和所有自有原生进程后重用测试home启动，恢复A/B，核对历史ID/终态/文本；重放旧delivery body不增加回合，新ID仍可正常发送。
4. 两配置各12合同通过；默认原生memory后台请求单列且被夹具409拒绝，关闭memory对照无请求。所有资源清理、PID/OOM计数正常。

清理：仅在测试容器按任务cwd/PID结束R58已知残留，再删任务home并移除容器；不修改宿主memories或生产状态。本测试未点击浏览器Stop，不覆盖R36迟到前端回执，也不证明优雅退出或云端停止延迟。

### dev.8浏览器迟到回执与刷新补证

前置：独立4173、原有合成会话B；`node docs/baseline/022/dev8-review-20261020/interrupt-ui.cjs`。通知与interrupt响应均在浏览器中替换，不创建磁盘会话，不发送实际模型请求。

1. 三尺寸浅深主题分别执行普通停止、旧成功晚到、旧失败晚到。实际点击Stop后确认按钮禁用和一次旧turnId请求；旧turn结束、新turn已有推理后才释放旧回执。
2. 预期旧回执不删新推理、不写新错误；下一delta保留前缀。活动状态reload仍有Stop；新turn完成后reload只有一条最终回复并恢复空闲。
3. 当前结果：六组144检查126通过/18失败，R36在真实UI复现；没有向新turn发停止请求。此刷新合同只覆盖浏览器按新快照恢复，原生取消/持久性仍以独立容器证据为准。
4. 对照错误提示包含普通句子/长错误码，检查反馈按钮完整留在会话可视范围。`live-error-layout-ui.cjs`30检查中375浅深两组失败，R60；整页无横向溢出不代表子控件没有裁切。

清理：关闭全部browser context，核对种子SHA与201条会话、零活动；保留4173。本轮没有修产品，不把失败探针改成成功断言。
