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

## 0.2.22-dev.3：图片消息包装标题泄漏

准备：在独立 `seed-022-baseline` home 启动当前源码的 4173；准备一张 PNG，以及历史 `My request to Codex`、`My request for Codex` 两种附件消息。不得使用真实账号 home。自动化脚本：`scripts/verify-022-image-attachments.cjs`。

操作：

1. 打开两种历史消息，确认图片、文件 chip 和正文显示。
2. 上传 PNG，发送唯一 `TestChat` 标记、粗体、`[guide](/tmp/image-guide.md:12:3)` 和 HTTPS 链接。
3. 发送后检查实际用户消息，再刷新页面复核。
4. 在浅深主题和 1440×1000、768×1024、375×812 视口重复。
5. 单元回归覆盖仅图片、空正文、CRLF、中文标签和多个文件。

预期：两种历史标题都只显示用户正文；`Files mentioned by the user`、内部附件路径标题和 `My request ... Codex` 不出现在正文中。图片与 chip 各一个，图片可解码，chip 指向原图片；正文粗体和网页链接正常，guide 链接的 href/title/text 均正确。一次发送仅一次 delivery，刷新后仍为一条用户消息。

复验命令（先按项目规范检查 4173 监听和 cwd）：

```bash
node scripts/seed-022-baseline.cjs /tmp/sidux-022-image-check empty
CODEX_HOME=/tmp/sidux-022-image-check CODEXUI_CODEX_COMMAND="$PWD/src/server/fixtures/022-baseline-app-server.cjs" pnpm run dev --host 127.0.0.1 --port 4173
# 在另一个终端执行，IMAGE_TEST_FILE 指向自己的 PNG。
FILE_UI_HOME=/tmp/sidux-022-image-check IMAGE_TEST_FILE=/absolute/path/image.png node scripts/verify-022-image-attachments.cjs
```

清理/回退：脚本删除自己创建的合成会话 JSON，上传文件留在系统临时上传目录；仅在确认归属后清理本轮文件。4173 按项目规范保留。修复只涉及显示解析，撤回对应源码提交即可，不修改历史会话或删除用户附件。
