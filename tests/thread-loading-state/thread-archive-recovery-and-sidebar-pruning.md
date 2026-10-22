### Thread archive recovery and sidebar pruning

#### Feature/Change Name
Deleting a thread recovers from Codex `no rollout found` archive failures and removes successfully archived threads from the sidebar immediately.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Codex CLI available on `PATH`
3. At least one normal thread and one newly-created thread that has not yet produced a rollout
4. Light theme and dark theme both available from the appearance switcher

#### Steps
1. In light theme, create a new empty thread from the sidebar.
2. Open that thread's menu and choose `Delete thread`.
3. Confirm the thread disappears from the sidebar without a `no rollout found` error.
4. Rename another visible thread, then delete it.
5. Confirm the renamed thread disappears immediately and does not reappear after sidebar refresh/background pagination.
6. Call `thread/list` with `archived:false` through `/codex-api/rpc` and confirm the deleted thread ids are absent.
7. Call `thread/list` with `archived:true` and confirm the deleted thread ids are present.
8. Switch to dark theme and repeat steps 1-5.

#### Expected Results
- Empty or not-yet-materialized threads are archived after CodexUI sets a fallback name and retries.
- Already archived threads are treated as archived instead of surfacing a stale `no rollout found` error.
- The sidebar prunes archived ids from its accumulated paginated list before refreshing.
- Older unarchived threads may appear as the list refills, but archived threads do not remain visible.
- Behavior is consistent in light and dark themes.

#### Rollback/Cleanup
- None.

### 归档失败保留会话入口与关联配置（R80，尚未修复）

- 前置：独立审核环境，一条合成会话已置顶并关联暂停的自动化；拦截归档和配置API，不使用真实任务。
- 操作：悬停该行，点击删除并确认。先让归档返回200作为对照，再用全新上下文让归档返回503，等待请求结束；记录源列表、侧栏行、错误提示、置顶PUT和自动化DELETE。
- 预期：200完成后移除；503显示错误并保留可恢复入口及关联配置，不能无声清理。
- 当前：真实组件两场景12检查9通过/3失败。503源列表保留且报错，但侧栏隐藏、pin移除并发出automation DELETE；见审核`results/sidebar-archive-failure-ui.json`。不是完整App或刷新验收。
- 清理：关闭浏览器上下文；所有API拦截，未创建或删除真实会话/自动化，不改5900/59001/5173，保留审核4173。
