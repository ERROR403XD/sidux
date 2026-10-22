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

### 0.2.22-dev.2：完整会话偏好记忆与临时目录回退

前置条件：使用包含本修复的59001候选，或权威源码4173的独立合成fixture；开启设置中的“记住每个会话上次设置”。准备A/B/C三个历史会话、至少两个支持推理强度的模型；记录原模型、强度、速度和记忆开关。合成目录缩减/延迟只在隔离浏览器中拦截，不修改真实账号目录或认证。

1. A选Astra＋极高，B选Sol＋低，C选Astra＋低；分别返回A、B、C。预期每个会话恢复自己的模型和推理强度，同模型的A/C不能互相覆盖。手动只调整推理强度也必须建立该会话的完整偏好。
2. 刷新页面，再依次打开三个会话。预期仍分别恢复原选择；在当前模型菜单重复点击已选模型，推理强度和速度不能被清空。
3. 对Codex与自定义连接分别重复上述检查。在B选择Sol后让目录暂时只返回Astra，刷新后检查有效回退，再恢复完整目录并刷新。预期B恢复Sol＋低，原保存偏好未被回退覆盖。
4. 延迟目录读取，等待期间手动更改当前会话的模型/强度，再释放旧目录响应。预期手动选择保留；选择操作不额外请求配置或目录。
5. 关闭记忆开关，在A临时选另一个模型/强度；离开再返回，预期按默认设置初始化。重新打开记忆后进入A，预期原Astra＋极高记忆仍在。
6. 只打开一个从未在本浏览器手动设置过的历史或自动化会话，不操作模型控件。预期不自动创建Web偏好记录，不覆盖它的运行时来源或设置。
7. 在1440×1000浅/深主题、375×812和768×1024深色重复模型菜单与会话恢复检查，观察实际输入区的模型/强度及刷新后的状态。

预期：记忆由会话ID保存完整模型/来源/推理强度/速度；后台历史和目录读取不创建手动偏好。旧版按模型共用的档位已被其他会话覆盖时，无法自动推断原值；手动重选一次后按修复后的会话记忆保存。

清理/回滚：恢复专用验收会话原选择与记忆开关；合成回归不发送回合或执行任务。保留59001标准卷，不复制生产状态。源码回退本次修复提交，偏好格式沿用既有v1，无需清空浏览器存储。

### 0.2.18 账号切换后的会话恢复与临时模型降级

前提：隔离 home，有账号 A（含 Astra）和 B（最高 Terra）；准备 A 会话与 B 会话。记录初始账号，不修改生产认证。

1. A 打开自己的会话；切到 B，再切回 A。预期正文均可显示，回到 A 无需刷新；可在同一会话依次发送，当前账号承担新请求。
2. 模拟 B 首次恢复 A 会话返回加载错误，立即切回 A。预期清除旧错误并重新 resume；迟到的 B 请求不能覆盖 A 的正文或重新显示错误。
3. B 在 B 会话使用 Terra 发送，然后打开 A 会话。预期 A 历史不丢失，发送模型临时使用 B 支持的 Terra。
4. 切回 A 并刷新。预期 A 会话恢复原先 Astra 偏好，B 会话仍为 Terra。只有主动选择模型才更改原会话偏好；目录降级不回写。旧版本已被覆盖的偏好无法可靠自动推断，可主动重选一次。
5. 对已缓存的会话重复切换，检查每次切换当前会话仅一个 resume；未打开的会话只失效缓存，不批量加载。另一执行中的会话保持既有状态。

清理：恢复初始账号，保留专用验收会话供复核；不要用旧认证文件覆盖测试期间正常轮换的认证。

### 0.2.22 账号切换期间的线程列表代际保护

前提：隔离 59001 home，账号 A/B 各自有可区分的专用会话；可通过测试桩或受控网关让 A 的线程列表响应延迟返回。

1. 在 A 发起线程列表刷新，请求未返回时切换到 B，使 B 刷新开始。
2. 释放 A 的延迟响应，等待 B 刷新完成。
3. 让 A 列表存在未完成分页时再次 A→B 切换，释放 A 的后台分页响应。
4. 在 A 打开仍有更早历史的会话并触发加载更早消息，切换到 B 后释放 A 的更早历史响应。
5. 在 A 线程加载延迟或失败时切到 B 或其他 A 会话，释放旧线程失败。
6. 让后台旧线程历史继续挂起，同时快速完成当前线程首次加载。预期当前线程 loading 随自身加载结束而消失；释放旧线程后不重新显示当前线程 loading，也不残留后台加载状态。

预期：A 的首屏列表、后台分页和更早历史页均被丢弃，不合并到 B；A 的更早历史错误和旧选中线程错误也不写入 B；B 只显示 B 当前历史；新建 fork 在 B 服务端列出前仍保留。自动回归：`pnpm exec vitest run src/composables/useDesktopState.test.ts`。

清理：恢复初始账号并保留专用验收会话；不要复制或覆盖任何账号认证。
