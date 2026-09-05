### Composer expands long drafts to full screen

#### Feature/Change Name
Thread composer full-screen expand control for multi-line drafts.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev --host 127.0.0.1 --port 4173`)
2. Any existing thread is open and send controls are enabled
3. Light theme and dark theme both available from the appearance switcher

#### Steps
1. In light theme, type or paste at least six lines into the composer.
2. Confirm the expand button appears in the composer input area.
3. Click the expand button.
4. Confirm the composer fills the viewport, keeps the draft text, and leaves model/skill/thinking/send controls usable at the bottom.
5. Click the collapse button.
6. Confirm the composer returns to its normal inline size with the draft still intact.
7. Switch to dark theme and repeat steps 1-6.

#### Expected Results
- Short drafts do not show the expand control.
- Long or overflowing drafts show an icon-only expand control.
- Full-screen mode uses the same draft state and submit controls as inline mode.
- Full-screen and inline states are readable in light theme and dark theme.

#### Rollback/Cleanup
- Clear the draft from the composer.

---

### 0.1.89：展开编辑器避让顶部栏

前提：59001 候选环境，含长草稿及多种附件的测试线程，浅色/深色。

步骤：选择草稿中段文字，展开再收起；检查草稿、选择范围和附件保留。展开时输入首行、滚动长文本，操作附件、文件提及和模型菜单及底部发送区。分别检查 1440×900、1366×600、375×812、768×1024，浏览器缩放 100%/125%/150%；实际手机打开软键盘重复操作。

预期：首行和收起按钮在顶部栏下方，附件可滚动，发送区可见；内容列尺寸随窗口调整；顶部栏可操作，浅色/深色无反色面板；手机键盘不遮挡底部控件。

清理：丢弃测试草稿和测试附件；恢复缩放及主题。

性能：仅一个 header ResizeObserver，无逐帧轮询，卸载断开；展开态 CSS 限定包含块，不卸载/重建输入框，不增加 API 请求。浏览器尺寸及真实键盘视觉验收须单独记录。
