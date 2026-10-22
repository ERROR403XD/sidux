### Feature: Restore clipboard image paste attachments in composer

#### Prerequisites
- Start the app from this repository (`pnpm run dev`).
- Open any thread where the composer is enabled.
- Have an image copied to system clipboard (for example screenshot copy).

#### Steps
1. Focus the composer textarea.
2. Paste clipboard content that contains only an image file payload.
3. Confirm an image chip/preview is added to composer attachments.
4. Copy plain text only and paste into composer.
5. Copy mixed content (plain text + image, if source provides both) and paste once.
6. Copy long plain text (at least 2000 characters) and paste into composer.
7. Confirm the long text is attached as a `.txt` file instead of being inserted into the textarea.
8. Send the message with the pasted image/text attachment.

#### Expected Results
- Image-only clipboard paste adds an image attachment to composer.
- Plain-text paste still inserts text into the composer and does not create an attachment.
- Mixed payload paste attaches the image while preserving text paste behavior.
- Long plain-text paste (>= 2000 chars) creates a `.txt` attachment and does not insert raw text into the textarea.
- Sending proceeds with the attached pasted image.

#### Rollback/Cleanup
- Remove the attached image chip from composer if not needed.

### dev.8 审核：长文本附件上传失败反馈（R77，未修复）

前置：当前源码的独立4173；隔离浏览器上下文。脚本挂载真实ThreadComposer与media gateway，拦截所有API请求，不实际上传文件或发送模型消息。

1. 运行 `node docs/baseline/022/dev8-review-20261020/attachment-failure-ui.cjs`。
2. 在已有草稿后粘贴超过2000字符的合成文本；HTTP200对照返回合成文件路径。
3. 在新的浏览器上下文重复相同操作，只将上传响应改成HTTP503。

预期：成功后有附件chip；失败应有可见提示，并保留可重试的附件或粘贴文本。两种情况下原有草稿均保留，每次仅请求一次上传。

实际：2场景12检查，10通过/2失败；503时没有错误提示、附件chip或粘贴文本，页面仍只显示原草稿及其“Saved”。这不意味着剪贴板原文被删除，用户仍可重新粘贴。HTTP200对照正常，无pageerror或外部请求。

证据：审核目录 `results/attachment-failure-ui.json`。URL为 `http://127.0.0.1:4173/output/playwright/dev8-full-audit/attachment-failure/harness.html`，1440×1000浅色；同一逻辑不重复主题/尺寸矩阵。截图：

![上传成功对照](/mnt/NAS02-Code/Sidux/output/playwright/dev8-full-audit/attachment-failure/upload-200-1440-light.png)

![上传503后未显示失败或粘贴文本](/mnt/NAS02-Code/Sidux/output/playwright/dev8-full-audit/attachment-failure/upload-503-1440-light.png)

清理：脚本关闭浏览器和上下文，保留4173；只生成自有harness、截图与JSON，没有真实文件上传、会话写入或产品改动。
