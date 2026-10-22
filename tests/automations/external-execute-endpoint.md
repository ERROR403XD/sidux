# 0.2.21-dev.1 自动化任务唯一 id 与对外执行端点

## Feature: 自动化任务唯一 id 与 `POST /automation/execute` 对外触发

#### Prerequisites
- 已完成构建的产物：`pnpm run build`（前端 + `dist-cli`）。
- 独立的测试实例（不要使用生产 `CODEX_HOME`）：
  - `mkdir -p <home>/automations/dev-smoke`，写入 `automation.toml`（带显式 id 的 cron 任务）：
    ```toml
    version = 1
    id = "dev-smoke"
    kind = "cron"
    name = "Dev smoke task"
    prompt = "SMOKE_MARKER_0211"
    rrule = "FREQ=DAILY"
    status = "PAUSED"
    cwds = ['<home>']
    ```
  - `mkdir -p <home>/automations/ext-smoke`，写入**不含 id 字段**的 `automation.toml`（其余同上，`name = "External smoke task"`）。
- 启动独立实例：`CODEX_HOME=<home> node dist-cli/index.js --port 4923 --strict-port --no-password --no-open`。

## 按 id 触发任务的使用用例

请求体只需要提供 `id`，执行目标与 requestId 由服务端内部处理（heartbeat 取目标会话，cron 取第一个工作目录；每次调用生成新的 `external-<uuid>` requestId；多余字段一律忽略）。

1. 找到任务 id（三选一）：
   - 打开自动化面板，选中任务，详情 `ID` 字段旁点复制按钮（长 id 截断显示时也可完整复制）；
   - `curl http://127.0.0.1:4923/codex-api/automation-runtime`，读 `definitions[].id`（含已暂停任务）；
   - `curl http://127.0.0.1:4923/codex-api/project-automations`（或 `/codex-api/thread-automations`），读返回记录的 `id` 字段。
2. 触发执行：
   ```bash
   curl -X POST http://127.0.0.1:4923/automation/execute \
     -H "Content-Type: application/json" \
     -d '{"id":"dev-smoke"}'
   ```
   成功返回 `HTTP 200`：`{"data":{"queued":true,"run":{...}}}`，`run.runId` 可用于后续查询。
3. 查询执行结果：
   ```bash
   curl "http://127.0.0.1:4923/codex-api/automation-runs?automationId=dev-smoke&limit=5"
   ```
4. 已暂停（PAUSED）任务同样可触发；重复触发时若上一 run 仍在排队，返回 `HTTP 409`。

#### Steps
1. `curl http://127.0.0.1:4923/codex-api/automation-runtime`，确认 `definitions` 同时包含 `dev-smoke` 与 `ext-smoke`（后者由目录名采纳为 id），且 `nextRunAtMs` 为 `null`（PAUSED 不入调度）。
2. `curl -X POST http://127.0.0.1:4923/automation/execute -H "Content-Type: application/json" -d '{"id":"dev-smoke"}'`。
3. 紧接着再次触发（额外字段应被忽略）：`-d '{"id":"dev-smoke","anything":"ignored"}'`。
4. 触发无 id 任务：`-d '{"id":"ext-smoke"}'`。
5. 错误路径：`-d '{"id":"missing-task"}'`、`-d '{}'`、`-d '{broken'`。
6. `curl "http://127.0.0.1:4923/codex-api/automation-runs?automationId=dev-smoke&limit=5"` 查看运行记录。
7. 打开自动化面板，选中 PAUSED 任务，确认详情 `ID` 字段可见，且旁侧有复制按钮；点击后剪贴板内容为完整 id 并出现「已复制任务 ID」提示。

#### Expected Results
- 步骤 2/4 返回 `HTTP 200`，响应体为 `{"data":{"queued":true,"run":{...}}}`；`run.automationId` 与请求 id 一致，`trigger` 为 `manual`，`run.key` 含自动生成的 `external-<uuid>`；步骤 3 的额外字段不影响行为：前一运行仍 queued 时必须返回 409，已经开始运行时可返回 200；不能依赖连续请求的时间间隔断言结果。
- `ext-smoke`（toml 无 id）可被目录名 id 正常触发；下一次 UI 编辑保存后 `automation.toml` 会持久化显式 `id = "ext-smoke"`。
- `{"id":"missing-task"}` → `HTTP 404` `{"error":"找不到自动化任务：missing-task"}`；`{}` → `HTTP 400` `缺少有效的自动化任务 id`；坏 JSON → `HTTP 400` `请求体不是有效的 JSON`。
- 步骤 6 可见步骤 2/3/4 产生的运行记录；测试实例无凭据时最终状态为 `failed` + `AUTH_REQUIRED`（脱敏文案），证明完整调度管道已走通。
- PAUSED 任务的详情面板显示 ID 与复制按钮；明/暗主题下按钮均为暗色适配；点击复制后剪贴板为完整 id（长 id 在面板中截断显示时同样复制完整值）。

#### Rollback/Cleanup
- 结束测试进程：`taskkill //F //PID <4923 监听进程>`（或直接关闭终端）。
- 删除测试实例目录 `<home>` 即可，不影响生产数据。

## 相关单测

- `src/server/automation.test.ts`：toml 缺 id 采纳 fallback、目录名 id 任务入扫描、暂停任务 execute 触发（仅 id，目标内部解析）、排队冲突拒绝。
- `src/server/automationExecute.test.ts`：端点请求映射（仅 id 校验、多余字段忽略、200/400/404/409/503 分类）。
- `src/server/automationAtomicWrite.test.ts`：原子写 rename 瞬时占用重试（EPERM/EBUSY/EACCES，有界退避）。
- `src/commandResolution.test.ts`：codex/rg 新旧 vendor 布局候选路径（Windows 双布局、POSIX 双全局候选）。
- UI 验证脚本：`output/playwright/verify-automation-copy-dev1.cjs`（明/暗/375 三组，剪贴板与 toast 断言，截图 `output/playwright/dev1-copy-*.png`）。


## 0.2.21-dev.2：受理一致性与错误分类

前提：独立 CODEX_HOME；沿用上述 PAUSED 任务；故障注入使用 `src/server/automation.test.ts`，不要破坏真实 state 文件。

1. 对相同目标先调用 engine.execute，不 tick，再调用一次：第一次受理，第二次为 `queued_conflict`/409。
2. 两个引擎共享同一测试 HOME：未拿到锁的引擎返回 `not_ready`/503。
3. 受理写入前失败：返回 `storage_failed`/500，新任务不留队列；调度暂停，存储恢复和重启后都不执行失败请求。
4. 写入已完成但报错：核对磁盘后返回原 run，调度仍暂停；显式重启后沿用原 ID，只执行一次。
5. 写入和核对均失败：返回 `admission_unknown`/503 和 runId；先核对该 runId，勿直接重新触发。未确认结果前服务不继续派发。
6. 创建 201 个 ASCII 字符的任务目录，TOML 不填写 id：扫描、复制出的 ID 与 POST execute 均接受同一个 ID。
7. 意外内部异常返回 500 和通用文案，不依赖错误文字判断 404，不泄漏原始存储异常。

验证：`node_modules/.bin/vitest run src/server/automation.test.ts src/server/automationExecute.test.ts src/server/automationPersistence.test.ts`。
清理：测试自动清除临时 HOME；HTTP 实例只停止本次测试进程。不存在生产回滚操作。
