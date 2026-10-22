# 0.2.22 production 加载、请求与资源预算

## dev.8 安装包的新进程启动与有界只读基线

前提：既有审核镜像 `sidux-dev8-full-audit:20261020`，使用 `package-read-performance-container.cjs`；准确Docker参数见 `docs/baseline/022/dev8-review-20261020/run-commands.json`。network=none、无端口映射，内存768MiB、CPU1、pids128；只挂载只读脚本和本轮结果目录。每组新建合成home，empty和201会话各3次。

1. 记录新进程至首HTML与调度器ready的耗时；核对首页、哈希JS/CSS字节、缓存头、条件请求、HEAD及缺失资源404。
2. 分五页读取201会话、分十页读取500回合，断言完整、唯一、顺序正确；普通初始历史保持最近10回合。
3. 最后一组按每秒六个只读请求持续60秒，每批最多并发3：列表、初始历史、较旧历史页、HTML、入口资源和活动状态。记录每次响应状态/体积/耗时、IPC参数分组、进程CPU/RSS及容器资源。
4. 初始历史请求经ThreadHistory拆成metadata与10回合page两个IPC；逐次核对参数，不能把相同端点次数直接判为重复业务请求。预期所有响应内容正确、并发有界、合成会话文件SHA不变，结尾无活动/排队/待处理工作。
5. 连接均显式close、不保留WS/SSE；结束已确认自有CLI并记录退出/子进程状态，再清理自己的随机目录和容器。已退出但尚未回收的Z态与运行进程分别记录。

范围：此项没有清理宿主OS缓存，没有浏览器TTI/长期泄漏或真实供应方证据；Node22安装包与1CPU合成IPC结果不能代替下列浏览器生产预算。初次审核错误假定每次初始历史仅一个IPC，纠正后须完整重跑并保留原始报告。

## 前提与设置

- Linux 上为对照双方构建 production CLI 与 `dist/`，使用同一依赖、浏览器和独立 `threads-201` fixture（201 会话、1298 回合）。两份发布目录和 home 必须都是本轮合成样本；不读取生产或标准候选状态。
- 用 `lsof -nP -iTCP:4173 -sTCP:LISTEN`、`lsof -a -p <PID> -d cwd` 和实际命令行确认 4173 所有权。只替换本轮验证进程，保留 5173。
- `task_release`、`task_home` 分别指本轮已核对的构建目录和合成 home。CLI 没有 `--host`，启动命令为：

```sh
node scripts/seed-022-baseline.cjs "$task_home" threads-201
CODEX_HOME="$task_home" CODEXUI_CODEX_COMMAND="$PWD/src/server/fixtures/022-baseline-app-server.cjs" \
  node "$task_release/dist-cli/index.js" --port 4173 --strict-port --no-password --no-open
```

## 操作与预期

1. 两个版本分别运行以下命令，`PROFILE_LABEL`、`PROFILE_OUTPUT_DIR` 使用不同且唯一的值。查看 `report.json` 的实际资源、API、长任务和浏览器内 ready 标记；首页必须可见会话列表及合成模型，会话必须实际呈现正文。

```sh
PROFILE_DIST_DIR="$task_release/dist" PROFILE_LABEL=before PROFILE_SAMPLES=5 \
  PROFILE_OUTPUT_DIR=output/playwright/022-production-before node scripts/profile-022-production.cjs
```

2. 首页只下载入口 JS/CSS；`ThreadConversation`、`SettingsRoute`、`ApiProxyPanel`、`AutomationsPanel` 首次访问按需下载，再次访问无新增 feature chunk。每个 JS/CSS 响应与指定 `dist` 逐字节哈希匹配。普通样本保留 SW，单独核对 `/sw.js` 响应与控制器；gzip 等价值与 identity 实际传输分开记录。
3. 核对首页 `config/read=1`、quota-resume=1、list/skills 各 1；直开会话 resume=1/read=0。队列初始读取与 ready 缺口校准仍可各 1，pending 初始/ready 校准按实际握手计 1–2；记录用途，不跳过校准以减计数。API 响应体、失败与原有重复也须保留。
4. 脚本在亮暗 1440×1000 上拦截会话 chunk 返回 503，再点击实际重新加载按钮；另延迟会话 chunk，立即切设置后放行。预期显示故障恢复界面、显式重载后正文正常、迟到模块不能显示旧会话，无自动重试循环。故障样本禁用 SW，否则缓存会绕过 Playwright 拦截；截图在各自输出目录。
5. 运行预算检查。预期至少五个平衡样本、相同 fixture/浏览器/主题/路由和计时 schema；耗时中位数增加超过 `max(10%, 50ms)` 或包含公共脚本的首页 gzip 等价值增长超过 5% 时退出 2，报告保留调查项。计时口径混用、缺失样本和未完成运行退出 1。先保存原失败报告，再调查复测，不能挑样本覆盖失败。

```sh
node scripts/check-022-production-budget.cjs output/playwright/022-production-before output/playwright/022-production-after
node --test scripts/check-022-production-budget.test.cjs
```

6. 在当前 production artifact 上执行资源循环。脚本等待全部 201 会话分页完成，再建立卸载后的基线；亮暗各 50 次进出后，DOM/document、listener、timer 和活动连接回到基线，每个新增会话连接关闭。检查 GC 后堆曲线，不以短周期结果声称长期无泄漏。

```sh
PROFILE_LABEL=current-production PROFILE_ROUNDS=50 \
  PROFILE_OUTPUT_DIR=output/playwright/022-production-resources node scripts/profile-022-resources.cjs
```

7. 如需定位堆增长，显式设置 `PROFILE_HEAP_SNAPSHOTS=1`，只在本轮合成样本使用。原始快照留在本机输出目录，不提交 Git。安全汇总只导出类别、允许的系统类名和自有字节差异，不导出字符串、属性或闭包内容：

```sh
node scripts/summarize-022-heap.cjs <light-0.heapsnapshot> <light-50.heapsnapshot> <heap-light-safe.json>
```

## 回滚与清理

只停止已确认属于本轮临时发布目录的 4173 CLI；恢复当前源码及独立 fixture 的 `pnpm run dev --host 127.0.0.1 --port 4173`，留服务运行。保留失败与复测报告；临时 home/heap 清理前核对归属。测试不改变标准候选卷，也不执行 prepare、activate 或 publish。
