import { basename, isAbsolute } from 'node:path'
import { isVirtualProjectId } from '../projectOrganization.js'
import { asRecord, getErrorMessage } from './httpUtils.js'
import { createDirectoryListingHtml } from './localBrowseUi.js'
import { readProjectDirectories } from './projectDirectories.js'
import { getVirtualProjectStore } from './workspaceStateService.js'

type ProjectAccessDependencies = {
  basename: (path: string) => string
  isAbsolute: (path: string) => boolean
  isVirtualProjectId: (value: string) => boolean
  readProjectDirectories: (root: string) => Promise<string[]>
  readProject: (id: string) => Promise<{ label: string; cwds: string[] }>
  renderProjectFiles: (label: string, entries: Array<{ name: string; path: string }>) => Promise<string>
  assignProjectMembership: (cwd: string, projectId: string | null) => Promise<void>
}
type ProjectDirectoriesResult = { status: 200; data: string[] } | { status: 400; error: string }

export function createProjectAccessService(
  dependencies: ProjectAccessDependencies = {
    basename, isAbsolute, isVirtualProjectId, readProjectDirectories,
    readProject: id => getVirtualProjectStore().get(id),
    renderProjectFiles: (label, entries) => createDirectoryListingHtml(label, { entries }),
    assignProjectMembership: (cwd, projectId) => getVirtualProjectStore().assign(cwd, projectId),
  },
) {
  const { assignProjectMembership, basename, isAbsolute, isVirtualProjectId, readProject, readProjectDirectories, renderProjectFiles } = dependencies
  return {
    async prepareFilesListing(id: string): Promise<() => Promise<string>> {
      const project = await readProject(id)
      const entries = project.cwds.map(cwd => ({ name: basename(cwd), path: cwd }))
      // The route sets HTML headers after metadata succeeds and before rendering.
      return () => renderProjectFiles(project.label, entries)
    },
    async directories(root: string): Promise<ProjectDirectoriesResult> {
      if (isVirtualProjectId(root)) return { status: 200, data: [] }
      if (!isAbsolute(root)) return { status: 400, error: '工作目录必须填写绝对路径' }
      try {
        return { status: 200, data: await readProjectDirectories(root) }
      } catch (error) {
        return { status: 400, error: getErrorMessage(error, '读取项目工作目录失败') }
      }
    },
    async assignMembership(input: unknown): Promise<void> {
      const payload = asRecord(input)
      const cwd = typeof payload?.cwd === 'string' ? payload.cwd : ''
      const projectId = typeof payload?.projectId === 'string' ? payload.projectId : null
      await assignProjectMembership(cwd, projectId)
    },
  }
}
