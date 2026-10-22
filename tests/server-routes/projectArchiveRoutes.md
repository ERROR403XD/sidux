# 项目归档完整管线

前提：隔离home/随机localhost服务，运行 `pnpm exec vitest run src/server/projectArchiveService.test.ts src/server/routes/projectArchiveRoutes.test.ts src/server/codexAppServerBridge.archive.test.ts src/server/routes/rpcRoutes.test.ts`。POSIX完整管线使用合成sqlite3可执行文件调用Python SQLite标准库执行真实SQL，Windows跳过该fixture。

1. GET/HEAD导出真实项目；HEAD无body、不扫描会话。GET ZIP用独立Python zipfile校验CRC/目录；检查二进制文件、gitignore、node_modules与.git跳过规则。
2. 导出含会话、数据库标题/时间的ZIP后导入；检查唯一新目录、原始文件字节、JSONL的新id/cwd/source/model、user_message补全和数据库/原生thread list补充。
3. 连续导入两次，检查目录碰撞命名、每次成功后一次search失效和workspace登记，不覆盖先前文件。
4. 虚拟项目两个目录往返；检查files前缀、恢复后的两个cwd、导入会话归属和projectOrder。
5. 缺cwd/parent、非目录/不存在、空ZIP、错误签名、不安全路径保留原错误映射；失败不能登记workspace或触发成功失效。
6. 沿原route故障测试检查响应前500与写入后destroy、虚拟项目错误上抛；真实大ZIP断开、慢客户端和NFS延迟仍需单独验收。

清理：关闭随机服务并删除整个合成home；CLI shim不修改真实SQLite/认证或git配置。回滚只revert归档迁移提交，无schema变化；不清理真实项目和会话。

## dev.8 审核补充：导入内容完整性

前提：自有目录中仅有一个普通文本文件；用真实 `streamProjectZip` 导出，保留完好对照，再复制归档并只改变该文件内容中的一个字节。命令：`node docs/baseline/022/dev8-review-20261020/api-io-contracts-offline.cjs`。

1. 用 Python 标准库 `zipfile.testzip()` 检查两份归档。预期完好归档无坏条目，损坏副本报告该文本文件 CRC 不一致。
2. 通过真实归档 service 分别导入到两个自有目录。预期完好归档成功且字节相同；损坏副本应拒绝，不能成功登记并接受错误内容。dev.8 后者仍成功且写入被改变的字节，确认 R70。
3. 记录实际返回、标准库结论和磁盘字节。该最小合同用自有 JSON 替代 workspace 登记、断言导入会话集合为空；不证明原生会话/SQLite 或 HTTP 管线，不扩展路径构造或解析器模糊测试。

清理：脚本删除本次随机根并核对不存在；没有改产品或用户归档，exit 1 保留正确合同的失败。
