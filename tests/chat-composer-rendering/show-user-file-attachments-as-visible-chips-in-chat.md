### Feature: Show user file attachments as visible chips in chat

#### Prerequisites
- Start the app from this repository (`pnpm run dev`).
- Open any thread with an active composer.
- Have at least one local file available to attach.

#### Steps
1. Attach one or more files via composer (file picker, paste long text as `.txt`, or other file attachment flow).
2. Send the message.
3. Locate the sent user message in conversation.
4. Verify file attachment chips are rendered above message text.
5. Click a file chip and confirm it opens the browse URL in a new tab/window.
6. Right-click the chip link and verify file-link context actions still appear (`Open link`, `Copy link`, and `Edit file` when applicable).

#### Expected Results
- Sent user messages with `fileAttachments` show visible file chips in chat.
- Chip labels match attachment labels from composer payload.
- Chip links resolve through browse URLs and remain clickable.
- Existing file-link context menu behavior works on the chip links.

#### Rollback/Cleanup
- Close any opened file tabs and remove temporary test messages if needed.

## 2026-09-11 图片消息只显示一次

准备：4173/59001 虚构会话，图片模型、图片上传和原生回显 fixture；浅深主题，1440/768/375px。

操作：附加一张图片，发送唯一文本及 Markdown 文件链接；回显后、刷新后分别数用户消息和图片。覆盖原生 clientId、缺失 ID 且图片 URL 为绝对/相对两种形式；同 turn 发送相同内容但不同发送 ID/消息序号。

预期：一次发送只有一份文本和一张图片；原生 clientId 替换对应占位消息。图片附带的文件 chip 不影响去重；不同 ID 或序号的真实消息仍保留。记录 nativeStarts 验证没有重复提交，文件链接 href/title/text 正确。

验证：normalizers/useDesktopState/userQuestions 共 76 项通过；浏览器复现脚本 output/0217/composer-fixes-ui.cjs。

清理：关闭 fixture 页面，不操作真实任务。性能：图片/附件归一化只用于同 turn 占位匹配，沿用原有消息合并，不新增网络或计时器。
