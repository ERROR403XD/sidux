# 额度进度条发光状态（0.2.20）

## 前置条件

- 隔离的 `127.0.0.1:4173` 开发服务器（独立 `CODEX_HOME`，不使用生产环境）。
- 一个带额度快照的账号卡片。没有真实账号时，可只拦截 `GET /codex-api/accounts` 返回固定快照（`quotaSnapshot.primary.usedPercent = 100`、`secondary.usedPercent = 0`），不改动任何账号凭据。

## 操作与预期结果

1. 打开侧栏账号与用量弹窗或 `#/settings` 的“OpenAI账号”分区，确认 5 小时与 7 天各有一条进度条。
2. 剩余 0% 的进度条（红色）持续发光，不再做亮暗闪烁；连续观察 3 秒以上，`getComputedStyle` 的 `animation-name` 为 `none`，`box-shadow` 两次采样完全一致。
3. 剩余 100% 的进度条同样带稳定发光，与 0% 状态使用同一套“1px 描边 + 9px 光晕”，颜色取该进度条自身的额度颜色。
4. 50% 等中间状态不带发光，只有 0% 与 100% 两个端点状态发光。
5. 浅色与深色主题分别检查：深色下卡片、进度条与外发光都不出现浅色残留，1440×900 无横向溢出。
6. 降低系统动效偏好的环境（`prefers-reduced-motion: reduce`）结果一致，因为发光不再依赖动画。

## 工程验证

- `pnpm exec vitest run src/quotaPresentation.test.ts`：`quotaFull` 只在显示值为 100 时为真（已用数值 0/0.4/50/100 覆盖）。
- 浅深主题截图：`output/playwright/quota-glow-light-cjs.png`、`output/playwright/quota-glow-dark-cjs.png`。

## 回滚与清理

仅关闭页面或停止本次临时 `4173` 服务；本项不写入账号、额度或 key 状态，无需回滚数据。
