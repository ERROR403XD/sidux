// Only seed fictional data inside the isolated candidate container.
if (process.env.CODEX_HOME !== '/codex-home') throw new Error('Run this fixture inside the isolated CodexApp container');
const fs=require('node:fs'); const path=require('node:path');
const root='/test-workspace/automation-0190';
for(const dir of ['笔记/日记/2026-08','笔记/日记/2026-09','日历'])fs.mkdirSync(path.join(root,dir),{recursive:true});
fs.writeFileSync(path.join(root,'AGENTS.md'),'这是 CodexApp 0.1.90 的虚构验收目录。所有输入与输出都必须在当前目录中；不要读取外部路径，不使用网络服务。\n');
fs.writeFileSync(path.join(root,'笔记/日记/2026-08/2026-08-26.md'),'# 虚构日记 2026-08-26\n今天完成了虚构项目“纸船”的第一个页面。这是本周唯一需要归档的重要事件。\n');
fs.writeFileSync(path.join(root,'笔记/日记/2026-08/2026-08-28.md'),'# 虚构日记 2026-08-28\n今天整理了测试桌面，无重要事件。\n');
fs.writeFileSync(path.join(root,'笔记/日记/2026-09/2026-09-01.md'),'# 虚构日记 2026-09-01\n这条位于验收范围之外，不应写入日历。\n');
fs.writeFileSync(path.join(root,'README.md'),'CodexApp 0.1.90 内部验收：全部数据为虚构。验收时间范围固定为 2026-08-24 至 2026-08-30。输出日历/fixture-0190.md。\n');
console.log('fictional fixture ready; files=5');
