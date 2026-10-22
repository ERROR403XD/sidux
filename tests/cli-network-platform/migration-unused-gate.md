### 功能：0.2.22 迁移残留与窄诊断门禁

#### 前置条件
- 使用当前 Linux 工具链和依赖；源码与标准候选状态分离。
- `scripts/022-migration-unused-baseline.json` 登记迁移区域和经封版对照的继承诊断，不代表全仓 noUnused 通过。

#### 操作
1. 运行 `node scripts/check-022-migration-unused.cjs`，检查真实 vue-tsc 输出。迁移区域的新文件自动落入相应目录/命名范围。
2. 在独立临时分支的新 conversation controller 中加入未使用符号，复跑；门禁必须退出1并指出新文件/符号，不能只比较总条数。
3. 去掉该探针；运行全量单测和 build。确认 App/GeneralSettings 模板与样式保持，宏的props和当前设置控制器仍有效。
4. 使用独立合成home的4173运行 `node scripts/verify-022-boundary-surfaces.cjs`。核对首页、会话、设置、API和自动化实际区域，亮中文/暗英文以及1440×1000、768×1024、375×812。
5. 在设置中检查界面语言和已存听写语言；刷新后仍保留。检查页面无异常、恢复错误页或横向溢出。

#### 预期
- 新诊断、多余同名诊断和普通类型错误失败；已有继承诊断没有被当作迁移新增问题，也不放宽全仓tsconfig。
- 当前公共props/emits、动态class、Teleport、深色覆盖和中英文名称保持；不能依据文本无匹配删除仍有动态消费者的样式。
- 证据在 `output/playwright/022-cleanup/surfaces/`，实际UI三种宽度的浅深主题都可用。

#### 清理
- 删除自己创建的唯一探针并确认文件不存在；关闭独立浏览器上下文。
- 不修改候选/生产配置，不清空任何标准持久卷。
