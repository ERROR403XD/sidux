### Automation editor scrolls on small viewports

#### Feature/Change Name
Automation editor small-device overflow handling.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev --host 127.0.0.1 --port 4173`)
2. At least one thread or project automation exists, or create one from a thread/project menu.
3. Browser viewport set to a small device size such as 375x667.

#### Steps
1. In light theme, open a thread or project menu and choose `Manage automations...`.
2. Confirm the `Edit automation` dialog opens inside the viewport and can be vertically scrolled.
3. Confirm `Run now` when available, `Remove`, `Cancel`, and `Save` remain visible at the bottom before scrolling.
4. Scroll through the dialog and confirm the same bottom actions stay visible while the form content moves behind them.
5. Confirm the name input, prompt textarea, schedule controls, status select, notices, and error text do not overlap while scrolling.
6. Switch to dark theme and repeat steps 1-5.

#### Expected Results
- The automation editor does not extend offscreen without a way to reach lower controls on small-height devices.
- Vertical scrolling stays inside the modal, with the page behind the overlay remaining fixed.
- The automation editor action row remains sticky and usable while the form content scrolls.
- Light and dark theme automation editor controls remain readable and usable.

#### Rollback/Cleanup
- Remove any temporary test automation from the automation dialog if one was created for this test.

---

### 0.1.90 封测：Pad 详情高度与本地时间

- 前置：4173 隔离环境，准备长提示词、5 条以上历史记录的内部任务；分别使用浅/深主题，375×812、768×1024、1024×768、1366×600。
- 操作：打开自动化页面，滚动详情至提示词末尾及执行记录；点击“查看全部”，翻到第 2 页；编辑任务并触摸选择模型、思考强度。
- 预期：详情各块不相互覆盖；任务标题可读；5 条预览仍在提示词下方；弹窗每页固定 100 条，独立滚动且按钮可达；选择选项不会关闭父窗口。
- 时间：浏览器分别使用 Asia/Shanghai、America/New_York；同一 2026-09-06T17:00:00Z 应显示次日 01:00、当日 13:00。调度时区仍单独标注并控制任务执行时间；新任务默认浏览器时区，无法识别时回退 Asia/Shanghai。
- 自动化对话：运行内部样本，来源标签显示任务名称和浏览器本地执行时间；提示词正文不显示内部运行标记和时间元数据；旧 heartbeat 和先前 0.1.90 消息仍能识别。
- 清理：删除测试任务和线程；使用请求夹具时关闭测试浏览器即可，不修改真实日历。
