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

10. OpenAI 后台额度刷新保持进行中（未切换账号）时，测试并添加新自定义连接：两步均成功，保存不再调用提供方切换检查；正常上游共八次探测（目录、双协议、五个推理档位），选定协议返回额度错误时仅三次，保存不重复探测；主账号认证和选择不变，新连接不自动激活。切换/编辑已有连接的原有保护仍保留。运行 `pnpm exec vitest run src/server/customConnectionAdmission.test.ts` 可用本地 HTTP/IPC 样本复现。

清理：移除样本账号、API key、自动化与测试会话；停止只属于本次验收的服务和容器，不更改生产账号或消耗真实重置机会。

## 0.2.22-dev.3 自定义连接额度错误视为测试通过

前提：隔离 `CODEX_HOME`；本地样本上游提供可控的 models、Responses、Chat 响应，凭据使用合成值。自动回归：`pnpm exec vitest run src/server/customConnectionStore.test.ts src/server/customConnectionAdmission.test.ts src/server/customConnectionEfforts.test.ts src/server/customConnectionPayload.test.ts src/server/apiProxy/customConnections.test.ts`。

1. 设置 → 自定义连接 → 添加账号，填写样本地址和 key。让生成端点返回 429 或 402：点击「测试连接」，预期显示「连接成功」，相应端点绿色点亮，「保存配置」可用；Responses 被限流、Chat 正常时仍保留 Responses 支持。
2. 重复返回 400/403/503，错误中明确给出 `insufficient_quota`、`usage_limit_reached`、`resource_exhausted`、余额不足或额度耗尽；预期同样通过。HTTP 200 内的明确额度错误也通过；额度文本提到 reasoning 不得删除推理档位。
3. models 本身返回额度错误时，先手填模型再测试：models 仍标为支持。未填写模型且未取得目录时，预期要求填写模型名，不伪造模型。让另一生成端点返回 404，确认它仍灰暗。
4. 保存并刷新页面，预期端点、默认协议、模型与推理档位保留，新增账号不自动激活，OpenAI 主账号与认证不变。选定协议已受额度限制时仅请求目录和两个协议，不继续五个档位探测，保存不追加请求。
5. 对照 401、普通权限不足（包括「Insufficient permissions to read quota」）、404/405、未知模型、普通 500、无有效生成结构的 200：预期不能当作通过。已有真实能力拒绝仍按原结果处理。
6. 页面检查使用当前源码的 `http://127.0.0.1:4173/`，1440×1000，浅/深主题；运行 `node docs/plans/evidence/022-dev3-custom-quota-20261015/verify-ui.cjs`，检查实际添加弹窗的成功提示和三个端点，再保存、刷新核对卡片。

清理/回滚：脚本只移除本轮创建的合成连接并停止样本服务；保留既有账号与认证。撤回本次探测判定修改即可恢复旧行为，无配置格式或数据迁移。标准测试 59001 与生产 5900 的更新沿用各自独立流程。

## 0.2.22 统一自定义连接参数裁剪

前提：隔离 CODEX_HOME；本地样本上游可记录 Chat/Responses 请求体。运行 `pnpm exec vitest run src/server/customConnectionPayload.test.ts src/server/customConnectionEfforts.test.ts`。

1. 对声明 `efforts/serviceTiers` 的模型，分别通过 API key 出口和 Codex 运行时接口发送 `reasoning`、`reasoning_effort`、`service_tier` 及一个未知业务字段。预期三类能力字段与未知字段完整透传。
2. 对未声明能力的模型重复发送。预期仅移除 `reasoning`、`reasoning_effort`、`service_tier`，未知字段保留。
3. 未传 `model` 的 API key 出口请求先继承连接默认模型，再按该模型能力裁剪；显式 `model` 始终按显式模型裁剪。
4. 检查原生 Responses、Chat 直连与两个协议桥方向的请求体，确认复用同一裁剪结果；原输入对象不被原地修改。
5. 清理/回滚：移除样本连接并停止样本上游；还原 022-01A 提交即可，不涉及持久化迁移。

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

## 0.2.20-dev 协议桥：Chat-only 自定义连接启用 Codex

