# Thread Loading, Streaming, and State

Thread list/detail loading, pagination, selected-thread stability, streaming scroll behavior, live-state reads, and missing-thread handling.

Return to the [manual test index](../../tests.md).

## Test Sections

| Section |
| --- |
| [会话定时续跑（0.2.22）](scheduled-resume-022.md) |
| [查看会话只读加载（0.2.22）](view-conversation-read-only-022.md) |
| [0.2.22：账号与刷新协调](desktop-refresh-coordination.md) |
| [Thread rename, archive and fork lifecycle](thread-mutation-lifecycle.md) |
| [Pinned threads remain visible during background pagination](pinned-threads-remain-visible-during-background-pagination.md) |
| [Thread read gateway boundary](thread-read-gateway-boundary.md) |
| [Thread archive recovery and sidebar pruning](thread-archive-recovery-and-sidebar-pruning.md) |
| [Unread thread cutoff state](unread-thread-cutoff-state.md) |
| [完成标记快照与已读确认生命周期](thread-completion-lifecycle.md) |
| [Feature: Deferred ancillary startup refreshes](deferred-ancillary-startup-refreshes.md) |
| [Feature: No automatic restore of last active thread on startup](no-automatic-restore-of-last-active-thread-on-startup.md) |
| [Feature: Disable auto-restore to last thread when opening home URL](disable-auto-restore-to-last-thread-when-opening-home-url.md) |
| [Feature: Thread load capped to latest 10 turns](thread-load-capped-to-latest-10-turns.md) |
| [Feature: Pinned threads persist across reload and prune removed threads](pinned-threads-persist-across-reload-and-prune-removed-threads.md) |
| [Feature: Keep manual chat scroll position during streaming](keep-manual-chat-scroll-position-during-streaming.md) |
| [Feature: Rapid thread switching during active load](rapid-thread-switching-during-active-load.md) |
| [Feature: Thread auto-scrolls to latest message after load](thread-auto-scrolls-to-latest-message-after-load.md) |
| [Feature: Assistant streaming does not force-scroll when user is reading history](assistant-streaming-does-not-force-scroll-when-user-is-reading-history.md) |
| [Feature: While reading older messages, stream growth keeps viewport pinned](while-reading-older-messages-stream-growth-keeps-viewport-pinned.md) |
| [Feature: Thread stream parity — stream-first hydration with full turn history](thread-stream-parity-stream-first-hydration-with-full-turn-history.md) |
| [Feature: Thread stream parity works on Linux (Oracle A1 ARM64)](thread-stream-parity-works-on-linux-oracle-a1-arm64.md) |
| [Thread list startup pagination and direct older-thread links](thread-list-startup-pagination-and-direct-older-thread-links.md) |
| [Thread-list first-page request state across account switches](thread-list-account-switch-inflight-request.md) |
| [Thread history in-flight state across account switches](thread-history-inflight-account-switch.md) |
| [会话通知停止与重新启动](thread-notification-stop-restart.md) |
| [审批与输入请求恢复、回复生命周期](thread-pending-request-lifecycle.md) |
| [会话发送的账号与停止生命周期](thread-send-lifecycle.md) |
| [会话metadata的账号与停止生命周期](thread-metadata-lifecycle.md) |
| [会话选择、偏好恢复与停止生命周期](thread-selection-lifecycle.md) |
| [Thread detail load avoids duplicate live-state history fetch](thread-detail-load-avoids-duplicate-live-state-history-fetch.md) |
| [Thread message cache skips unchanged refetches](thread-message-cache-skips-unchanged-refetches.md) |
| [Thread selection keeps sidebar list stable during refresh](thread-selection-keeps-sidebar-list-stable-during-refresh.md) |
| [Sidebar thread row edge click selects thread](sidebar-thread-row-edge-click-selects-thread.md) |
| [Sidebar thread inline delete confirmation and menu pin action](sidebar-thread-inline-delete-confirmation-and-menu-pin-action.md) |
| [Active thread switches after delete](active-thread-switches-after-delete.md) |
| [Thread open always autoscrolls to latest](thread-open-always-autoscrolls-to-latest.md) |
| [Thread conversation loads earlier turns on demand](thread-conversation-loads-earlier-turns-on-demand.md) |
| [Missing thread route errors render in chat](missing-thread-route-errors-render-in-chat.md) |
| [Non-thread startup selection priming](non-thread-startup-selection-priming.md) |
| [0.2.2 原生历史分页与精确分支](native-history-and-exact-fork.md) |
| [0.2.2 搜索更新、范围与取消](thread-search-freshness-and-cancellation.md) |
| [Feature: Ancillary goal and status read degradation](ancillary-metadata-read-degradation.md) |
| [回合状态、列表优先级与中断持久化门禁](thread-turn-status.md) |
| [会话用量、终端偏好与快照恢复](thread-presentation-persistence.md) |
| [0.2.22侧栏分页、未知重试、固定与项目操作整合](sidebar-integration-022.md) |
| [0.2.22 production 加载、请求与资源预算](production-performance-budget-022.md) |
