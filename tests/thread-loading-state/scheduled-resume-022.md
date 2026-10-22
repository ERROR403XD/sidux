# 会话定时续跑（0.2.22）

准备：隔离候选；一个已有会话，记录选中模型和推理强度。用合成时钟/CLI 验证 deadline，云端账号可在空闲候选中人工验证。覆盖浅深主题以及 1440×1000、768×1024、375×812。

操作：
1. 右键会话 →“定时续跑…”；选择未来日期时间，确认后检查会话上的时钟标记与 tooltip；过去时间不能保存。
2. 刷新页面、重启隔离服务，检查时间和标记保留。用右键“取消定时续跑”移除未来计划。
3. 选择短 deadline，等待触发：普通会话收到“继续之前的工作”，GOAL 会话调用原生“继续目标”；model 和 effort 与确认时会话选择一致，没有新增自动化定义/任务记录。
4. 被标记会话实际开始续跑、获得 accepted 投递回执时，立即清除时钟标记。普通回合仍 inProgress、GOAL 仍 active 时都应消失；不等待任务完成。到点但仍在排队、发送中或结果未确认时保留标记。任务之后完成所显示的蓝点和未读由原有规则处理。
5. 未打开的历史会话从最近 turn_context 读取模型/强度，包括大于 256 KB 的最后响应。无法恢复选择时明确提示，不偷偷换成默认模型。
6. 模拟提交断线/服务重启；未确认的固定 delivery ID 保留，不能重复发送。只有当前计划、当前会话且来源为 scheduled 的启动确认可触发清除；额度续跑、旧计划、其他会话及任意原生开始/完成事件不能误清。发送前失败、启动未确认时保留需核对标记，可取消；已确认启动的计划不会因之后失败或暂停而恢复。
7. 触发运行时 drain，deadline 到达时不能发送，future intent 保留；退出 drain 后恢复。换账号/连接后不能用过时 context 发送。
8. 保持会话运行，等待续跑到点排队；分别在排队、编辑中、发送前失败状态取消定时续跑。标记和对应待发消息都应消失，恢复编辑/重排旧消息必须失败，会话空闲后不能发送。若取消同时发生消息编辑，revision 冲突应保留标记并提示重试；重试取消应成功。已发送或结果未知的消息不主动中断/重发。
9. 用隔离合成时钟设置八天后的计划并重启服务，再推进到 deadline；应正常发送一次。对旧格式中预先生成 ID 的未来计划重复此操作，结果一致。首次提交前模拟断线，再重启核对；应沿用已保存的发送 ID，不能重复发送。
10. 保留 accepted 续跑回执，模拟服务在清标记前关闭，将计划状态分别设为 submitted、unknown、failed，再恢复服务；标记应核对后从磁盘、接口和侧栏消失，无新投递。令历史不可读、原回合不在最新分页或 GOAL 查询失败，结果也应一致，清除不发起历史分页或 goal/get。缺少原记录的 failed 计划保持待核对且不自动重发。
11. 续跑方式互斥：启用定时续跑后，右键的“额度恢复后继续”置灰并解释需先取消；取消计划后该项恢复可选。启用额度恢复续跑后，“定时续跑…”置灰；取消额度续跑后恢复可选。刷新页面确认置灰保留；两个页面同时启用相反方式时，最多一个成功，另一个提示先取消。先打开时间选择器，再在另一页面启用额度续跑：收到更新后确认按钮置灰，不能保存。已有旧版双标记时，两种取消入口仍可用，不自动丢弃标记。浅深主题及英文界面都检查置灰与说明。
12. 启动事件竞争回归：让 accepted 启动通知在 submit 尚未返回或 inspect 正在进行时到达，不能丢失后续核对。重复通知应合并为一次待核对项。清除后重新设置未来计划，旧 delivery 的启动/完成通知不得影响新计划，未来计划 timer 不得空转。

预期：每会话一个计划，时间按当前设备时区输入。复用普通会话 delivery，模型/强度取确认时快照；不会归入自动化绿点。页面关闭后服务仍能到点提交，但浏览器通知需要页面连接。

性能：无计划不启 timer；未来计划只设最近 deadline 的 timeout。未确认的 submitted/unknown 约每 5 秒核对，每轮最多 4 项，匹配启动通知立即唤醒。accepted 后立即消费计划并停止核对，不再查询回合或 GOAL 是否完成，不缓存完成事件。旧 failed 标记恢复时核对一次，无回执则保持静默；新启动确认可再次唤醒。历史模型选择仍从 256 KB 块向后读取，上限 8 MB。

清理/回滚：取消合成计划和队列，关闭测试页。回退实现提交；持久计划文件保留以供重新升级恢复，不删除账号/认证/历史。

## 0.2.22-dev.6 GOAL 定时续跑

前置：独立 HOME、可控时钟、暂停的 GOAL 与独立投递账本。运行 `pnpm exec vitest run src/server/goalContinuation.integration.test.ts src/server/threadScheduledResume.integration.test.ts src/server/threadScheduledResumeRuntime.test.ts src/server/threadResumeControlService.test.ts`。

