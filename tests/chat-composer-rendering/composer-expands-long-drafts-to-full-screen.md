### Composer expands long drafts to full screen

#### Feature/Change Name
Thread composer expand control is always visible, including empty drafts.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev --host 127.0.0.1 --port 4173`)
2. Any existing thread is open and send controls are enabled
3. Light theme and dark theme both available from the appearance switcher

#### Steps
1. In light theme, open a thread with an empty draft.
2. Confirm the expand button is already visible; paste long text and verify its scrollbar remains in a separate area.
3. Click the expand button.
4. Confirm the composer fills the area below the header, keeps the draft text, and leaves model/skill/thinking/send controls usable at the bottom.
5. Click the collapse button.
6. Confirm the composer returns to its normal inline size with the draft still intact.
7. Switch to dark theme and repeat steps 1-6.

#### Expected Results
- Empty and short drafts show the expand control.
- Long or overflowing drafts retain the control in its own right-hand column, separated from the textarea scrollbar.
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

### 0.1.89 补充：展开按钮常驻且避开滚动条

前提：59001 的空草稿、单行、长文本三种状态，浅色/深色；桌面及 375×812、768×1024。

操作：不输入文字直接展开/收起；输入长文本，拖动 textarea 的右侧滚动条至底部，再点击其右侧按钮；展开态重复。

预期：按钮始终可见；按钮和滚动条在独立布局列中，拖动滚动条不触发展开；草稿及选择范围保留。

清理：清空本轮草稿。性能：移除为按钮出现条件而执行的逐次输入 scrollHeight/clientHeight 读取、行数计算和 draft watcher；无新增监听或 API。


### 0.2.19 封测：扩大后缩放窗口

前置：4173 当前工作树；使用普通鼠标的桌面，以及触屏键盘几何单测。
操作：先扩大，再把窗口从 1440×1000 缩到 1440×620、1100×620，转到 768×1024 / 375×812 / 375×500，最后恢复；浅深各一轮，输入框保持焦点。然后选中草稿中段，继续改变尺寸并收起。
预期：编辑区底边与内容区底边一致，位于测量后的标题下方，文字和选区不丢；不能把桌面窗口减少的高度误算为键盘占位。触屏且文本输入聚焦、宽度不变时仍允许保留键盘展开前的高度；旋转或退出输入状态时重置。
验证：`pnpm exec vitest run src/virtualKeyboardViewport.test.ts src/components/content/composerCommands.test.ts` 及 `node scripts/test-expanded-composer-ui.cjs`。真实操作系统软键盘未在 headless 浏览器中模拟成实机验收；几何规则单测和现有手机布局分开记录。
清理：清空测试草稿，关闭自建浏览器；无服务器状态修改。
