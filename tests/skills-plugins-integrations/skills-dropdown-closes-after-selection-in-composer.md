### Feature: Skills dropdown closes after selection in composer

#### Prerequisites
- App is running from this repository.
- At least one thread exists and can be selected.
- At least one installed skill is available.

#### Steps
1. Open an existing thread so the message composer is enabled.
2. Click the `Skills` dropdown in the composer footer.
3. Click any skill option in the dropdown list.
4. Re-open the `Skills` dropdown and click the same skill again to unselect it.

#### Expected Results
- The skills dropdown closes immediately after each selection click.
- Selected skill appears as a chip above the composer input when checked.
- Skill chip is removed when the skill is unchecked on the next selection.

#### Rollback/Cleanup
- Remove the selected skill chip(s) before leaving the thread, if needed.

### dev.8 审核：技能搜索输入法确认（R79，未修复）

- 前置：隔离组件夹具，至少一个匹配“审阅”的技能；不发送模型消息。
- 操作：打开技能搜索并输入“审阅”；在组合输入期间派发compositionstart和isComposing=true的Enter，检查toggle事件、选中值和菜单；普通Enter使用独立上下文作为正常对照。
- 预期：输入法确认期间不选中技能、不关闭搜索；组合结束后的普通Enter才选择高亮项。
- dev.8实测：两种Enter均选中一次并关闭菜单；两场景8检查5通过/3失败，零API请求。证据只覆盖Chromium合成事件，真实系统输入法仍需设备验收。
- 清理：关闭两个上下文，清除夹具选择，不写入真实会话或提示词。截图和事件见`docs/baseline/022/dev8-review-20261020/results/entry-ui-submit-contracts.json`。
