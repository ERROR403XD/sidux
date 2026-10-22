# Sidux 0.2.23 开发 / Development

开发版本从 `0.2.23-dev.1` 开始，功能基线为已发布的 `v0.2.22`，对应最后的 `0.2.22-dev.8` 实现。开发版尚未作为正式版发布。/ Development starts at `0.2.23-dev.1` from the published `v0.2.22` implementation, corresponding to the final `0.2.22-dev.8`. This development version is not a stable release.

首批范围为处理 dev.8 审查留下的 80 项问题（6 P1、66 P2、8 P3）。六项 P1 优先：/ The initial scope is the 80 unresolved dev.8 audit findings (6 P1, 66 P2, 8 P3), prioritizing:

| 编号 / ID | 修复目标 / Objective |
| --- | --- |
| R6 | 终端 attach 与当前会话、目录的身份一致。/ Keep terminal attachment bound to the current conversation and directory. |
| R12 | 异常 SSE 尾帧按请求失败处理，服务进程继续运行。/ Fail malformed SSE requests while keeping the service process alive. |
| R31 | 文件路径只解码一次，读取与保存使用同一文件身份。/ Decode file paths once and preserve identity across reading and saving. |
| R37 | 撤回失败后的重试保留回合前的未提交内容。/ Preserve pre-turn uncommitted content when retrying a failed rollback. |
| R50 | 并发克隆的清理只处理自身拥有的目录。/ Restrict concurrent-clone cleanup to the directory owned by that operation. |
| R62 | 旧终态不能清除新回合活动记录，空闲检查与实际活动一致。/ Prevent stale terminal events from clearing a newer turn's activity and invalidating idle checks. |

完整修复前，以上问题保持未解决状态；各项修复先复现原触发，再添加对应回归并验证实际运行链路。后续 P2/P3 按数据完整性、进程恢复、持久化与交互影响分批处理。/ These findings remain open until fixed. Reproduce the original trigger, add focused regressions, and verify the actual runtime path for each fix. Address P2/P3 findings in batches based on data integrity, recovery, persistence, and interaction impact.

稳定版的功能、已知问题和验证范围见 [0.2.22 发布说明](RELEASE-0.2.22.md)。/ See the [0.2.22 release notes](RELEASE-0.2.22.md) for the stable baseline, known issues, and verification scope.