前提：隔离 CODEX_HOME；一个仅支持 Chat Completions 的本地样本服务（固定回复 + 可控流式分片）；一个同时支持 Responses/Chat 的样本服务作对照。组件单测：`pnpm run test:bridge`；集成单测：`pnpm exec vitest run src/server/protocolBridgeTransport.test.ts src/server/customConnectionStore.test.ts src/server/apiProxy/customConnections.test.ts`。

1. 添加 Chat-only 连接并测试：卡片 responses 徽标亮起（由协议桥服务），chat 徽标亮起；切换按钮可用（不再禁用）；选中后刷新页面，选择保持。
2. 选中 Chat-only 连接新建会话，发送短消息：Codex 正常回复，无 provider not found/409/502；上游收到的是 Chat Completions 请求（样本服务断言 `/chat/completions` 被调用、请求含 `messages`），前端收到完整回复文本。
3. 让样本服务返回工具调用（流式 delta 分片）：Codex 侧触发工具执行并回传结果，多轮工具回路闭环；参数跨多 chunk 时 JSON 完整。
4. 让样本服务先发 reasoning_content 再发正文：界面实时显示推理浮层，最终消息完整；深浅主题检查。
5. 上游返回 4xx/5xx：Codex 显示上游原始错误信息（非 Proxy error 包装），刷新后错误态保持。
6. 客户端中途关闭页面：上游请求被取消（样本服务记录断连），服务端日志出现 [protocol-bridge] 结束行，无进程异常。
7. 对照组：Responses 原生连接走旧链路（样本服务断言 `/responses` 被调用），行为与本节改动前一致；API 出口（apiProxy）对 Chat-only 连接的 `/v1/chat/completions` 直通与 `/v1/models` 不变，`/v1/responses/compact` 仍返回 unsupported_endpoint。
8. 自动化任务选择 Chat-only 连接可正常领取执行（不再报「Codex 需要 Responses API」）。

清理：移除样本连接与会话；停止样本服务；不影响生产账号与认证文件。

## 0.2.20-dev.4 协议转换开关、黄色能力 tag 与 API 代理通知

前提：隔离 CODEX_HOME；三个本地样本服务：仅 Chat Completions、仅 Responses、同时支持两者；一个已启用的 API 出口（服务与账号配置可用）。涉及单元测试：`pnpm run test:bridge`、`pnpm exec vitest run src/server/customConnectionStore.test.ts src/server/apiProxy/customConnections.test.ts src/server/protocolBridgeTransport.test.ts`。

1. 添加仅 Chat 连接并在账号设置中查看：出现「协议转换」开关（默认关）。关闭状态下卡片 responses 徽标灰暗、切换按钮禁用（悬停提示开启协议转换）；API 出口对该连接的 `/v1/responses` 返回 unsupported_endpoint。
2. 开启「协议转换」并保存：不需要重新测试连接（保存直接成功，revision+1）；卡片 responses 徽标变黄（经协议转换）；切换按钮可用；选中后 Codex 可正常对话与工具回路。
3. 活跃连接的开关被关闭：保存成功且当前选择自动取消（activeId 置空）；重新开启后需手动重新选择。
4. 添加仅 Responses 连接并开启「协议转换」：卡片 chat 徽标变黄；在 API 出口为该连接创建 API key，key 行与创建/账号弹窗中的端点 tag 同步显示黄色 chat；外部客户端 `POST /v1/chat/completions` 经反向转换由上游 Responses 服务，返回标准 chat 响应。
5. 保存开关后刷新页面：开关状态、黄色徽标、激活状态持久保持。
6. 同时支持两协议的连接：账号设置中不显示「协议转换」开关（无缺失端点）。
7. API 出口通知（izitoast 风格，右上角成功绿条）：服务与账号点「保存」→「API 代理配置已保存」；API key 区点「保存配置」→有实际改动时「API key 配置已保存」，逐 key 无变化时保持静默不提示；「创建API key」→「API key 已创建」；「轮换」→「API key 已轮换，旧 key 24 小时后到期」；「撤销…」确认后 →「API key 已撤销」。失败路径仍显示红色错误。
8. 对照组：OpenAI 账号反代（CLI Proxy API）行为不变——OpenAI 账号的 key 路由、受保护开关、WebSocket 适配均不出现协议桥相关改动；原生 Responses 自定义连接 `/v1/responses` 仍走旧直通链路。
9. 明暗主题下检查黄色 tag（浅色 #fefce8 底、深色 #33270a 底）与绿色原生 tag 的对比度；375×812 下弹窗内开关与 tag 不溢出。

