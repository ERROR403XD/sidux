# 项目发现、输入文件搜索、提示词与终端快捷命令

前置：使用隔离 CODEX_HOME 和合成项目；安装 rg。不要在用户项目中创建碰撞目录或改动已有提示词。仅此轮临时目录可清理。

1. 在项目内建立 `New Project (1)` 目录和同名编号 2 文件，请求 `GET /codex-api/project-root-suggestion?basePath=<项目>`。预期编号 3，未创建目录；缺路径/文件/不存在目录分别 400/400/404。
2. 建立 alpha.ts、src/alpha.ts、alpha.test.ts、src/my-alpha.ts、.hidden.txt，以及 .git、node_modules、gitignore 忽略文件。请求 `POST /codex-api/composer-file-search`，cwd 为项目、query 为 alpha.ts。预期精确 basename 优先，同分按 path 排序；隐藏文件可查，忽略目录不出现；limit 保持 1–100。缺 cwd、文件、不存在目录分别 400/400/404，且不启动 rg。
3. 建立 package.json scripts、多个 lockfile、Makefile/makefile、根目录和 scripts 中 .sh/.cmd 文件。请求 `GET /codex-api/thread-terminal/quick-commands?cwd=<项目>`。预期 package→make→根脚本→scripts 顺序、去重、引号转义；pnpm 优先，其后 yarn、bun、npm。不会执行脚本。缺少或坏 package 不阻断其他发现。
4. 请求 `POST /codex-api/prompts`，连续创建同名带扩展名/保留字符的提示词。预期规范名称及 -2 后缀，文件内容是 trim 后加一个换行，原文件不覆盖；GET 按名称排序且 description 为第一非空行最多 120 字符，仅普通 md 文件入列。
5. DELETE 本轮提示词路径，预期 removed=true，再删 removed=false；外部路径/非 md 400且原文件不变。清理本轮隔离目录。

自动化证据：`composerSupportService.test.ts` 经真实 HTTP/文件及实际 rg 验证，terminal manager 仅作为非目标功能 seam；定向 route 测试补充失败映射。没有浏览器交互、真实用户数据或 NFS 大目录时延证明。回滚可 revert 对应迁移提交，无 schema 变化。

## dev.8 审核补充：并发提示词与空项目搜索

前提：仅用自有随机目录和隔离 home，保留实际文件写入与 rg；不读取用户提示词。离线复现命令：`node docs/baseline/022/dev8-review-20261020/api-io-contracts-offline.cjs`。

1. 两次同名提示词创建都选定路径后再放行写入。预期成功响应对应两个不同文件，两个内容都保留；另做顺序同名和并发不同名对照。dev.8 两次成功返回相同路径，实际只留第二份内容，记 R68。
2. 对有效空目录及单文件目录各搜索一次。预期均成功，分别返回空列表和该文件。dev.8 实际 rg 在空目录 exit 1，被 service 转为 500，记 P3 R69；输入框 catch 将其显示为空建议列表，不能声称已经证明页面报错或搜索现有文件失败。

清理：脚本只删除本次随机根并检查已移除；exit 1 表示已确认的产品合同失败，不是夹具故障。无产品变更或回滚步骤，不需要重复主题/尺寸矩阵。
