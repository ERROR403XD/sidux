# 会话查询与偏好资源合同

前置：独立 CODEX_HOME、合成会话/通知；不要导入用户认证与会话。需要原生 historyPaging CLI 及可控失败回合时才做人工状态验证。

1. 创建/销毁查询服务10次，每次两个通知订阅、零主动RPC；销毁后先解除search→失效search→解除history→clear history，重复销毁不重复释放，已解除的通知不再失效资源。
2. 发布quotaErrorIgnored只失效侧栏，不清history/search；turn/started同步失效三者；item/completed失效history/search；无id的archive使search整体失效。threadId/thread_id/thread.id沿用原提取规则。
3. 侧栏读取失败/中断但缺error的最后回合时，复用已有stream error并持久保存问题指标；已完成/运行中回合不因旧错误变成额度中断。忽略标记变化后重新读取可见状态；迟到版本返回null，不覆盖新状态。
4. 标题搜索命中持久标题；正文搜索用原生50回合分页，每次搜索复用metadata/body cache；修改rollout文件字节或通知后重新读取。分别记录list/body RPC次数，禁止以零API错误页判为通过。
5. 通过HTTP保存标题/置顶/首次启动卡片，重读和刷新后应保留；标题成功后一次search失效，写失败不失效且不丢其他global-state字段。session_index合法新标题覆盖持久标题，坏行跳过。

自动化：真实ThreadHistory/ThreadSearch/SidebarThreadStatusReader/问题与忽略存储及文件signature，原生RPC/通知使用合成seam；既有preferences/workspace HTTP和归档回归继续运行。10次资源循环仅证明本资源合同，未证明完整UI挂载或所有pending/sidebar状态的最终停止。清理仅本轮fixture，回滚对应提交，无schema变化。
