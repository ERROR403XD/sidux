# 回合状态、列表优先级与中断持久化门禁

## 准备

使用开发验证环境和两条合成会话 A/B，打开 Network；故障注入只用合成数据。执行 `pnpm exec vitest run src/composables/threadStatusController.test.ts src/composables/threadStatusComposition.test.ts src/composables/useDesktopState.test.ts` 验证自动化合同。

0.2.22 Q09：组合测试从RPC订阅注入原生 `thread/status/changed` / `turn/started` 通知，经过真实订阅、状态和desktop owner；生产模块不再导出 `setThreadInProgressForTests`。结构门禁 `threadStateArchitecture.test.ts` 禁止重新引入此类入口。

## 操作与预期

1. 延迟会话列表响应，让 A 收到 running 通知，再释放包含旧 idle 的列表；A 仍运行。同值 running 通知也应保护状态，不能被旧列表覆盖。
2. 让 A/B 同时运行，依次完成；A 完成清自身 plan/reasoning/commands，不影响 B；最后一个活动会话结束才恢复后台列表分页。
3. 新会话发送后分别按“服务端 listed→持久 user”及逆序到达；两条件齐备才解除中断等待。非空 active turn 可直接解除；重开门禁不能复用旧 receipt。
4. 输入包含重复和空白的活动详情；去除重复，最多显示最近 3 项。切到 B 后不显示 A 的活动。
5. 注入 transient 与 final 错误，再 ready 恢复；仅 transient 清除。final 错误在历史出现相同的最新 turnError 后只显示一份，不相同的最新错误不隐藏 live 错误。
6. 停止并重新启动，释放旧通知后再发送新回合；旧通知无效，新回合正常更新。停止后显式 history 读取仍遵循原合同，不把它当作订阅更新。
7. 中断A的请求尚未完成时再次中断，只有一次中断API；切到B并收到运行通知，再完成A的旧请求，B的Thinking投影保留，不触发旧会话列表刷新。

## 清理与回滚

关闭延迟/合成事件注入，恢复正常网络与轮询，保留标准测试卷和会话。结构回滚须同时恢复父层装配及状态 owner 的全部 getter/命令；不得只恢复某个 map。此文档记录手测步骤，不代表实际 UI 验收已完成。
