# 上传、转录与连接器图标合同

前提：隔离 `CODEX_HOME`、随机 localhost 服务与合成凭据，运行 `pnpm exec vitest run src/server/routes/mediaRoutes.test.ts src/server/transcriptionService.test.ts src/server/httpUtils.test.ts`。

1. 上传带二进制字节、路径分隔符文件名的 multipart；连续两次检查唯一目录、文件名转换及实际文件字节相同。缺 boundary/无文件仍返回400。
2. 无认证/损坏认证请求转录，检查401且无上游。有认证时检查原始音频字节、content type、access token/account id 与返回状态/JSON。
3. 缺少 curl 时检查 HTTP 回退；POSIX fixture 执行真实合成 `curl-impersonate-chrome`，检查 argv/stdin、没有重复 HTTP、Cloudflare challenge→503及429透传。
4. 读取 `connectors://` logo，检查 id编码、明暗参数、原图字节/Content-Type、private max-age=3600；检查 JSON/base64 envelope、缺认证/缺src/上游失败/坏payload的原错误映射。
5. 请求方法/路径不匹配时交还下一 handler。

图标别名回归：上游仅返回 `content_type`、`contentType` 为空串/空白时，应200并正确解码原图；两字段同时有效时保留 `contentType` 优先。缺少两字段仍502，不能增加一次重试请求。

转录进程回归：第一次 curl 启动报 ENOENT 后，等待 HTTP 回退完成，再创建第二 route 实例并请求转录；仍应直接使用 HTTP，不因迟到 close 事件重新尝试 curl。测试通过首次失败后安装合成可执行文件，检查没有子进程调用记录；真实用户安装 curl 后重启隔离服务才能重新探测。

测试只重定向固定的远端 HTTP/fetch 目标到本地 fixture；不会访问真实云端，Windows 跳过合成可执行 curl 用例。音频实际转录质量、真实连接器及大文件压力另需用户验收。

清理：关闭随机服务，删除本次返回的上传目录和合成home；不清空共享上传父目录。回滚只 revert 本批提交，不变更持久化schema或真实认证。
