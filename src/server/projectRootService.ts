import type { Stats } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { isVirtualProjectId, type VirtualProject } from '../projectOrganization.js'
import { asRecord, getErrorMessage } from './httpUtils.js'
import { saveProjectDirectories } from './projectDirectories.js'
import { getVirtualProjectStore, persistWorkspaceRoot, queueWorkspaceRootsMutation, updateWorkspaceRootsState } from './workspaceStateService.js'

type ProjectRootState = { [key: string]: unknown; projectOrder: string[] }
type ProjectRootDependencies = {
  isAbsolute: (path: string) => boolean
  isVirtualProjectId: (value: string) => boolean
  mkdir: (path: string, options: { recursive: true }) => Promise<string | undefined>
  persistWorkspaceRoot: (workspaceRoot: string, label?: string) => Promise<void>
  queueWorkspaceRootsMutation: <T>(mutation: () => Promise<T>) => Promise<T>
  saveProjectDirectories: (root: string, value: unknown) => Promise<void>
  removeVirtualProject: (id: string) => Promise<void>
  saveVirtualProject: (id: string | undefined, label: string) => Promise<VirtualProject>
  stat: (path: string) => Promise<Stats>
  resolve: (path: string) => string
  updateWorkspaceRootsState: (updater: <T extends ProjectRootState>(existingState: T) => T) => Promise<void>
}
type ProjectRootResult = { status: 200; path: string } | { status: 400 | 404; error: string }

function prependUniqueString(value: string, items: string[]): string[] {
  return [value, ...items.filter(item => item !== value)]
}

export function createProjectRootService(dependencies: ProjectRootDependencies = {
  isAbsolute, isVirtualProjectId, mkdir, persistWorkspaceRoot, queueWorkspaceRootsMutation, saveProjectDirectories, stat, resolve, updateWorkspaceRootsState,
  removeVirtualProject: id => getVirtualProjectStore().remove(id),
  saveVirtualProject: (id, label) => getVirtualProjectStore().save(id, label),
}) {
  const { isAbsolute, isVirtualProjectId, mkdir, persistWorkspaceRoot, queueWorkspaceRootsMutation, removeVirtualProject, saveProjectDirectories, saveVirtualProject, resolve, stat, updateWorkspaceRootsState } = dependencies

  return {
    async removeRoot(id: string): Promise<boolean> {
      if (!isVirtualProjectId(id)) return false
      await removeVirtualProject(id)
      await updateWorkspaceRootsState(state => ({
        ...state,
        projectOrder: state.projectOrder.filter(item => item !== id),
      }))
      return true
    },

    async saveRoot(input: unknown): Promise<ProjectRootResult> {
      const payload = asRecord(input)
      const rawPath = typeof payload?.path === 'string' ? payload.path.trim() : ''
      const createIfMissing = payload?.createIfMissing === true
      const label = typeof payload?.label === 'string' ? payload.label : ''
      if (!rawPath || isVirtualProjectId(rawPath)) {
        const project = await saveVirtualProject(rawPath || undefined, label)
        await updateWorkspaceRootsState(state => ({
          ...state,
          projectOrder: prependUniqueString(project.id, state.projectOrder),
        }))
        return { status: 200, path: project.id }
      }

      const normalizedPath = isAbsolute(rawPath) ? rawPath : resolve(rawPath)
      let pathExists = true
      try {
        const info = await stat(normalizedPath)
        if (!info.isDirectory()) return { status: 400, error: 'Path exists but is not a directory' }
      } catch {
        pathExists = false
      }

      if (!pathExists && createIfMissing) {
        await mkdir(normalizedPath, { recursive: true })
      } else if (!pathExists) {
        return { status: 404, error: 'Directory does not exist' }
      }

      if (payload && Object.hasOwn(payload, 'directories')) {
        try {
          await queueWorkspaceRootsMutation(() => saveProjectDirectories(normalizedPath, payload.directories))
        } catch (error) {
          return { status: 400, error: getErrorMessage(error, '保存项目工作目录失败') }
        }
      }
      await persistWorkspaceRoot(normalizedPath, label)
      return { status: 200, path: normalizedPath }
    },
  }
}
