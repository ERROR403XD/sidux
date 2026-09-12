### Feature: Per-thread model selection

#### Prerequisites
- App is running from this repository against a Codex app-server that supports thread-scoped model persistence.
- At least two selectable models are available in the composer model picker.
- At least one existing thread is available, or you can create one during the test.

#### Steps
1. On the new-thread screen, choose model `A` in the composer.
2. Send a message to create a new thread.
3. In that thread, switch the composer model to model `B`.
4. Send another message in the same thread so the thread persists model `B`.
5. Create or open a different thread and set its model to model `A`.
6. Switch back and forth between the two threads.
7. Refresh the browser while one of the threads is selected.
8. Re-open both threads again after the refresh.
9. While thread `A` is selected, use the sidebar thread menu to fork thread `B`.
10. Open the forked thread and confirm the composer model matches thread `B`, not the currently selected thread.
11. Restart the app-server or otherwise force a model-list refresh that does not include one thread’s persisted model, then switch back to that thread.
12. Delete one of the test threads you changed, refresh the thread list, and continue switching between the remaining thread and the new-thread screen.
13. Save model `A` as the default model, return to the new-thread screen, select model `B`, and wait for a model-catalog refresh without sending the message yet.

#### Expected Results
- Each thread restores its own last selected model when you switch threads.
- The new-thread screen keeps its own draft model selection instead of inheriting the last opened thread.
- After browser refresh, reopening a thread restores the model persisted for that thread.
- Forked or newly created threads keep the resolved model returned by Codex, including fallback to the supported default model when needed.
- Forking a nonselected thread from the sidebar uses that source thread’s persisted model.
- If the selected thread’s persisted model is not returned in the latest model list, the composer still shows that model as the active selection instead of falling back to the placeholder label.
- Removing a thread prunes its saved per-thread model state, and model selection continues to update normally for the remaining threads without runtime errors.
- The pending new thread remains on explicitly selected model `B`; the saved default stays `A` and is used again the next time a fresh composer is initialized.

#### Rollback/Cleanup
- Reset each tested thread back to its original model selection if you changed an existing conversation for the test.

### 0.2.18 账号切换后的会话恢复与临时模型降级

前提：隔离 home，有账号 A（含 Astra）和 B（最高 Terra）；准备 A 会话与 B 会话。记录初始账号，不修改生产认证。

1. A 打开自己的会话；切到 B，再切回 A。预期正文均可显示，回到 A 无需刷新；可在同一会话依次发送，当前账号承担新请求。
2. 模拟 B 首次恢复 A 会话返回加载错误，立即切回 A。预期清除旧错误并重新 resume；迟到的 B 请求不能覆盖 A 的正文或重新显示错误。
3. B 在 B 会话使用 Terra 发送，然后打开 A 会话。预期 A 历史不丢失，发送模型临时使用 B 支持的 Terra。
4. 切回 A 并刷新。预期 A 会话恢复原先 Astra 偏好，B 会话仍为 Terra。只有主动选择模型才更改原会话偏好；目录降级不回写。旧版本已被覆盖的偏好无法可靠自动推断，可主动重选一次。
5. 对已缓存的会话重复切换，检查每次切换当前会话仅一个 resume；未打开的会话只失效缓存，不批量加载。另一执行中的会话保持既有状态。

清理：恢复初始账号，保留专用验收会话供复核；不要用旧认证文件覆盖测试期间正常轮换的认证。
