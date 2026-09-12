### Docker provider checklist and live error overlay regression

#### Feature/Change Name
Docker provider/auth checklist execution and live error overlay de-duplication.

#### Prerequisites/Setup
1. Run `pnpm run build`.
2. Run `pnpm pack --pack-destination /tmp`.
3. Build a Docker image from the packed `codexapp` tarball with `@openai/codex` installed.
4. Start three isolated containers:
   - no auth file
   - invalid or expired `auth.json`
   - malformed `auth.json`

#### Steps
1. In light theme, open the no-auth container, confirm the composer starts on `big-pickle`, send `hi`, and wait for an assistant reply.
2. Switch the Settings provider selector to OpenRouter, send `hi` again, and wait for a reply or provider-scoped response.
3. Open the invalid-auth container, send `hi`, wait for the final 401/auth error, and confirm `Send feedback` is visible.
4. Reload the invalid-auth thread and confirm the persisted error remains without a duplicate live `Thinking` error overlay.
5. Switch the invalid-auth thread to dark theme and confirm the persisted error and feedback button remain readable.
6. Open the malformed-auth container, confirm it falls back to `big-pickle`, send `hi`, and wait for an assistant reply.

#### Expected Results
- No-auth startup uses the OpenCode Zen runtime fallback and sends successfully.
- Runtime `-c` provider config uses underscore-safe provider ids, so Zen/OpenRouter/custom providers are actually registered with Codex app-server.
- Provider switching is scoped to the selected provider and does not require changing the model dropdown directly.
- Invalid/expired auth stays on the Codex provider path and renders the final auth failure as a persisted chat error.
- A new live error is still visible when an older persisted turn error exists, but the same live error is suppressed after that exact error has persisted.
- Feedback opens a previewable minimal report. It excludes visible page text, raw auth errors, paths and credentials; copying or sharing is a separate user action.
- Malformed auth is treated as unusable auth and falls back to Zen.

#### Rollback/Cleanup
- Stop temporary containers with `docker rm -f codexui-what-noauth codexui-what-invalid-auth codexui-what-malformed-auth`.

---


## 0.2.19 打包回归补充

构建并 pack 后，镜像 `codexapp-final-test:0.2.19` 安装当前 tarball 和 `@openai/codex@0.153.4`。运行 `node scripts/test-packaged-provider-matrix.cjs`，隔离端口 4195（无认证/切 OpenRouter）、4196（损坏认证）、4197（合成无效 ChatGPT 认证）。原生 config/read 中 provider=null 表示默认 OpenAI；API-key-only 文件按本应用现有 ChatGPT 认证判断会回退，不能拿它冒充无效 ChatGPT 登录用例。

认证故障显示使用真实上游和合成无效认证，应用投递台账、原生 Codex、失败回合和浏览器均使用真实实现；检查刷新后仍有持久错误，重复 live overlay 为零，1440×1000 浅深主题截图。该用例不证明真实云端可成功消费、自然额度恢复或免费模型可用。初次测试容器缺少主机 CA，原生请求以 UnknownIssuer 重试，该结果未计入通过。最终测试容器只读挂载主机已有公共 CA；原生终态为 auth refresh request failed: code=-32001，作为认证刷新失败验证，不宣称直接观测到 401。

脚本只处理自己创建的三个容器和临时目录，不读取生产认证，结束后删除测试容器。脚本日志与截图位于 `output/0219-final/packaged-provider-matrix.*` 和 `output/playwright/0219-packaged-invalid-auth-{light,dark}.png`。
