# 0.2.17 自定义连接与端点能力

前提：使用隔离 CODEX_HOME；准备两个本地样本服务：同时支持 Responses/Chat Completions，以及仅支持 Chat Completions。每种服务提供不同固定回复；另准备 models 返回 404 的服务。凭据只使用样本值。

1. 设置 → 自定义连接 → 添加账号，填写别名、提供方、Base URL、API key；测试连接并确认。预期分别探测 models、responses 和 chat/completions，卡片固定显示 models / responses / chat 三个带框状态，成功端点点亮，未支持端点灰暗；无 models 时要求手动模型名；保存不重复发送测试请求。
2. 对仅支持 Chat 的账号：responses 状态灰暗，切换按钮禁用；不再显示“仅 API key 出口”或 Chat-only 标记；自动化账号列表不出现它。直接请求账号选择或 Codex 运行接口也应拒绝该连接。
3. 编辑已有账号，密钥留空，再次测试并确认。预期保留原密钥、刷新模型及端点能力。让样本移除 Responses 支持后复测：卡片变成 API 专用且取消当前选择；模型能力与端点缓存更新。
4. 支持 Responses 的账号切换成功后刷新页面：别名、当前选择及模型保留；没有 quota、登录、定时激活或保护设置。缺少 reasoning/Fast 元数据时，会话模型选择器左侧标题保持“推理强度”/Reasoning effort，右侧值为 N/A、灰色滑条不可拖动，目标和自动化强度选择禁用，Fast 禁用。若提供明确能力，显示原始能力值并允许支持项。
5. 两把 API key 固定选择不同自定义账号，并发请求各自支持的接口。预期返回各自回复、计量归入各自 key；不访问 OpenAI 凭据。请求未通过检测的 Responses、compact、models 等端点返回 404，不产生上游请求。自定义连接不提供未经检测的 WebSocket 适配。
6. 在 OpenAI 会话运行时，另一个自定义账号用于自动化/API；完成后核对 OpenAI 主账号、原回合和认证文件不受影响。切回 OpenAI 继续沿用既有切换阻塞、账号保护和出口路由。
7. 添加与编辑窗口的字段顺序一致；测试连接位于底部左侧，右侧依次为取消/移除和确定。未测试时确定禁用；取消不创建账号。卡片不显示 Base URL、模型名，编辑窗口仍保留这些字段。
8. 侧栏展开账号弹出区：两张 OpenAI 卡和三张自定义卡共用一个滚动条，OpenAI 在前；滚到顶和底都能完整查看对应账号，底部版本/全局设置保持可见，不发生账号区域挤压。
9. 明暗主题、中英文、1440×1000、375×812、768×1024 检查添加/编辑窗口、账号卡、账号选项、目标与自动化控件；页面不横向溢出，不存在原生 checkbox。

10. OpenAI 后台额度刷新保持进行中（未切换账号）时，测试并添加新自定义连接：两步均成功，保存不再调用提供方切换检查；上游共三次探测、保存不重复探测，主账号认证和选择不变，新连接不自动激活。切换/编辑已有连接的原有保护仍保留。运行 `pnpm exec vitest run src/server/customConnectionAdmission.test.ts` 可用本地 HTTP/IPC 样本复现。

清理：移除样本账号、API key、自动化与测试会话；停止只属于本次验收的服务和容器，不更改生产账号或消耗真实重置机会。

## 0.2.18 自定义会话跨出口恢复

前提：隔离开发 home；有可用 Responses 自定义连接（真实验收使用 POE），记录当前连接和认证文件摘要。另开一个保持执行中的普通账号会话。

1. 选择自定义连接，新建会话发送简短消息，等待成功后刷新页面。预期历史完整、无 provider not found/502、无重复错误提示。
2. 切回普通账号，再打开上述自定义会话；预期加载成功，选择仍为普通账号，认证文件不变，另一会话继续执行。
3. 再选择自定义连接并打开原会话，预期恢复成功；切回普通账号后直接发送，覆盖替换 worker 自动恢复路径。此步可用 IPC fixture，避免真实账号消耗。
4. 对自定义历史创建分支，预期按当前 worker 出口恢复，不依赖旧 worker 的 provider 注册表。
5. 运行 `pnpm exec vitest run src/server/accountRuntimeIntegration.test.ts`，确认显式恢复、发送前隐式恢复、自定义自动化与普通账号并发隔离通过。

清理：恢复原连接选择；保留验收会话供复核，确认后归档。停止本次专用测试容器，不改生产服务和认证。

## 0.2.18 跨账号恢复矩阵

前提：运行环境有 node_modules；全部使用临时 home、合成认证、IPC fixture，不修改服务或真实账号。

执行 `pnpm exec vitest run src/server/providerResumeMatrix.test.ts src/server/accountRuntimeIntegration.test.ts src/server/accountTaskRouting.test.ts src/server/accountAuthCoordinator.test.ts src/server/customConnectionStore.test.ts`。

预期：普通账号 A/B、Responses 自定义连接 A/B、旧 Zen、旧 OpenRouter、旧自定义端点，共 7 个出口、49 个有向组合，每组验证显式恢复、分支、直接发送前隐式恢复（147 个路径）；历史由源出口创建并完成首回合，目标 worker 的 provider 与选择一致，普通账号发送使用目标身份。既有测试继续验证事务切换、忙碌阻塞、回滚、自定义自动化隔离。此矩阵直接设置隔离存储中的选择状态，验证恢复路由，不代表真实 HTTP 切换入口或各厂商远端请求均做过验收。

清理：脚本等待自身子进程退出后删除临时 home，无真实云端费用。Chat-only 连接按既有规则禁止作为会话出口；移除连接、失效凭据、目标模型不支持等错误不属于此 provider 注册修复。