1. 给暂停 GOAL 设置未来续跑，选择模型、推理强度和速度。时间未到时不得改目标或设置；到点先应用 `thread/settings/update`，再调用 `thread/goal/set {status:'active', origin:'user'}`。不发送普通继续消息，不重建目标，不重置预算与用量。
2. 原生恢复确认并取得 GOAL accepted 回执时，目标仍 active、没有任何阶段或目标完成事件，时钟标记就应清除。之后暂停、阻塞、额度受限或预算用尽不恢复计划。发送前遭拒或恢复响应丢失时保留待核对标记，不以任意 GOAL active 事件代替当前投递的确认。
3. 到点时会话忙而排队；等待期间新增 GOAL，空闲派发时应按最新 GOAL 选择原生恢复。排队期间取消计划后不得恢复。目标在参数准备与真正派发之间被清除、替换或耗尽预算时，发送前拒绝，不回退成继续消息。
4. 保存计划后切换账号/连接，到点不能修改模型设置或恢复目标；错误提示核对账号。已有额度续跑标记时定时续跑继续受互斥服务保护。
5. 恢复已获原生确认后重启服务，按 GOAL 回执核对，不重复恢复；恢复响应丢失时保持 unknown，不能用普通 userMessage 的 clientId 或历史阶段完成来确认并重发。

原生隔离验证：先构建 `pnpm exec esbuild src/server/threadContinuation.ts --bundle --platform=node --format=cjs --outfile=output/playwright/goal-continuation-dev6/continuation.cjs`，再运行 `node scripts/verify-goal-continuation-native.cjs`。它仅使用临时无挂载容器和本地 HTTP 模型替身，捕获原生 GOAL 请求后返回合成失败；核对模型、推理强度、速度、目标内容及没有普通继续消息，不能算真实云端目标成功完成。

性能：每次 GOAL 派发为两次 `goal/get`、至多一次 `settings/update`、一次 `goal/set`；accepted 后不再为该计划调用 `goal/get` 或分页读取阶段状态；遗留计划每轮最多核对 4 项。所有普通手工消息不增加 GOAL 读取。

清理/回滚：取消合成计划、停止独立容器及服务；标准 59001 卷保留。新续跑意图使投递账本升级为 v3，旧版只读 v2，不能直接回退二进制或删除账本。先验证兼容读取器或单独审查迁移；本节替代旧版“只回退实现提交”对新账本的假设。

## 0.2.22-dev.8 续跑启动即清除标记

本节按用户确认的语义修正此前“完成后清除”的设计：一次性定时计划在实际开始续跑时消费，执行完成状态不属于该计划的生命周期。

前置：独立 HOME 与投递账本，普通会话和暂停的 GOAL 各一个。运行 `pnpm exec vitest run src/server/threadScheduledResume.test.ts src/server/threadScheduledResumeRuntime.test.ts src/server/threadScheduledResume.integration.test.ts src/server/threadScheduledResume.history.integration.test.ts src/server/goalContinuation.integration.test.ts src/server/threadResumeControlService.test.ts src/server/automaticResumeNotice.integration.test.ts`。浏览器使用当前源码的 4173，绑定 `127.0.0.1`，启动前核对监听进程和 cwd，不操作 5173。

1. 为暂停的 GOAL 设置未来计划，确认时钟可见。到点取得原生恢复确认后，GOAL 仍为 active，计划文件、GET `/codex-api/thread-scheduled-resume` 与侧栏标记均立即清除；不产生任何阶段或目标成功完成事件。浅深主题各检查一次，刷新后标记不得恢复。
2. 用持续运行的回合占用会话后设置 GOAL 计划。到点时计划已经 submitted，但实际投递仍 queued，时钟应保留；结束占用后等待真实派发 accepted，GOAL 仍 active 时清除时钟。阶段完成或任意其他启动事件均不能消费尚未实际启动的计划。
3. 普通续跑 accepted 后令回合持续 inProgress，标记应清除且刷新不恢复。发送前失败、错误账号 context、发送中和结果未知应保留标记。GOAL 恢复响应丢失时即使状态查询显示 active，也不能绕过投递确认或重复恢复。
4. 将已 accepted 的旧计划分别保存为 submitted、unknown、failed，再重启核对。均应凭当前计划的持久回执清除，无历史/GOAL 状态 RPC，无二次投递。读取不到原记录的 failed 计划保留待核对，不能自动发送。
5. 仅 `thread/autoResume/started` 中的 scheduled 来源、当前 threadId 与当前 deliveryId 可唤醒核对；仅有事件而尚无持久 accepted 回执时不能提前删除。重复通知合并，提交或核对中收到通知不丢失唤醒。清除后可启用额度续跑或新建未来计划，旧事件不能误清新计划。清除落盘失败应停止调度并报告存储错误，不误记为提交未知而重发。

自动浏览器复核：以 `mktemp -d /tmp/sidux-dev8-4173.XXXXXX` 创建独立目录，设置 `CODEX_HOME` 为该路径、`CODEXUI_CODEX_COMMAND` 为当前仓库的 `src/server/fixtures/account-app-server.cjs`，运行 `pnpm run dev --host 127.0.0.1 --port 4173`。另一终端设置相同目录为 `SIDUX_SCHEDULE_FIXTURE_HOME`，运行 `node scripts/verify-scheduled-resume-markers.cjs`。脚本只替代会话发现、标题和工作区的展示接口；计划、投递、原生恢复、事件流和持久化均走真实实现，不连接云端模型。覆盖浅深主题 × 直接/排队启动四种组合，结果与截图位于 `output/playwright/scheduled-resume-dev8-started/`。

性能预期：每轮最多核对 4 条，9 条遗留失败分三批核对完毕后停止；重复的同一计划启动通知合并。直接 accepted 不需 inspect；排队 accepted 后只读本地持久回执，不增加完成状态查询。浏览器启动清图标只增加一次计划快照 GET。没有新增订阅或全局缓存失效；最后一个计划被消费后不再轮询。

清理/回滚：脚本取消自身计划、暂停合成 GOAL 并关闭测试页，4173 按仓库约定保留；全部数据只在独立临时 HOME。撤回本轮代码并重建可恢复此前行为，保留认证、会话和投递账本；既有 v3 账本回退限制继续适用。
