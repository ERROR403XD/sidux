# Skills route UI

## 当前入口

0.2.13从设置“集成”中的“技能、应用与 MCP”进入 `#/skills`。首页侧栏技能管理入口和首次插件推广卡已移除；聊天输入框的技能选择保留。页面标题仍为Skills，目录内部仍为Skills & Apps。

旧推广卡偏好端点保留兼容，但首页不再访问；不需要迁移或删除原偏好。

验证时分别检查浅深主题与桌面、平板、手机，确认设置入口可用、首页无推广卡，原目录路由仍可直接访问。

来源：[0.2.13实现事实](../../raw/features/settings-model-routing-0213.md)。原始历史实现见[早期入口与推广卡](../../raw/features/skills-route-ui-and-first-launch-card.md)，其中首页行为已被上述来源取代。
