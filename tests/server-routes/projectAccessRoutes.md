# 项目读取、成员归属与本地目录

前置：隔离 CODEX_HOME、合成虚拟项目及本轮临时目录；成员目录符合既有 Documents/Codex/YYYY-MM-DD/<会话目录> 合同。不要改动用户 AGENTS.md 或原有项目成员。

1. POST `/codex-api/project-membership` 加入虚拟项目，GET `/codex-api/project-files?id=<项目id>`。预期成员目录的 HTML 列表、转义项目/文件名、`text/html` 和 `no-store`；缺项目仍由外层错误边界处理。
2. POST 同一 cwd 且省略 projectId，预期 ok=true、归属移除，文件仍存在；非法 cwd/不存在项目拒绝且原状态不改。
3. 合成 AGENTS.md 写入附加目录，GET `/codex-api/project-directories?path=<根>`，预期已有完整目录列表；合法虚拟 id 返回空列表；相对路径/不完整区块 400，沿用原消息。
4. POST `/codex-api/local-directory` 的 path 为绝对路径或指向本轮目录的相对路径，预期 200 规范绝对路径并递归创建；已有目录复用、不改文件，已有普通文件 400。路径缺失400，mkdir失败交给外层502边界。

清理仅删除本轮隔离数据；回滚可 revert 迁移提交，无 schema 变化。自动化使用真实HTTP、VirtualProjectStore、AGENTS和HTML renderer；未操作用户文件、浏览器或测NFS冷读。