清理：移除样本连接、key 与会话；停止样本服务；不影响生产账号与认证文件。

## 0.2.20-dev.5 协议转换开关样式与能力 tag 换行（承接 dev.4 收尾）

前提：隔离 CODEX_HOME；一个缺少 chat 或 responses 端点的自定义连接（已测试）；API 出口面板可为该连接创建 API key。纯样式改动 + key 行 DOM 微调，无新增单测。

1. 打开自定义连接的「账号设置」弹窗：协议转换开关只有文字与滑块本体，无外框线、无按钮底色（弹窗旧按钮桥接规则不再命中 AppSwitch）；悬停开关不出现底色变化；键盘聚焦仍有 focus 外圈。其他弹窗内的 AppSwitch（如撤销确认、受保护）同步回归 plain 样式，弹窗内普通按钮样式不变。
2. API key 行为 grid 布局：标题/最近使用在卡片第一行左列，重命名/启用/轮换/撤销/高级选项按钮在第一行右列；第二行左列是账号下拉（含「聚合账号」），右列是端点能力 tag，tag 右缘与操作按钮右缘对齐（即卡片内容区右缘）。
3. 压缩卡片可用宽度（key 卡片容器 ≤860px，与窗口宽度无关、自动适应侧栏开合）：key 行切为单列，顺序为标题 → 账号下拉 → 端点 tag → 操作按钮；375×812 下不横向溢出。
4. 中间宽度（约 768–950，侧栏展开）不得把标题压成细条：容器列宽与卡片内容区一致，标题列在双列区间保持可读宽度。
5. 明暗主题分别检查步骤 1–4：弹窗无残留边框，tag 底色符合黄/绿三态；页面无水平滚动条。

回滚/清理：还原 `src/style.css` 中弹窗按钮桥接规则的 `.app-switch` 排除、`.custom-connection-bridge` / 弹窗内 `.app-select` 宽度规则，并把 `CustomConnections.vue` 的协议转换说明文字加回即可；移除样本连接与 key，停止样本服务。

## 0.2.20-dev.6 自定义连接推理强度自动探测

前提：隔离 CODEX_HOME；本地样本上游（可控制「chat 正常服务 / 400 点名拒绝 reasoning_effort / 仅拒绝特定档位」）。涉及单元测试：`pnpm exec vitest run src/server/customConnectionStore.test.ts src/server/customConnectionEfforts.test.ts`；UI 验证脚本 `output/playwright/verify-dev6-efforts-ui.cjs`（4413/4414/4415 三个样本上游）。

1. 表单无任何推理强度控件：「模型」输入框与「协议转换」开关各占一半同排（开关缺失时模型退回单列），端点能力 tag 独立一行；明暗主题、375×812 无横向溢出。
2. 自动探测：连接测试时在解析出的 wire 上对 5 个档位（minimal/low/medium/high/xhigh）各发一个 16-token 探针；档位被上游「点名拒绝」才从选择器剔除，静默忽略与无关失败一律保留（默认全支持）。
3. 接受型上游：保存后 `GET /codex-api/custom-connections` 的 `reasoningEfforts` 为全部 5 档；`/codex-api/accounts/models?storageId=<id>` 的 `supportedReasoningEfforts` 一致；会话输入框推理强度选择器列出 5 档，选中即随请求发送。
4. 值级拒绝：上游仅对 xhigh 报错点名 → `reasoningEfforts` 为其余 4 档，选择器不出现 xhigh。
5. 参数级拒绝：上游对所有带参探针报错点名 → `reasoningEfforts` 为空 → 选择器显示 N/A（与旧未声明态一致），请求不含 reasoning 参数。
6. 结果刷新时机：只有「测试连接」产生新探测结果；不重新测试的保存（凭据未变的免复测路径）保留原 `reasoningEfforts`，revision 照常 +1。
7. 兼容：旧状态文件的 `reasoningEfforts` 规范化加载；dev.4 起保留合法的 max、ultra 等目录值，无该字段视为未探测。

回滚/清理：还原 `src/customConnections.ts`、`src/server/customConnectionStore.ts`、`src/components/accounts/CustomConnections.vue` 与 `src/style.css` 即可；状态文件无需迁移。移除样本连接，停止样本服务。

