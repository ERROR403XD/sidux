# Bridge 运行时通知、配置启动与性能记录

前置：独立CODEX_HOME，合成会话与Telegram配置；测试桥接对象只记录配置调用，不发送Telegram消息。性能日志只记录方法、路径、状态、时长和字节数，不记录输入内容/凭据。

1. 发布turn/completed，预期completion→interruption→quotaResume→automation→goal→compaction→processActivity顺序，持久完成标记和问题指标；threadId/turnId沿用原提取规则，不额外trim协议字段。重复处理去重归原store负责。
2. rateLimits/updated只额外触发一次account quota持久观察，普通通知不触发completion/problem；异步持久化失败保持原日志并继续其余observer，不产生未处理rejection。
3. 初始化缺token配置，只应用通知开关和quiet hours，不start；合成token存在时再配置token→allowed ids→start，零真实网络。并发rememberChatId归同一config队列，保留其他字段、去重并最多50项。
4. 用 `CODEXUI_API_PERF_LOGGING=true`、大body/低阈值启动隔离服务，发合成RPC，预期保留write/end二进制响应，finish/close合计只一行性能日志，RPC method和bodyMB正确；关闭开关或非API请求不记录。不要输出真实body/token。
5. 保留已发送header后的响应错误destroy及header前502 JSON合同；正常路由匹配顺序仍branding→connection.ready→proxy→dispatcher。
6. 后台核对缺background capability时返回空、缺loaded capability时拒绝且零RPC；支持时先loaded分页再每线程limit=1核对，沿用4路并发和30秒deadline。identity切换期间compaction直接拒绝、不额外读queue。
7. 自动化虚拟项目创建真实会话目录并登记归属，原生创建/命名使用该cwd；真实目录沿用。prepare仅组装原text/model/effort/serviceTier/clientUserMessageId，不做额外RPC；inspect仍50回合history。账号断开总是取消该账号自动化，仅primary额外取消delivery，异步失败不冒出未处理rejection。

自动化：实际HTTP/响应字节与合成大body、真实完成/问题/Telegram存储、合成通知和桥接seam；既有archive/Telegram回归。未证明真实Telegram网络、UI生命周期或NFS成本。清理本轮fixture，回滚对应提交，不改schema。
