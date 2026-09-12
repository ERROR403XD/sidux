import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const exec = promisify(execFile)

describe('candidate replacement', () => {
  it.each(['build', 'busy', 'background', 'invalid', 'activation', 'freeze-response-lost', 'start', 'success'])('preserves service boundaries for %s', async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), 'codexapp-deploy-test-'))
    const bin = join(root, 'bin')
    const scripts = join(root, 'scripts')
    const log = join(root, 'calls')
    let activationFrozen = false
    const server = createServer((request, response) => {
      if (request.url === '/codex-api/api-proxy/activation/activity') {
        response.end(JSON.stringify({ data: { ready: true, draining: activationFrozen, activeCount: scenario === 'activation' ? 1 : 0 } }))
        return
      }
      if (request.url === '/codex-api/api-proxy/activation/drain') {
        let raw = ''
        request.on('data', chunk => { raw += chunk })
        request.on('end', () => {
          activationFrozen = JSON.parse(raw).draining
          // The write took effect even though the caller did not receive success.
          if (scenario === 'freeze-response-lost' && activationFrozen) response.statusCode = 503
          response.end(JSON.stringify({ data: { ready: true, draining: activationFrozen, activeCount: 0 } }))
        })
        return
      }
      if (request.url === '/codex-api/runtime/activity') { response.statusCode = 404; response.end('{}'); return }
      response.setHeader('Content-Type', 'application/json')
      if (request.url?.startsWith('/codex-api/automation-runtime')) {
        response.end(JSON.stringify({ data: { ready: true, draining: true, activeCount: 0, queuedCount: 0 } }))
      } else if (request.url?.startsWith('/codex-api/api-proxy/')) {
        response.end(JSON.stringify({ data: { settings: { enabled: false }, activity: { connections: 0, activeRequests: 0 } } }))
      } else if (request.url === '/codex-api/thread-queue-state') {
        response.end(JSON.stringify({ data: scenario === 'invalid' ? null : {} }))
      } else if (request.url === '/codex-api/server-requests/pending') {
        response.end(JSON.stringify({ data: [] }))
      } else if (request.url === '/codex-api/meta/methods') {
        response.end(JSON.stringify({ data: scenario === 'background' ? ['thread/loaded/list', 'thread/backgroundTerminals/list'] : [] }))
      } else if (request.url === '/codex-api/rpc' && scenario === 'background') {
        let raw = ''
        request.on('data', chunk => { raw += chunk })
        request.on('end', () => {
          const { method } = JSON.parse(raw)
          const data = method === 'thread/loaded/list' ? ['fixture'] : method === 'thread/backgroundTerminals/list' ? [{ processId: '17' }] : []
          response.end(JSON.stringify({ result: { data, nextCursor: null } }))
        })
      } else if (request.url === '/codex-api/rpc') {
        response.end(JSON.stringify({ result: { data: scenario === 'busy' ? [{ id: 'fixture', status: { type: 'active' } }] : [], nextCursor: null } }))
      } else response.end('{}')
    })
    try {
      await mkdir(bin)
      await mkdir(scripts)
      await writeFile(join(root, 'package.json'), JSON.stringify({ version: 'fixture' }))
      await writeFile(log, '')
      await writeFile(join(scripts, 'install-api-proxy.cjs'), '// fixture component installation\n')
      for (const name of ['run-multi-account-dev.sh', 'check-codexapp-idle.cjs']) await copyFile(resolve('scripts', name), join(scripts, name))
      const stubs = {
        docker: '#!/bin/bash\nprintf "docker %s\\n" "$*" >> "$DEPLOY_TEST_LOG"\nif [[ "$1" == run && "$DEPLOY_TEST_SCENARIO" == start ]]; then exit 42; fi\nexit 0\n',
        pnpm: '#!/bin/bash\nprintf "pnpm %s\\n" "$*" >> "$DEPLOY_TEST_LOG"\nif [[ "$*" == *"run build"* && "$DEPLOY_TEST_SCENARIO" == build ]]; then exit 42; fi\nif [[ "$*" == *"pack --pack-destination"* ]]; then touch "${!#}/codexapp-fixture.tgz"; fi\n',
        lsof: '#!/bin/bash\nexit 1\n',
      }
      for (const [name, body] of Object.entries(stubs)) {
        await writeFile(join(bin, name), body)
        await chmod(join(bin, name), 0o700)
      }
      await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No test server')
      const result = await exec('/bin/bash', [join(scripts, 'run-multi-account-dev.sh')], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEXAPP_REPLACE_DEV: '1', CODEXAPP_MULTI_ACCOUNT_CONTAINER: 'fixture-only', CODEXAPP_MULTI_ACCOUNT_PORT: String(address.port), DEPLOY_TEST_LOG: log, DEPLOY_TEST_SCENARIO: scenario },
      }).then(() => 0, error => error.code)
      const calls = await readFile(log, 'utf8')
      if (['build', 'busy', 'background', 'invalid', 'activation', 'freeze-response-lost'].includes(scenario)) {
        expect(result).not.toBe(0)
        expect(calls).not.toContain('docker stop')
        expect(calls).not.toContain('docker rm')
        expect(activationFrozen).toBe(false)
      } else {
        expect(calls.indexOf('docker build')).toBeLessThan(calls.indexOf('docker stop'))
        if (scenario === 'start') {
          expect(result).toBe(42)
          expect(calls).toContain('docker start fixture-only')
          expect(calls.match(/docker rename/g)).toHaveLength(2)
        } else {
          expect(result).toBe(0)
          expect(calls).toContain('docker rm fixture-only-previous-')
          expect(calls).not.toContain('docker start')
        }
      }
    } finally {
      await new Promise<void>(done => server.close(() => done()))
      await rm(root, { recursive: true, force: true })
    }
  })
})
