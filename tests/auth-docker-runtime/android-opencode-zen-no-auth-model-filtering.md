### Android OpenCode Zen no-auth model filtering

#### 0.2.22-dev.8：首次开发启动控制流

- 前置：使用第十批审核的network=none容器；`TERMUX_VERSION`选择Android分支，pnpm和CLI入口为本地无副作用桩，新建目录中没有dist-cli。
- 操作：执行`script-startup-contracts-container.cjs`，检查第一次dev调用是否依次build、start；随后在已有产物下再次调用。
- 预期：首次成功构建后继续启动，构建失败应退出；dev.8当前第一次只build并退出0（R34），第二次会调用start。
- 局限：这里只证明包装脚本分支；没有验证真实Android、CLI参数兼容、PTY或云模型成功。下文设备用例仍待独立执行。
- 清理：finally删除脚本自有临时目录，容器退出自动删除；保留JSON，不修改真实Android或宿主账号。

#### Feature/Change Name
Android no-auth OpenCode Zen model list is limited to usable free models.

#### Prerequisites/Setup
1. Build the web and CLI artifacts with `pnpm run build`.
2. Pack the current branch with `pnpm pack --pack-destination output/playwright/android-ssh-fulltest`.
3. Install the tarball into the Android proot through `/Users/igor/Git-projects/codex-web-local-android/andClaw-codex/ssh.sh`.
4. Remove `~/.codex/auth.json` and `~/.codex/webui-custom-providers.json` inside the Android proot.
5. Start `codexui --port 18935 --strict-port --no-password --no-open` inside the Android proot.
6. Forward the port with `adb -s <device> forward tcp:18935 tcp:18935`.

#### Steps
1. In light theme, open `http://127.0.0.1:18935/#/` at a mobile viewport.
2. Confirm the composer starts on `big-pickle`.
3. Open the model menu and confirm it only contains `big-pickle` and `*-free` OpenCode Zen models.
4. Send `hi retest no auth default` and wait for a reply.
5. Switch the model to `deepseek-v4-flash-free`, send `hi retest no auth switched`, and wait for a reply or visible error.
6. Repeat the menu visibility check in dark theme.
7. Restore a valid `~/.codex/auth.json`, clear `~/.codex/webui-custom-providers.json`, start a fresh server on another port, and confirm the composer returns to Codex models such as `GPT-5.4-mini`.

#### Expected Results
- `/codex-api/provider-models` returns an exclusive no-auth Zen list containing only `big-pickle` and free models.
- No-auth Android startup does not expose Codex/GPT, Claude, Gemini, or other paid Zen models unless a user Zen key is configured.
- The no-auth default and switched free model sends both produce a visible assistant reply or visible provider error.
- With valid Codex auth restored, community fallback state is suppressed and the model menu shows Codex models.
- Light and dark theme menus remain readable.

#### Rollback/Cleanup
- Restore the original `~/.codex/auth.json` if it was backed up for no-auth testing.
- Stop temporary Android proot `codexui` processes or leave only the intended test port forwarded.

---