## 0.2.21-dev.3 推理探测后的选择器稳定与 system 消息前置

前提：隔离 `CODEX_HOME`；一个已选中的 Chat-only 自定义连接，开启「协议转换」，并保存两个可选模型。准备一个会把后置 `system`/`developer` 消息原样转给 Chat 模板的样本上游，或使用协议桥单元测试夹具。

1. 在会话模型选择器中选择第二个模型，打开账号设置，点击「测试连接」并保存。凭据与执行身份不变时，模型选择器不得先跳回上次连接配置的第一个模型再跳回用户选择；输入框不出现「模型目录暂时不可用」。
2. 仅修改别名或协议转换开关后直接保存（不重新测试）：模型与推理强度选项保持不变；重新测试后推理档位按新探测结果更新。
3. 通过该连接发起包含历史 `system`/`developer` 消息的 Responses 请求。转换后的 Chat `messages` 必须把所有 system 消息按原相对顺序放到开头，再保留 user/assistant/tool 顺序；请求不再因上游模板返回 `System message must be at the beginning.` / `wrong_api_format` 失败。
4. 对照原生 Responses 连接与 OpenAI 账号：模型目录请求、推理强度探测和消息顺序均不经过 Responses→Chat 重排逻辑。

回滚/清理：还原 `src/App.vue` 与 `protocol-bridge/src/chat/requestDecoder.ts`，移除样本连接并停止样本上游；不迁移连接状态文件。

## 0.2.21-dev.3 手动模型目录与 Responses-only 反向转换

前提：隔离 `CODEX_HOME`；三个本地样本服务分别提供：仅 Responses、仅 Chat、仅 Responses 且 `/models` 返回 404。运行 `pnpm exec vitest run src/server/customConnectionStore.test.ts src/server/apiProxy/customConnections.test.ts` 与 `pnpm run test:bridge`。

1. 仅 Responses 连接开启「协议转换」：卡片与 API key 行的 chat 端点 tag 显示黄色，Responses 仍为原生绿色；外部客户端调用 `/v1/chat/completions` 时由本地协议桥反向转换到上游 Responses，响应符合 Chat 格式。账号设置 UI、开关与持久化行为沿用 Chat-only 转 Responses 的相同处理。
2. `/models` 不可用但在连接表单中添加至少一个手动模型：models tag 显示黄色，模型选择器不再要求探测目录；重复 ID 去重、空 ID 拒绝、可逐项移除，保存并刷新后列表保持。若后续 models 探测成功，原生目录优先，manual tag 恢复为原生 models tag。
3. 明暗主题、中英文、1440×1000、768×1024、375×812 检查手动模型列表、黄色 tag 和上下文摘要；无横向溢出，黄色 tag 与原生绿色可明确区分。

回滚/清理：移除样本连接与会话，停止样本服务；不迁移连接状态文件。

### 0.2.21-dev.3：手动端点的互斥显示

前提：浏览器接口样本中配置一个仅原生支持 Responses、手动维护 models 的连接；API key 固定到同一连接，不向上游发送测试请求。

1. 查看保存后的账号卡片、账号设置弹窗和 API key 卡片。models 均为黄色“手动维护”，responses 为绿色“支持”，未开启转换的 chat 为不支持。
2. 刷新页面，状态保持一致；原生支持 models 的连接仍显示绿色，桥接 chat 保留黄色“经协议转换”。
3. 明暗主题检查真实卡片 class、aria-label 与颜色，不能只验收首页或侧栏。
4. 清理：关闭样本浏览器上下文和拦截，不改真实连接配置；本项不改变持久模型目录或接口行为。


## 0.2.22-dev.4：Magpie 逐模型档位、Fast 与旧缓存

前置：独立 4173，合成 `/v1/models` 返回 `supported_reasoning_levels` / `service_tiers`；Sol 声明 max、ultra 和 priority，Luna 只声明 max，另一模型不声明服务档位。使用 `node scripts/verify-022-magpie-capabilities.cjs`，真实连接只在候选环境验收。

