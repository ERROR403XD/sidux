import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  type FreeModeState,
  createDefaultOpenCodeZenFreeModeState,
  shouldCreateDefaultFreeModeStateForMissingAuth,
  shouldSuppressCommunityFreeModeForCodexAuth,
} from './freeMode.js'
import { hasUsableCodexAuthSync, refreshChatgptAuthTokensForExternalAuth } from './appServerAuth.js'
import { getCodexHomeDir } from './runtimePaths.js'

export { refreshChatgptAuthTokensForExternalAuth }

function readFreeModeStateSync(statePath: string): FreeModeState | null {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8')) as FreeModeState
  } catch {
    return null
  }
}

type TomlScanState = {
  inMultilineBasicString: boolean
  inMultilineLiteralString: boolean
}

function stripTomlComment(line: string, state: TomlScanState): string {
  let content = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false
  for (let i = 0; i < line.length; i++) {
    if (state.inMultilineBasicString) {
      const end = line.indexOf('"""', i)
      if (end === -1) return content
      state.inMultilineBasicString = false
      i = end + 2
      continue
    }
    if (state.inMultilineLiteralString) {
      const end = line.indexOf("'''", i)
      if (end === -1) return content
      state.inMultilineLiteralString = false
      i = end + 2
      continue
    }
    const ch = line[i]
    if (inDoubleQuote && escaped) {
      escaped = false
      content += ch
      continue
    }
    if (inDoubleQuote && ch === '\\') {
      escaped = true
      content += ch
      continue
    }
    if (!inSingleQuote && !inDoubleQuote && line.startsWith('"""', i)) {
      state.inMultilineBasicString = true
      i += 2
      continue
    }
    if (!inSingleQuote && !inDoubleQuote && line.startsWith("'''", i)) {
      state.inMultilineLiteralString = true
      i += 2
      continue
    }
    if (!inDoubleQuote && ch === "'") {
      inSingleQuote = !inSingleQuote
      content += ch
      continue
    }
    if (!inSingleQuote && ch === '"') {
      inDoubleQuote = !inDoubleQuote
      content += ch
      continue
    }
    if (!inSingleQuote && !inDoubleQuote && ch === '#') {
      return content
    }
    content += ch
  }
  return content
}

function isModelProviderAssignment(content: string): boolean {
  return /^(?:model_provider|"model_provider"|'model_provider')\s*=/.test(content)
}

let explicitCodexModelProviderConfigCache: {
  path: string
  mtimeMs: number | null
  size: number | null
  value: boolean
} | null = null

function hasExplicitCodexModelProviderConfigSync(): boolean {
  const configPath = join(getCodexHomeDir(), 'config.toml')
  let info: ReturnType<typeof statSync> | null = null
  try {
    info = statSync(configPath)
  } catch {
    explicitCodexModelProviderConfigCache = {
      path: configPath,
      mtimeMs: null,
      size: null,
      value: false,
    }
    return false
  }
  if (
    explicitCodexModelProviderConfigCache?.path === configPath
    && explicitCodexModelProviderConfigCache.mtimeMs === info.mtimeMs
    && explicitCodexModelProviderConfigCache.size === info.size
  ) {
    return explicitCodexModelProviderConfigCache.value
  }

  let value = false
  try {
    const raw = readFileSync(configPath, 'utf8')
    let inTopLevelTable = true
    const scanState: TomlScanState = {
      inMultilineBasicString: false,
      inMultilineLiteralString: false,
    }
    for (const line of raw.split(/\r?\n/)) {
      const content = stripTomlComment(line, scanState).trim()
      if (!content) continue
      if (/^\[\[?[^\]]+\]?\]$/.test(content)) {
        inTopLevelTable = false
        continue
      }
      if (!inTopLevelTable) continue
      if (isModelProviderAssignment(content)) {
        value = true
        break
      }
    }
  } catch {
    value = false
  }
  explicitCodexModelProviderConfigCache = {
    path: configPath,
    mtimeMs: info.mtimeMs,
    size: info.size,
    value,
  }
  return value
}


export function ensureDefaultFreeModeStateForMissingAuthSync(statePath: string): FreeModeState | null {
  const current = readFreeModeStateSync(statePath)
  const hasUsableCodexAuth = hasUsableCodexAuthSync()
  if (shouldSuppressCommunityFreeModeForCodexAuth(current, hasUsableCodexAuth)) {
    return null
  }
  const shouldCreateDefault = shouldCreateDefaultFreeModeStateForMissingAuth(current, hasUsableCodexAuth)
  const hasExplicitModelProviderConfig = shouldCreateDefault && hasExplicitCodexModelProviderConfigSync()
  if (hasExplicitModelProviderConfig || !shouldCreateDefault) {
    return current
  }

  return createDefaultOpenCodeZenFreeModeState()
}
