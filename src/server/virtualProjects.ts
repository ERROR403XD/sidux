import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { isProjectlessChatPath, normalizePathForComparison } from '../pathUtils.js'
import { isVirtualProjectId, type VirtualProject } from '../projectOrganization.js'

export class VirtualProjectStore {
  private mutation: Promise<unknown> = Promise.resolve()
  readonly path: string

  constructor(private readonly home: string) {
    this.path = join(home, 'codexapp-projects.json')
  }

  async list(): Promise<VirtualProject[]> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'))
      if (value?.version !== 1 || !Array.isArray(value.projects)) throw new Error('Invalid project state')
      const ids = new Set<string>()
      const cwds = new Set<string>()
      for (const project of value.projects) {
        if (!project || typeof project.id !== 'string' || !isVirtualProjectId(project.id) || ids.has(project.id)
          || typeof project.label !== 'string' || !project.label.trim()
          || !Array.isArray(project.cwds) || project.cwds.some((path: unknown) => typeof path !== 'string' || !isAbsolute(path) || !isProjectlessChatPath(path))) {
          throw new Error('Invalid project state')
        }
        ids.add(project.id)
        for (const cwd of project.cwds) {
          const key = normalizePathForComparison(cwd)
          if (cwds.has(key)) throw new Error('Invalid project membership')
          cwds.add(key)
        }
      }
      return value.projects
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async get(id: string): Promise<VirtualProject> {
    const project = (await this.list()).find(project => project.id === id)
    if (!project) throw new Error('Project not found')
    return project
  }

  private update<T>(change: (projects: VirtualProject[]) => T | Promise<T>): Promise<T> {
    const operation = this.mutation.catch(() => undefined).then(async () => {
      const projects = await this.list()
      const result = await change(projects)
      await mkdir(this.home, { recursive: true })
      const temporary = `${this.path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, projects }), { mode: 0o600 })
        await rename(temporary, this.path)
      } finally {
        await rm(temporary, { force: true })
      }
      return result
    })
    this.mutation = operation
    return operation
  }

  save(id: string | undefined, label: string): Promise<VirtualProject> {
    return this.update(async projects => {
      if (!label.trim()) throw new Error('Enter a project name.')
      let project = id ? projects.find(project => project.id === id) : undefined
      if (id && !project) throw new Error('Project not found')
      if (!project) {
        project = { id: `virtual:${randomUUID()}`, label: label.trim(), cwds: [] }
        projects.push(project)
      } else {
        project.label = label.trim()
      }
      return project
    })
  }

  assign(cwd: string, id: string | null): Promise<void> {
    return this.assignMembership(cwd, id, false)
  }

  // An automation's organization is presentation only. Removal may race with
  // directory creation; decide membership inside the same mutation queue.
  assignIfPresent(cwd: string, id: string): Promise<void> {
    return this.assignMembership(cwd, id, true)
  }

  private assignMembership(cwd: string, id: string | null, optional: boolean): Promise<void> {
    return this.update(projects => {
      if (!isAbsolute(cwd) || !isProjectlessChatPath(cwd) || /[\r\n\0]/u.test(cwd)) throw new Error('Invalid conversation directory')
      const target = id ? projects.find(project => project.id === id) : undefined
      if (id && !target) {
        if (optional) return
        throw new Error('Project not found')
      }
      const key = normalizePathForComparison(cwd)
      for (const project of projects) project.cwds = project.cwds.filter(path => normalizePathForComparison(path) !== key)
      if (target) target.cwds.push(cwd)
    })
  }

  remove(id: string): Promise<void> {
    return this.update(projects => {
      const index = projects.findIndex(project => project.id === id)
      if (index >= 0) projects.splice(index, 1)
    })
  }
}