1. 测试并保存连接，打开会话模型菜单；Sol 显示完整原始档位，Luna 不额外出现 ultra，无档位声明的其他模型不继承默认模型探测结果。显式空数组同样不得被探测覆盖。
2. Sol 选择 ultra 与 Fast，刷新后仍保持；发送捕获的 `turn/start` 参数包含 `effort: ultra`、协作设置中的 ultra 和 `serviceTier: priority`。切到无服务档位声明的模型，Fast 禁用。
3. 在隔离旧状态文件移除 capabilitiesVersion 并保留旧空能力缓存，重新打开模型目录：同一连接只发一个元数据 GET，更新缓存为版本 2，恢复 max/ultra/Fast；账号选择、凭据、revision 和 runtime token 不变。失败保留旧缓存，最多每分钟重试一次，不发生成探针。
4. 新连接的默认模型已经声明推理能力时，仅运行目录 GET 与两个协议可用性探针，共 3 个请求；缺少声明时才对该默认模型运行原兼容探针。探测结果不得覆盖其他模型的声明。
5. `node scripts/verify-022-custom-ultra.cjs` 使用独立 home 和本地截获服务，核对原生 Codex Ultra 主动子代理提示/工具、priority，以及其转换后的普通请求强度。不同 Codex 版本可能选择 xhigh 或 max，不能将 UI 字面值或一次完成当作上游 Fast/Ultra 执行保证。

性能：旧缓存迁移按连接合并并发请求，最多缓存 32 项，4 秒超时；新格式无需额外目录 GET。默认模型已声明能力时，探测从 8 请求降为 3 请求。
清理：脚本删除其合成连接和临时 home，不切换生产连接。回滚源码前保留连接状态备份；新增 capabilitiesVersion 不改变凭据和运行身份。

## 0.2.22-dev.4：保留自定义连接的供应商/模型 ID

前提：隔离连接目录返回两条模型，ID 分别为 `sidux/sol` 和 `chatgpt-api/sol`，但两条的 `display_name` 与底层 `model` 相同；另准备已缓存旧显示名称的连接。

1. 打开模型选择器，浅色和深色主题均显示完整的两个 ID，可按供应商前缀搜索、独立选择。收起后的按钮与菜单标题也保留供应商前缀，不缩写为 Sol 等模型家族名；窄屏仅视觉省略，title 保留完整 ID。
2. 分别选择、刷新再发送；记忆与请求中的模型保留所选完整 ID，不改写成底层模型名。
3. 已保存连接直接重开目录也恢复完整 ID，不需要删除连接或重新测试。OAI 原有模型显示名称和 wire model 不变。

性能：只在已有目录映射中处理字符串，不增加请求、探针或缓存失效。清理：移除合成连接；回退时仅回退对应源码，不清空连接状态。

## 0.2.22-dev.4：自定义连接 Fast 参数开关

前提：独立 CODEX_HOME；准备未声明服务档位的两个合成上游，其中一个支持 `service_tier: priority`，另一个收到此参数返回 400。`node scripts/verify-022-magpie-fast.cjs` 检查真实表单与发送设置；HTTP 回归见 `customConnectionEfforts.test.ts`。

1. 新建或打开旧连接的「账号设置」，默认关闭「允许 Fast 参数」。未声明 Fast 的模型按钮禁用；直接向本地转发接口请求 priority 时仍过滤，严格上游正常返回。
2. 在支持参数的连接开启开关，直接保存，无需重新测试。回到会话 Fast 可点击；开启 Fast 并刷新，按钮状态和完整模型 ID 保留，发送设置为 `serviceTier: priority`。
3. 检查真实 Chat Completions 与 Responses 上游收到 `service_tier: priority`；关闭开关后无声明模型、手动模型和仅声明 standard 的模型均恢复过滤，包括旧偏好或队列传来的 priority。目录原本声明 Fast 的模型不受此开关关闭影响；其他连接保持原设置。
4. 手动添加的模型同样支持开关。仅更改开关不增加目录 GET 或生成探针，不修改原始能力声明；重启后保持。旧客户端未提交开关字段时不重置已保存值。
5. 在 1440×1000、375×812 和 768×1024 的浅色、深色主题检查表单、保存按钮和开关；开关下方无额外说明文字，弹窗不横向越界，失败不假报成功。

性能：复用既有目录映射及请求过滤器，不增加请求、轮询、监听或依赖。清理：移除合成连接；错误开启时关闭该连接开关即可，勿清空认证、会话或模型偏好。
