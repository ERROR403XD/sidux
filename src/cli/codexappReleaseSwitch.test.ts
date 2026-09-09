import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const temporaryRoots: string[] = []
const switchScript = resolve(process.cwd(), 'scripts/codexapp-release-switch.sh')

async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, body, 'utf8')
  await chmod(path, 0o700)
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('codexapp release switch script', () => {
  it('rejects a damaged API component before inspecting or switching production', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codexapp-component-release-'))
    temporaryRoots.push(root)
    const release = join(root, 'release')
    await mkdir(join(release, 'dist-cli'), { recursive: true })
    await mkdir(join(release, 'api-proxy-component'))
    await writeFile(join(release, '.codexapp-release-ready'), 'fixture')
    await writeFile(join(release, 'dist-cli/index.js'), '// /codex-api/api-proxy')
    await writeExecutable(join(release, 'api-proxy-component/cli-proxy-api'), 'damaged fixture')
    await writeFile(join(release, 'api-proxy-component/LICENSE'), 'fixture')
    await writeFile(join(release, 'api-proxy-component/manifest.json'), JSON.stringify({ binarySha256: '0'.repeat(64) }))
    await expect(execFileAsync(switchScript, ['check', release], {
      env: { ...process.env, CODEXAPP_RELEASE_ROOT: root, CODEXAPP_SWITCH_STATE_ROOT: join(root, 'state') },
    })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('component checksum mismatch') })
  })
  it('activates and rolls back code without changing production auth state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codexapp-release-switch-'))
    temporaryRoots.push(root)
    const fakeBin = join(root, 'bin')
    const productionHome = join(root, 'production-home')
    const releaseRoot = join(root, 'releases')
    const release = join(releaseRoot, 'codexapp-test-release')
    const legacyRelease = join(releaseRoot, 'codexapp-legacy-release')
    const stateRoot = join(root, 'state')
    const dropinDir = join(root, 'dropin')
    const dropinFile = join(dropinDir, '90-release-switch.conf')
    const serviceState = join(root, 'service-state')
    await Promise.all([
      mkdir(fakeBin, { recursive: true }),
      mkdir(productionHome, { recursive: true, mode: 0o700 }),
      mkdir(join(release, 'dist-cli'), { recursive: true }),
      mkdir(join(legacyRelease, 'dist-cli'), { recursive: true }),
    ])
    await chmod(productionHome, 0o700)
    await writeFile(join(productionHome, 'auth.json'), '{"test":"credential-placeholder"}\n', { mode: 0o600 })
    await writeFile(join(productionHome, 'accounts.json'), '{"schemaVersion":2,"accounts":[]}\n', { mode: 0o600 })
    await writeFile(join(release, '.codexapp-release-ready'), 'version=test\n', { mode: 0o600 })
    await writeFile(join(release, 'dist-cli/index.js'), '#!/usr/bin/env node\n', { mode: 0o700 })
    await writeFile(join(release, 'package.json'), JSON.stringify({ version: '0.1.90' }))
    await writeFile(join(legacyRelease, 'dist-cli/index.js'), '#!/usr/bin/env node\n', { mode: 0o700 })
    await writeFile(join(legacyRelease, 'package.json'), JSON.stringify({ version: '0.1.89' }))
    await writeFile(serviceState, 'active\n', 'utf8')

    await writeExecutable(join(fakeBin, 'systemctl'), [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'command_name="${1:-}"',
      'case "$command_name" in',
      '  cat|daemon-reload) exit 0 ;;',
      '  is-active) test "$(cat "$FAKE_SERVICE_STATE")" = active ;;',
      '  stop) printf \'stopped\\n\' > "$FAKE_SERVICE_STATE" ;;',
      '  start)',
      '    printf \'active\\n\' > "$FAKE_SERVICE_STATE"',
      '    if [[ -n "${FAKE_MUTATE_AUTH_ON_NEW_START:-}" && -f "$CODEXAPP_DROPIN_FILE" && ! -f "$FAKE_MUTATION_MARKER" ]]; then',
      '      printf \'mutated\\n\' > "$FAKE_PRODUCTION_HOME/auth.json"',
      '      : > "$FAKE_MUTATION_MARKER"',
      '    fi',
      '    ;;',
      '  show)',
      '    joined="$*"',
      '    if [[ "$joined" == *"Environment"* ]]; then',
      '      printf \'NODE_ENV=production CODEX_HOME=%s\\n\' "$CODEXAPP_PRODUCTION_HOME"',
      '    elif [[ "$joined" == *"ExecStart"* && "$joined" == *"--value"* ]]; then',
      '      if [[ -f "$CODEXAPP_DROPIN_FILE" ]]; then',
      '        grep \'^ExecStart=\' "$CODEXAPP_DROPIN_FILE" | tail -1',
      '      else',
      '        printf \'ExecStart=%s\\n\' "$FAKE_BASE_EXEC"',
      '      fi',
      '    else',
      '      printf \'ActiveState=active\\nSubState=running\\nMainPID=123\\nExecStart=%s\\n\' "$FAKE_BASE_EXEC"',
      '    fi',
      '    ;;',
      '  *) printf \'unexpected systemctl command: %s\\n\' "$*" >&2; exit 2 ;;',
      'esac',
      '',
    ].join('\n'))
    await writeExecutable(join(fakeBin, 'docker'), '#!/usr/bin/env bash\nexit 1\n')
    await writeExecutable(join(fakeBin, 'lsof'), '#!/usr/bin/env bash\nexit 1\n')

    let schedulerAvailable = false
    let drainRequests = 0
    const server = createServer((request, response) => {
      if (request.url === '/codex-api/runtime/activity') { response.statusCode = 404; response.end('{}'); return }
      if (request.url === '/codex-api/automation-runtime/drain') drainRequests += 1
      if (!schedulerAvailable && request.url?.startsWith('/codex-api/automation-runtime')) {
        response.setHeader('Content-Type', 'text/html')
        response.end('<!doctype html><div id=app></div>')
        return
      }
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/codex-api/automation-runtime' || request.url === '/codex-api/automation-runtime/drain') response.end(JSON.stringify({ data: { ready: true, draining: true, activeCount: 0, queuedCount: 0 } }))
      else if (request.url === '/codex-api/thread-queue-state') response.end(JSON.stringify({ data: {} }))
      else if (request.url === '/codex-api/server-requests/pending') response.end(JSON.stringify({ data: [] }))
      else if (request.url === '/codex-api/meta/methods') response.end(JSON.stringify({ data: [] }))
      else if (request.url === '/codex-api/rpc') response.end(JSON.stringify({ result: { data: [], nextCursor: null } }))
      else response.end('{}')
    })
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test HTTP server did not bind.')

    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      CODEXAPP_RELEASE_ROOT: releaseRoot,
      CODEXAPP_SWITCH_STATE_ROOT: stateRoot,
      CODEXAPP_DROPIN_DIR: dropinDir,
      CODEXAPP_DROPIN_FILE: dropinFile,
      CODEXAPP_PRODUCTION_HOME: productionHome,
      CODEXAPP_PRODUCTION_URL: `http://127.0.0.1:${address.port}`,
      CODEXAPP_PRODUCTION_PORT: String(address.port),
      CODEXAPP_NODE_BIN: process.execPath,
      FAKE_SERVICE_STATE: serviceState,
      FAKE_BASE_EXEC: `${legacyRelease}/dist-cli/index.js`,
      FAKE_PRODUCTION_HOME: productionHome,
      FAKE_MUTATION_MARKER: join(root, 'mutation-fired'),
    }

    try {
      const checked = await execFileAsync(switchScript, ['check', release], { env })
      expect(checked.stdout).toContain('Release is ready')
      expect(drainRequests).toBe(0)
      expect(await readFile(serviceState, 'utf8')).toBe('active\n')
      // A broken new release must not bypass its scheduler just because it serves HTML.
      await writeFile(join(legacyRelease, 'package.json'), JSON.stringify({ version: '0.1.90' }))
      await expect(execFileAsync(switchScript, ['check', release], {
        env: { ...env, CODEXAPP_LEGACY_SCHEDULER: '1' },
      })).rejects.toMatchObject({ code: 1 })
      await writeFile(join(legacyRelease, 'package.json'), JSON.stringify({ version: '0.1.89' }))
      schedulerAvailable = true

      const originalAuth = await readFile(join(productionHome, 'auth.json'), 'utf8')
      const activated = await execFileAsync(switchScript, ['activate', release, '--confirm-idle'], { env })
      expect(activated.stdout).toContain('Cutover succeeded')
      expect(await readFile(dropinFile, 'utf8')).toContain(`${release}/dist-cli/index.js`)
      expect(await readFile(dropinFile, 'utf8')).toContain(`Environment=CODEXAPP_API_PROXY_BINARY=${release}/api-proxy-component/cli-proxy-api`)
      expect(await readFile(join(productionHome, 'auth.json'), 'utf8')).toBe(originalAuth)
      expect((await stat(join(stateRoot, 'current-transaction'))).isFile()).toBe(true)

      const rolledBack = await execFileAsync(switchScript, ['rollback', '--confirm-idle'], { env })
      expect(rolledBack.stdout).toContain('Rollback succeeded')
      await expect(stat(dropinFile)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(join(stateRoot, 'current-transaction'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(productionHome, 'auth.json'), 'utf8')).toBe(originalAuth)

      await expect(execFileAsync(switchScript, ['activate', release, '--confirm-idle'], {
        env: { ...env, FAKE_MUTATE_AUTH_ON_NEW_START: '1' },
      })).rejects.toMatchObject({ code: 1 })
      await expect(stat(dropinFile)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(serviceState, 'utf8')).toBe('active\n')
      expect(await readFile(join(productionHome, 'auth.json'), 'utf8')).toBe(originalAuth)
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()))
    }
  })
})
