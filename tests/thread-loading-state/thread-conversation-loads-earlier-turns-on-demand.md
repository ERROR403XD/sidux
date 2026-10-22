### Thread conversation loads earlier turns on demand

#### Feature/Change Name
Thread conversation incremental older-turn loading.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev --host 127.0.0.1 --port 4173`)
2. A thread with more than 10 turns is available
3. Light theme and dark theme both available from the appearance switcher

#### Steps
1. In light theme, open a thread that has more than 10 turns.
2. Confirm the newest messages render first and the conversation shows the Load earlier messages control at the top.
3. Click Load earlier messages once.
4. Confirm an older batch is prepended above the previously first visible turn and the scroll position stays near the same content.
5. Continue clicking Load earlier messages until the control disappears.
6. Confirm the oldest messages in the thread are visible and no duplicate message rows are introduced.
7. Switch to dark theme and repeat steps 1-6 on the same thread or another long thread.

#### Expected Results
- Initial thread open remains bounded to the latest turn page.
- Load earlier messages fetches older persisted turns from the local bridge instead of only revealing already-loaded messages.
- The control remains available while older persisted turns exist and disappears after the first turn is loaded.
- Message ordering, turn actions, and scroll restoration remain stable in light and dark themes.

#### Rollback/Cleanup
- None.

---

### 0.2.22：分页、缓存首屏与滚动生命周期

#### 前提与准备
1. 当前源码在独立 home 的 4173 验证服务中运行；不要用生产 5900 或旧候选替代。
2. 准备超过 50 条有效消息的会话、可分页历史和迟到图片；可按 `docs/baseline/022/conversation-viewport-20261012/README.md` 创建合成 fixture。
3. 分别使用浅色中文、暗色英文；覆盖 1440×1000、768×1024、375×812。

#### 操作
1. 打开长会话，确认首屏为最新 50 条；进入设置再返回同一缓存会话，确认仍为最新 50 条且滚到最下方。
2. 手动滚到历史区；点击加载更多，本地窗口先展开 30 条而不发历史请求。
3. 本地窗口展开完后加载持久历史；在响应延迟期间重复点击，检查同一身份只发一次请求、按钮 busy 正确。
4. 响应返回后检查旧消息 DOM 与阅读锚点；制造一次 500，检查错误保留、scroll 不自动重试，显式点击可重试成功。
5. 在响应待返回时切会话/目录/账号，包含 A→B→A；旧成功或失败不得恢复旧位置、错误或清掉新请求的 busy。
6. 手动阅读时让图片和增量回复继续到达，确认位置保持，增量文本复用原消息行。
7. 点击跳到最新，立即检查窗口恢复 50 条；继续增量回复，确认底部跟随。再主动向上滚动，确认跟随立即停止。在持久分页待返回时点击跳到最新，再完成分页，确认busy正常结束且仍在最新50行/底部。
8. 图片或历史请求待完成时进入设置卸载，随后让成功或失败响应返回；重新打开会话，检查没有旧错误或突然跳动。
9. 用自动组合测试核对取消 RAF 后 Promise 会结束，nextTick/图片迟到回调不能恢复工作；实际资源脚本亮暗各重复挂载/卸载 10 次。

#### 预期
- 本地展开 0 请求，持久分页无重复，旧锚点位移不超过 3px；本批六组实测 0px。
- 缓存首屏/跳到最新/跟随输出为 50 行；手动展开历史允许扩大，不能把它误当成始终固定 50 行。
- 手动滚动不被图片或输出抢回；错误可重试；身份变化、容器脱离和卸载拒绝旧完成。
- owner 图片监听和滚动帧卸载后为零，等待中的滚动 Promise 结束；亮暗样式一致可读。

#### 回滚与清理
- 自动脚本只清理自己的随机会话与临时文件；保留原恢复材料和标准测试卷。
- 4173 按仓库规范保留运行；不得停止5173，不读取或复制5900持久状态。
- 独立home中断后遗留的合成fixture另行核对，不删除标准59001状态。

### dev.8 全量审核：500回合与迟到分页

#### 前提与准备

1. 使用`docs/baseline/022/dev8-review-20261020/README.md`的独立4173服务，确认PID/cwd；只访问回环地址。
2. 种子会话A有500回合、B有2回合；userMessage.content需为协议文本数组。审核脚本临时修正两份合成文件，finally恢复原始字节。
3. 在1440×1000、768×1024、375×812分别执行浅色和深色。

#### 操作

1. 运行`node docs/baseline/022/dev8-review-20261020/conversation-history-ui.cjs`。
2. 核对初始10回合20行、底部位置、没有提前获取旧历史；向上加载并检查同一可见消息的屏幕坐标。
3. 让一次真实历史请求返回503，确认原60行保留，滚动不自动重试，点击后恢复为80行。
4. 延迟历史HTTP响应时分别点击Jump latest和切到B，再释放响应；检查最新50行/底部及B不受污染。
5. 桌面浅色完整读取500回合，检查1000行、500条助手回复顺序唯一；跳到最新收回50行，刷新回最近10回合20行。

#### 预期与本轮证据

- 六组通过；锚点误差0–0.5px，历史请求并发上限1，无thread/resume、外部请求和pageerror。
- 完整展开允许保留1000行；这是手动展开，不是始终50行的虚拟列表。10.98秒包含翻页等待和真实HTTP，不是纯渲染耗时。
- 结果见`results/conversation-history.json`；截图在`output/playwright/dev8-full-audit/conversation-history/`。

#### 清理

- 核对两份原会话SHA256恢复，重新刷新合成会话列表；保留4173。
- 不访问5900持久状态，不替换59001，不修改产品代码。

---
