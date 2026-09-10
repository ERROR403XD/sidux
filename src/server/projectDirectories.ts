import { lstat, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, normalize } from 'node:path'
import { randomUUID } from 'node:crypto'

const START = '<!-- codexapp:work-directories:start -->'
const END = '<!-- codexapp:work-directories:end -->'

export function readProjectDirectoryBlock(content: string): string[] {
  const start = content.indexOf(START)
  if (start < 0) return []
  const end = content.indexOf(END, start)
  if (end < 0 || content.indexOf(START, start + START.length) >= 0) throw new Error('AGENTS.md 工作目录区块不完整，请先修复')
  const match = content.slice(start, end).match(/```json\s*([\s\S]*?)\s*```/u)
  const paths: unknown = match ? JSON.parse(match[1]) : null
  if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string')) throw new Error('AGENTS.md 工作目录区块格式无效')
  return paths
}

export function updateProjectDirectoryBlock(content: string, paths: string[]): string {
  readProjectDirectoryBlock(content)
  const block = `${START}\n## 项目工作目录\n\n当前项目除主目录外，还包含以下工作目录。请根据任务在这些目录中查找和修改相关文件；操作各目录前先阅读适用于该目录的 AGENTS.md，不要把附加目录误当作主目录的子目录。\n\n\`\`\`json\n${JSON.stringify(paths, null, 2)}\n\`\`\`\n${END}`
  const start = content.indexOf(START)
  if (start >= 0) return content.slice(0, start) + block + content.slice(content.indexOf(END, start) + END.length)
  if (content.includes(END)) throw new Error('AGENTS.md 工作目录区块不完整，请先修复')
  return content + (content.endsWith('\n\n') || !content ? '' : content.endsWith('\n') ? '\n' : '\n\n') + block + '\n'
}

export async function readProjectDirectories(root: string): Promise<string[]> {
  try {
    return readProjectDirectoryBlock(await readFile(join(root, 'AGENTS.md'), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function saveProjectDirectories(root: string, value: unknown): Promise<void> {
  if (!Array.isArray(value) || value.some(path => typeof path !== 'string' || !isAbsolute(path.trim()) || /[\r\n\0]/u.test(path))) {
    throw new Error('工作目录必须填写绝对路径')
  }
  const paths = [...new Set((value as string[]).map(path => normalize(path.trim())))].filter(path => path !== normalize(root))
  for (const path of paths) {
    if (!(await stat(path)).isDirectory()) throw new Error('工作目录必须是已有文件夹')
  }
  const target = join(root, 'AGENTS.md')
  let content = ''
  let mode = 0o644
  try {
    const info = await lstat(target)
    if (info.isSymbolicLink()) throw new Error('项目 AGENTS.md 是符号链接，请先改为项目独立文件再维护工作目录')
    mode = info.mode
    content = await readFile(target, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (!paths.length && !content.includes(START)) return
  const next = updateProjectDirectoryBlock(content, paths)
  if (next === content) return
  const temporary = `${target}.${randomUUID()}.tmp`
  await writeFile(temporary, next, { mode })
  await rename(temporary, target)
}
