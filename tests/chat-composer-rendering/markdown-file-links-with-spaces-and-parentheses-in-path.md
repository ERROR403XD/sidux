### Feature: Markdown file links with spaces and parentheses in path

#### Prerequisites
- App is running from this repository.
- An active thread is open.
- File exists at `/home/ubuntu/Documents/New Project (2)/hosting_manager.py`.

#### Steps
1. Send this exact message:
   `[hosting_manager.py](/home/ubuntu/Documents/New Project (2)/hosting_manager.py)`
2. In the rendered message, confirm it appears as one clickable file link.
3. Click the link and confirm it opens local browse for the full file path.
4. Right-click and use `Copy link`, then verify pasted URL still points to the same full path.

#### Expected Results
- Markdown link is parsed as one link token (not split at `)` inside the path).
- Clicking navigates to the full file path in local browse view.
- Copied link contains the complete encoded path.

#### Rollback/Cleanup
- Remove test file if it was created only for this verification.

## dev.8 审核：URL 分隔符、字面百分号与精确文件身份

### 前置条件

- 使用独立4173合成home；新建任务专属目录，所有文件均写入不同marker。三个视口1440×1000、768×1024、375×812各测浅深主题。
- 准备`report#draft.txt`、`report?draft.txt`、`report`，以及`percent%23.txt`/`percent#.txt`、`percent%20.txt`/`percent .txt`。空格/括号、`中文.txt`、`invalid%zz.txt`为对照。
- 保存检查只在`--network none`、无端口映射的独立容器中运行已安装CLI，不对已有用户文件执行PUT。

### 操作与预期

1. 在会话中展示每个样本的Markdown文件链接，核对href、title、text；点击含`#`的链接并读取实际内容，再刷新会话重复核对。
2. 从目录列表打开同一文件并检查编辑入口。文件名中的`#`、`?`必须位于编码后的pathname内，不能成为query/fragment；打开应返回所选文件的marker。
3. 对比按路径段`encodeURIComponent`构造的browse URL与`codex-local-file?path=`。开发服务器与已安装包均应返回同一文件，中文文件名不得产生500或遮挡页面的错误弹层。
4. 在容器中打开编辑页、PUT新marker，再逐字节检查目录内全部文件。仅所选文件应改变，字面`%23`/`%20`不能被再次解码成另一个文件名。
5. 记录成功对照与失败，包含响应码、实际字节、URL、视口和截图。不能仅凭200、正确标签或正确title判断文件身份通过。

### 当前证据与清理

- `docs/baseline/022/dev8-review-20261020/results/local-file-links.json`确认R30/R32；`local-file-paths.json`确认已安装包R31保存错文件，均未修复。
- 本地编辑页依赖外部Ace CDN；本轮未放行CDN，编辑页只核对HTTP生成内容，保存合同通过真实HTTP和磁盘验证，不宣称浏览器编辑器已完整验收。
- 结束后核对文件原字节并精确删除本轮目录、marker会话和manifest；关闭浏览器与临时容器。4173保持运行；若合成fixture内存保留已删会话，须核实进程/home与活动归属后清理，不能把内存残留当真实运行状态。
