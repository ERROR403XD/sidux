import { describe, expect, it } from 'vitest'
import { maySupplementImportedThreads } from './threadListCompatibility'

describe('legacy import supplementation', () => {
  it('preserves ordinary initial listing while leaving filtered and cursor pages native', () => {
    expect(maySupplementImportedThreads({ archived: false, cursor: null, modelProviders: [], limit: 100 })).toBe(true)
    for (const params of [{ parentThreadId: 'parent' }, { ancestorThreadId: 'parent' }, { searchTerm: 'needle' }, { sourceKinds: ['subAgentThreadSpawn'] }, { cwd: '/repo' }, { projectId: null }, { cursor: 'page-2' }, { archived: true }, { sortDirection: 'asc' }]) {
      expect(maySupplementImportedThreads(params)).toBe(false)
    }
  })
})
