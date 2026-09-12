# 0.2.19 调度可靠性与不变的核心契约

## 慢状态检查、通知与释放竞争

- 前置：隔离 home；四个并发名额；模拟 runtime，可挂起 inspect，禁止真实请求。
- 操作：运行一个任务，挂起状态检查；新增手动运行、冻结/恢复调度、推送完成通知或移除该执行账号，再返回旧的 running/turnId。另测等待审批时返回旧 running、连续 tick。
- 预期：手动请求及通知不等待 inspect；已结束/取消任务不复活、不重复释放；等待审批状态不被旧快照覆盖。同 run 只允许一个底层检查，最多四个未完成检查。每个 automation/target 占用及四槽限制不变，已有固定账号与默认出口的规则不变。
- 清理：解开所有挂起 promise，关闭测试 runtime 并删除临时 home；不读取生产会话。
- 性能：慢 inspect 从全局串行区移除；每轮检查间隔仍为 30 秒；查询并发最多四，原始调用超时未结束时不叠加同 run 查询。串行区只保留状态检查/持久化/领取。快响应可立即填补释放的任务槽；不增加任务并发。

## 等额度续跑的尾部公平性

- 前置：十条等待标记，前八条会话持续忙碌；另设九条 unknown 投递，仅第九条可核对为未提交。
- 操作：连续执行两轮 tick，随后测试额度不足、提交前拒绝、提交后断线及重启。
- 预期：尾部标记最终轮到；waiting/unknown 每批最多八条，最多发出一个续跑提交。unknown 无证据不重发；额度检查、会话占用、deliveryId 去重沿用现状。
- 清理：关闭续跑服务，删除 fixture；不改真实标记。
- 性能：数组枚举仍一次/状态，新增两个内存游标；不增加定时器、持久字段、每轮额度调用或提交上限。

## 账号与出口保护矩阵

运行 accountTaskRouting、accountRuntimeIntegration、accountAuthCoordinator、accountExecution、accountActivationAdmission/Runtime/Scheduler、apiProxy/gateway、automationDispatchIntegration 和 deliveryService。

同时断言：默认切换时固定账号流继续，默认流遵循既有关闭/拒绝规则；A 刷新不堵 B；账号移除只清理所属连接；同会话任务不被抢占；激活只向同账号正常工作让出；task auth 不写入主账号；故障后原有准入恢复。不得仅以“没有重复发送”作为通过标准。
