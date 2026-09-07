### Accounts panel Codex login callback modal

#### Feature/Change Name
0.2.10：账号设置提供新增账号入口，先选择链接登录或 Device 设备码登录；两种方式共用独立 pending CODEX_HOME 和账号验证、去重、入池流程。

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. `codex` CLI available in the server process `PATH`
3. Browser can open the authorization URL returned by the server
4. Light theme and dark theme are available from the appearance switcher

#### Steps
1. Open settings and expand `Accounts`.
2. In light theme, verify `Login` appears even when an active account is already listed.
3. Click `Login`.
4. 选择“链接登录”，点击“开始登录”，再打开弹窗提供的授权链接；此时显示回调链接输入框。
5. Complete authorization in the browser until it redirects to a `http://localhost:<port>/auth/callback?...` URL.
6. Paste that full localhost callback URL into the modal input and click `Complete`.
7. 确认账号列表刷新，新账号加入池中且原活动账号不变；重复登录同一身份不会创建重复账号。
8. 再次打开登录，选择 Device 并开始，检查验证网页、设备码和有效期；完成网页授权后自动验证入池，无需回调输入。刷新页面应恢复有效会话。取消/切换方式须先结束旧会话，迟到事件不得影响新会话。
9. Switch to dark theme and repeat steps 1-4, verifying the Login button, link, modal, input, and buttons have readable contrast.

#### Expected Results
- `Login` is available regardless of current login state.
- Starting login runs `codex login` on the server and exposes the generated OpenAI authorization URL.
- Completing login uses the modal input value, only accepts local callback URLs, and uses the server to request the pasted callback.
- 两种登录均在 pending 目录验证后入池，不覆盖活动账号；若重新认证指定账号，必须匹配目标身份。
- Completion does not remain stuck waiting for the `codex login` process after the callback has updated `auth.json`.
- Light-theme and dark-theme controls are readable and do not overlap.

#### Rollback/Cleanup
- Remove any test-only account from the Accounts panel if needed.
- 取消废弃登录并确认子进程、临时目录和账号操作锁清理。覆盖设备授权失败、15 分钟超时、服务重启、错误回调和重复提交；错误提示不能被下一次状态轮询清空。
- 仅在隔离候选测试，截图遮去有效设备码与回调；不要为测试恢复旧凭据快照。

---
