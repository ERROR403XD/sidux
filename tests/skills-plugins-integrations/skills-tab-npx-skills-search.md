### Skills tab npx skills search

#### Feature/Change Name
The Skills tab includes a registry search panel backed by `npx skills find`, shows matching skill cards, and installs selected registry results with `npx skills add`.

#### Prerequisites/Setup
1. Dev server running at `http://127.0.0.1:4173`
2. Network access available for `npx skills find`
3. `npx` can run the published `skills` package
4. Light theme and dark theme both available from the appearance switcher

#### Steps
1. Open `http://127.0.0.1:4173/#/skills`
2. Verify the `Skills` tab is selected by default; open `http://127.0.0.1:4173/#/skills?tab=plugins`, then click `Skills` and verify the URL updates to `?tab=skills`
3. Verify the `Find skills` header shows a `Skills directory` link on the right that opens `https://skills.anyclaw.store/` in a new tab
4. In `Find skills`, type a query such as `browser`
5. Click `Search`
6. Verify the app calls `/codex-api/skills-hub/search?q=browser`, which runs `npx --yes skills find browser`
7. Verify search results appear above the installed-skills section, whose expanded body contains the filter.
8. Verify each registry result card shows its install count metadata, such as `1.2K installs`, even when a GitHub `SKILL.md` description is shown
9. Open one GitHub-backed result and verify the detail modal shows the skill name, owner/repository, parsed `SKILL.md` description, GitHub-backed icon/avatar, and external link
10. Click `Install` for a result and verify the backend runs `npx --yes skills add <owner/repo@skill> --yes --global`
11. After install, verify the result becomes installed and the installed skills list refreshes from local installed skill data rather than appending the remote registry card
12. Switch to dark theme and repeat the search visibility check
13. Search for an already-installed skill and verify its search result shows `Installed`
14. Verify installed matches in search results keep their remote registry owner/details while showing the `Installed` badge
15. Open the installed search result and verify the modal reads the local installed `SKILL.md`, exposes `Uninstall`, and does not show the registry install flow
16. Open a local-only installed skill and verify the modal does not show a dead `View on GitHub` link when no external URL is available
17. Verify cards in the `Installed skills (count)` section do not show `Installed`, `Disabled`, or repeated `local` owner labels, while search result cards can still show installed state and registry owner details
18. Verify installed cards show local `SKILL.md` descriptions when the installed skill has frontmatter or readable markdown content
19. Verify Find skills result cards do not show the local folder browse icon; Browse files remains available inside the installed local modal

#### Expected Results
- Search results are parsed from the real `npx skills find` output, not a static catalog
- Skills search/install commands use the repo command invocation wrapper so `npx` starts reliably on Windows
- Skills search/install commands include outer `npx --yes` so first-run package prompts cannot hang with ignored stdin
- The Skills directory link is visible beside Find skills in light and dark theme and opens the public directory in a new tab
- Registry installs run noninteractively with `--yes --global`, so the process cannot stop at the agent-selection prompt and falsely report success
- Registry install responses only return `ok: true` when the local installed `SKILL.md` path is found and validates successfully
- The UI treats a missing returned path or missing post-refresh local skill as an install failure instead of showing the remote registry card as installed
- GitHub-backed results fetch the repository `SKILL.md` and show its `description` frontmatter when available, falling back to the install count when unavailable
- GitHub metadata enrichment is bounded to the first 20 results with limited concurrency, so broad searches still return without unbounded raw GitHub fetch fanout
- Search result cards keep the registry install count visible as card metadata even when GitHub enrichment replaces the fallback description
- GitHub-backed results show an explicit frontmatter `icon` when provided, otherwise they show the GitHub repository owner avatar instead of a generic letter fallback
- The search UI does not replace or hide local installed skills
- Installed matching results show the existing `Installed` badge and can be opened like local skills
- Installed detection uses the same installed skills source as the Skills Hub list, including RPC/plugin/shared skills and not only the base skills directory
- Installed search result cards keep remote registry ownership/content but include local installed state and path for actions
- Newly installed registry results are reloaded from the local installed skills source before appearing in the Installed skills section
- Opening an installed search result uses the local installed skill record/path, so local content, uninstall, enable/disable, browse, and try actions behave the same as the Installed skills section
- Local-only installed skills hide the external GitHub link when no URL is available
- Installed skills section cards hide redundant installed/disabled status labels
- Installed skills section cards hide the repeated local owner label; registry search cards keep owner/repository labels to distinguish remote results
- Installed skill descriptions come from the local installed `SKILL.md`, so installed cards are useful without opening each modal
- Installed entries are assembled concurrently so reading local `SKILL.md` descriptions does not add one file-read round trip per installed skill
- Opening or switching to the Skills tab lists MCP servers without forcing an MCP reload; the top-level Refresh button remains the explicit reload action
- The top-level Refresh button only shows `Refreshing...` for explicit user-triggered refreshes, not for ordinary initial tab loading
- Find skills cards hide local folder browse actions to avoid mixing remote registry cards with local-only card controls
- Light theme and dark theme keep the search panel, cards, and modal readable

#### Rollback/Cleanup
- Uninstall any skill installed only for this test

---

#### 0.2.17 应用页布局与已安装技能筛选

前提：4173 的插件/MCP/技能样本，中文和英文，1440×1000、768×1024、375×812 的明暗主题。

1. 从侧栏“应用”进入，主内容顶部只有“应用”大标题；不出现“设置 / 扩展管理”“插件 / 技能 / MCP”副标题或“技能中心”。插件与技能/MCP 两个选项卡文字居中。
2. 技能页顺序为 MCP 连接、查找技能、搜索结果、已安装技能。已安装技能展开后，筛选框位于该控件内部、标题与卡片列表之间；收起时隐藏筛选框，再展开保留筛选词。MCP、结果和已安装列表使用相同数量徽标及右对齐展开箭头；鼠标和键盘都能展开/收起。
3. 在已安装筛选框输入技能名称、描述、作者或路径片段，显示匹配项及数量；使用仅在简介中出现的中英文关键词（例如名称 alpha、简介 Orchestrate nebula releases，输入 NEBULA；名称 beta、简介 批量整理图片素材，输入 图片素材），确认忽略英文大小写和首尾空格。无匹配显示 0 和空状态。清空恢复全部，筛选不请求远端、不重读安装目录。远端查找仍只有显式搜索产生一次请求。
4. 检查菜单宽度、长名称、空列表和手机布局无溢出；深色无浅色背景。保存实际页面截图及请求计数。
5. 对特定词查不到结果，先确认该实例的 `/codex-api/skills-hub` 是否包含目标技能，不以生产主机已安装推定隔离候选也已安装。用真实包含 homepage-maintenance、x-bot-maintenance、telegram-bridge-send 的元数据在浏览器样本中验证：homepage 命中第一项，bot 命中后两项，其中 Telegram 通过简介匹配。原清单缺少这些条目时应为 0；清空恢复原数量，禁止为通过测试而偷偷同步技能或认证。

清理：关闭样本浏览器上下文；不安装/卸载真实技能，不改变 MCP 配置。
