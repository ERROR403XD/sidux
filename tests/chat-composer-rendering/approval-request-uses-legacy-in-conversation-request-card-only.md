### 功能：审批只显示一个请求面板，并支持错误重试

#### 前置条件
- 4173 运行当前源码和独立合成 home。
- 自动验证：`FILE_UI_HOME=<独立合成home> node scripts/verify-022-approval-integration.cjs`，控制审批通知/503，但 TestChat 发送及刷新使用真实 HTTP、fixture 子进程和磁盘。
- 手工触发命令、文件或权限审批；准备一个能让审批回应失败的测试环境。

#### 操作
1. 输入草稿，触发命令审批；观察实际会话页的请求面板和输入区。
2. 在备注框用 IME 确认候选，验证 composition/isComposing/229 Enter 不发送决策。
3. 让审批回应返回 HTTP 503；确认当前请求旁显示错误、保留选择/备注并可重试。
4. 重试成功，确认面板退出、原草稿恢复；失败时不能发送后续备注消息。
5. 重复文件审批和权限审批，核对对应的 decision 或 permissions/scope 合同。
6. 发送唯一 TestChat marker、加粗、带行列号的文件链接和 HTTP 链接；检查 href/title/text，刷新后再次核对。
7. 重复亮暗、中英文、1440×1000、768×1024、375×812。

#### 预期
- 当前 0.2.22 的阻塞审批由 `ThreadPendingRequestPanel` 唯一展示；标准输入框暂时卸载，恢复时保留草稿。异步问题仍沿用已有输入合同。
- HTTP 失败明确可见，重试开始清除旧错误；成功/已解决/剪枝/停止/账号变更清理对应错误，迟到失败不污染其他请求。
- 失败不产生后续发送。三个审批类型返回各自协议格式，不产生重复面板或重复决策。
- 实际 TestChat 与刷新后 hrefOk/titleOk/textOk 均为 true。

#### 清理
- 自动脚本精确删除自己创建的合成会话；报告和截图位于 `output/playwright/022-interactions/approval/`。
- 手工测试只清理自己的审批与草稿，恢复偏好。
