### Thread list startup pagination and direct older-thread links

#### Feature/Change Name
Thread loading uses a smaller initial list page, hydrates later pages in the background, and direct thread URLs are not rejected just because the thread is outside the first page.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Browser dev tools Network panel open
3. More than 50 existing threads, including a valid older thread outside the first updated page

#### Steps
1. Open the app home route
2. Inspect the first `thread/list` RPC request
3. Keep the app open and watch subsequent `thread/list` RPC requests
4. Open `/thread/<older-thread-id>` directly for a valid thread outside the first page

#### Expected Results
- The first `thread/list` request uses a smaller initial limit instead of 100
- Later thread pages load in the background using `nextCursor`
- The sidebar gains older threads as background pages complete
- The direct older thread URL stays on the thread route and loads messages instead of redirecting home

#### Rollback/Cleanup
- None

---
### 0.2.22 R5/Q04：迟到分页与停止代次

前提：隔离候选，至少两页会话；在测试运行时延迟第二页响应。

操作：第二页等待期间触发同一会话运行状态更新，再返回旧 idle 列表。另一次等待期间停止轮询，返回响应；重新开始轮询后请求新页，再让旧代次完成。

预期：新运行状态保留；停止后的旧分页不提交或新增 timer；新代次正常加载，旧完成不会清除它的加载标志。

清理：恢复分页响应与轮询设置，关闭测试页面；不改动会话内容。

---
### 0.2.22-dev.6：运行中的会话不阻塞项目历史分页

前提：使用隔离的 `4173` 验证环境或 `59001` 候选。准备至少三页未归档会话，首屏 50 条包含持续运行的会话或长 GOAL，另一个项目的历史全部在后续页；打开 Network 面板。自动验证可在当前源码的 4173 服务上运行 `node scripts/verify-history-pagination.cjs`，其请求和会话均为合成数据。

操作：
1. 打开首页，确认首屏运行标记和历史尚未出现的项目。
2. 保持运行中的会话，不停止 GOAL，等待后续分页；展开目标项目的“显示更多”，核对最后一页的历史。
3. 分页等待期间，每隔数秒刷新列表（不要刷新整个网页），观察已安排的下一页是否仍按原定时间发起；期间重命名项目，确认后页完成不恢复旧名称。
4. 延迟某一后页响应，在此期间让同一会话收到新的运行状态，再返回旧列表。另一次等待期间切换账号或关闭页面。
5. 在明暗主题下重复检查真实项目侧栏，确认历史行与运行标记同时可见。

预期：
- 首屏仍只请求 50 条；每个后页最多 100 条、逐页单并发、相邻后台页间隔至少 10 秒，cursor 按顺序推进且不重复。
- 运行中的普通会话或长 GOAL 不阻塞其他项目的历史；合成场景为首屏 3 条持续运行、后两页共 33 条 Sophos 历史，全部出现后 3 个运行标记仍保留。
- 重复调度或列表刷新不会把已安排的分页重新延后，后页合并保留刷新后的最新项目设置；列表元数据分页不会为旧会话额外调用 `thread/read`、`thread/resume` 或读取消息历史。
- 迟到列表不覆盖请求发出后收到的实时状态；切换账号或停止后，旧请求不提交、不安排新 timer，新账号正常加载。
- 没有页面异常或主题表面颜色错误。

清理：关闭验证页面，恢复人工延迟和合成拦截；不要删除真实会话或清空 59001 的固定卷。自动脚本只关闭自身浏览器上下文，4173 服务保留运行；回退代码时重新构建候选。

### 0.2.22-dev.8：分页加载不得删除旧会话的 Plan 偏好（R75）

- 前置：隔离会话 A/B，B 在第二页；先在 B 选择 Plan，再回到 A。对照使用相同会话一次完整返回的列表。
- 操作：重建页面状态并加载第一页，检查 B 的模式存储；继续加载第二页，选中 B，再重建状态。两条会话始终存在，没有归档或删除操作。
- 预期：不完整列表不能被当作已删除会话清单，B 的 Plan 偏好在两个场景都保持。
- 最小离线命令：`node docs/baseline/022/dev8-review-20261020/thread-pagination-preferences-offline.cjs`。实际桌面状态和分页/选择控制器，API、存储、timer 为内存端口；2场景6检查，dev.8 为4通过/2失败。两页场景清掉 B 偏好并回到 Default；完整页对照保留 Plan。
- 边界与清理：此脚本证明状态组合及存储写入，不是真实浏览器刷新或原生发送验收。两个场景的 timer/listener 均清零，存储只在脚本内存中，无真实文件/服务状态回滚。
