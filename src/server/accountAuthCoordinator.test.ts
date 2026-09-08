import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccountAppServerProbe, type AccountProbeInspection } from './accountAppServerProbe.js'
import { AccountAuthCoordinator, type AccountRuntime } from './accountAuthCoordinator.js'
import { AccountAuthStore } from './accountAuthStore.js'

const homes: string[] = []

function jwt(accountId: string, userId: string): string {
  return `header.${Buffer.from(JSON.stringify({
    'https://api.openai.com/profile': { email: `${userId}@example.test` },
    'https://api.openai.com/auth': {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: 'plus',
      user_id: userId,
    },
  })).toString('base64url')}.signature`
}

function credential(accountId: string, userId: string, refreshToken = `refresh-${accountId}`): string {
  return JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { account_id: accountId, access_token: jwt(accountId, userId), refresh_token: refreshToken },
  })
}

async function store(): Promise<AccountAuthStore> {
  const home = await mkdtemp(join(tmpdir(), 'codexapp-coordinator-'))
  homes.push(home)
  return new AccountAuthStore(home)
}

function inspection(email = 'probe@example.test'): AccountProbeInspection {
  return {
    accountId: null,
    email,
    planType: 'plus',
    rateLimits: { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1 } } },
  }
}

function probeFactory(result: AccountProbeInspection = inspection()) {
  return () => ({ inspect: vi.fn(async () => result), dispose: vi.fn() }) as unknown as AccountAppServerProbe
}

function loginSpawn(onHome: (home: string) => void) {
  return vi.fn((command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
    onHome(options.env?.CODEX_HOME ?? '')
    const proc = new EventEmitter() as EventEmitter & {
      stdin: PassThrough
      stdout: PassThrough
      stderr: PassThrough
      kill: () => boolean
    }
    proc.stdin = new PassThrough()
    proc.stdout = new PassThrough()
    proc.stderr = new PassThrough()
    proc.kill = () => { proc.emit('exit', 0); return true }
    queueMicrotask(() => proc.stdout.write('Open https://auth.openai.com/oauth/authorize?test=1\n'))
    expect(command.length).toBeGreaterThan(0)
    expect(args).toContain('cli_auth_credentials_store="file"')
    return proc
  })
}

function runtime(options: { idle?: boolean; failAfterDispose?: boolean } = {}): AccountRuntime & { disposeCount: number } {
  let disposed = false
  return {
    disposeCount: 0,
    listPendingServerRequests: () => [],
    getRuntimeQuiescenceSnapshot: async () => ({
      idle: options.idle ?? true,
      activeTurnThreadIds: options.idle === false ? ['thread-a'] : [],
      queuedThreadIds: [],
      pendingServerRequestCount: 0,
      pendingTurnMutationCount: 0,
    }),
    dispose() { this.disposeCount += 1; disposed = true },
    async rpc(method: string) {
      if (method === 'account/read') {
        if (disposed && options.failAfterDispose) {
          options.failAfterDispose = false
          throw new Error('injected_app_server_start_failure')
        }
        return { account: { email: 'runtime@example.test', planType: 'plus' } }
      }
      if (method === 'thread/read') {
        return { thread: { id: 'thread-a', cwd: '/projects/a', rolloutPath: '/rollouts/a.jsonl', turns: [{ items: [{ id: 'message-a' }] }] } }
      }
      if (method === 'thread/resume') return { thread: { id: 'thread-a' } }
      throw new Error(`unexpected method ${method}`)
    },
  }
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

describe('AccountAuthCoordinator', () => {
  it('consumes the selected reset credit and retains account protection across refresh', async () => {
    const authStore = await store()
    const saved = await authStore.upsertCredential(credential('account-a', 'user-a'), { activate: true })
    await authStore.updateState(state => ({ state: { ...state, accounts: state.accounts.map(account => ({ ...account, protectionPercent: 1 })) }, result: undefined }))
    const inspect = vi.fn(async () => ({ ...inspection(), resetOutcome: 'reset', rateLimits: { rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300 } }, rateLimitResetCredits: { availableCount: 2, credits: null } } }))
    const createProbe = vi.fn((_options: { expectedAccountId: string }) => ({ inspect, dispose: vi.fn() }) as unknown as AccountAppServerProbe)
    const coordinator = new AccountAuthCoordinator(authStore, { createProbe })
    expect(await coordinator.consumeResetCredit(saved.account.storageId, 'credit-a', 'attempt-a')).toBe('reset')
    expect(inspect).toHaveBeenCalledExactlyOnceWith({ creditId: 'credit-a', idempotencyKey: 'attempt-a' })
    expect(createProbe.mock.calls[0]?.[0]).toMatchObject({ expectedAccountId: 'account-a' })
    const account = (await authStore.readState()).accounts[0]
    expect(account?.resetCredits?.availableCount).toBe(2)
    expect(account?.protectionPercent).toBe(1)
    await authStore.upsertCredential(credential('account-a', 'user-a', 'rotated'))
    expect((await authStore.readState()).accounts[0]?.protectionPercent).toBe(1)
  })

  it('refreshes the plan from live quota instead of an older account token', async () => {
    const authStore = await store()
    const saved = await authStore.upsertCredential(credential('account-a', 'user-a'), { activate: true })
    const current = inspection()
    current.rateLimits = { rateLimits: { planType: 'pro', primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1 } } }
    const coordinator = new AccountAuthCoordinator(authStore, { createProbe: probeFactory(current) })
    const updated = await coordinator.refreshAccount(saved.account.storageId)
    expect(updated.planType).toBe('pro')
    expect(updated.quotaSnapshot?.planType).toBe('pro')
    expect((await authStore.readState()).accounts[0]?.planType).toBe('pro')
    current.rateLimits = { rateLimits: { planType: 'free', primary: { usedPercent: 0, windowDurationMins: 300 } } }
    expect((await coordinator.refreshAccount(saved.account.storageId)).planType).toBe('free')
  })

  it('switches A to B transactionally and verifies thread continuity', async () => {
    const authStore = await store()
    const a = await authStore.upsertCredential(credential('account-a', 'user-a'), { activate: true })
    const b = await authStore.upsertCredential(credential('account-b', 'user-b'))
    const coordinator = new AccountAuthCoordinator(authStore, { createProbe: probeFactory() })
    const appServer = runtime()
    const result = await coordinator.switchAccount({
      storageId: b.account.storageId,
      expectedActiveStorageId: a.account.storageId,
      resumeThreadId: 'thread-a',
    }, appServer)
    expect(result.activeStorageId).toBe(b.account.storageId)
    expect(result.workspaceContinuity).toEqual({ checked: true, restored: true, threadId: 'thread-a' })
    expect((await authStore.readState()).activeStorageId).toBe(b.account.storageId)
    expect((await authStore.readActiveCredential())?.identity.storageId).toBe(b.account.storageId)
  })

  it('round-trips A to B to A without losing the selected thread', async () => {
    const authStore = await store()
    const a = await authStore.upsertCredential(credential('account-a', 'user-a'), { activate: true })
    const b = await authStore.upsertCredential(credential('account-b', 'user-b'))
    const coordinator = new AccountAuthCoordinator(authStore, { createProbe: probeFactory() })
    const appServer = runtime()

    await coordinator.switchAccount({
      storageId: b.account.storageId,
      expectedActiveStorageId: a.account.storageId,
      resumeThreadId: 'thread-a',
    }, appServer)
    const backToA = await coordinator.switchAccount({
      storageId: a.account.storageId,
      expectedActiveStorageId: b.account.storageId,
      resumeThreadId: 'thread-a',
    }, appServer)

    expect(backToA.workspaceContinuity).toEqual({ checked: true, restored: true, threadId: 'thread-a' })
    expect((await authStore.readState()).activeStorageId).toBe(a.account.storageId)
    expect((await authStore.readActiveCredential())?.identity.storageId).toBe(a.account.storageId)
  })

  it('rejects busy runtime and optimistic concurrency conflicts before materialization', async () => {
    const authStore = await store()
    const a = await authStore.upsertCredential(credential('account-a', 'user-a'), { activate: true })
    const b = await authStore.upsertCredential(credential('account-b', 'user-b'))
    const coordinator = new AccountAuthCoordinator(authStore, { createProbe: probeFactory() })
    await expect(coordinator.switchAccount({
      storageId: b.account.storageId,
      expectedActiveStorageId: 'stale-active-id',
    }, runtime())).rejects.toMatchObject({ code: 'active_account_conflict' })
    await expect(coordinator.switchAccount({
      storageId: b.account.storageId,
      expectedActiveStorageId: a.account.storageId,
    }, runtime({ idle: false }))).rejects.toMatchObject({ code: 'account_switch_blocked' })
    expect((await authStore.readActiveCredential())?.identity.storageId).toBe(a.account.storageId)
  })

  it('restores the previous account after a post-materialization failure', async () => {
    const authStore = await store()
    const a = await authStore.upsertCredential(credential('account-a', 'user-a'), { activate: true })
    const b = await authStore.upsertCredential(credential('account-b', 'user-b'))
    const coordinator = new AccountAuthCoordinator(authStore, { createProbe: probeFactory() })
    await expect(coordinator.switchAccount({
      storageId: b.account.storageId,
      expectedActiveStorageId: a.account.storageId,
    }, runtime({ failAfterDispose: true }))).rejects.toMatchObject({
      code: 'account_switch_failed_rolled_back',
      details: { rollbackSucceeded: true },
    })
    expect((await authStore.readState()).activeStorageId).toBe(a.account.storageId)
    expect((await authStore.readActiveCredential())?.identity.storageId).toBe(a.account.storageId)
  })

  it('persists active refresh-token rotation to the profile and materialized auth', async () => {
    const authStore = await store()
    const a = await authStore.upsertCredential(credential('account-a', 'user-a'), { activate: true })
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      access_token: jwt('account-a', 'user-a'),
      refresh_token: 'refresh-rotated',
    }), { status: 200 }))
    const coordinator = new AccountAuthCoordinator(authStore, { fetchImpl })
    await coordinator.refreshActiveTokens({ previousAccountId: 'account-a' })
    const profile = await authStore.readCredential(a.account.storageId)
    const active = await authStore.readActiveCredential()
    expect(profile.auth.tokens?.refresh_token).toBe('refresh-rotated')
    expect(active?.auth.tokens?.refresh_token).toBe('refresh-rotated')
    expect((await authStore.readState()).accounts[0]?.credentialRevision).toBe(2)
  })

  it('runs login in a pending home and adds a new identity without activating it', async () => {
    const authStore = await store()
    const active = await authStore.upsertCredential(credential('account-a', 'user-a'), { activate: true })
    let pendingHome = ''
    const fakeSpawn = loginSpawn((home) => { pendingHome = home })
    const coordinator = new AccountAuthCoordinator(authStore, {
      spawnImpl: fakeSpawn as unknown as typeof import('node:child_process').spawn,
      fetchImpl: async () => {
        await writeFile(join(pendingHome, 'auth.json'), credential('account-b', 'user-b'))
        return new Response('', { status: 302 })
      },
      createProbe: probeFactory(inspection('user-b@example.test')),
    })
    const started = await coordinator.startLogin({ intent: 'add' })
    expect(pendingHome).not.toBe(authStore.codexHome)
    expect(pendingHome.startsWith(join(authStore.accountsRoot, '.pending'))).toBe(true)
    const result = await coordinator.completeLogin({
      loginSessionId: started.loginSessionId,
      callbackUrl: 'http://localhost:1455/auth/callback?code=secret',
    })
    expect(result.outcome).toBe('added')
    expect(result.poolSize).toBe(2)
    expect(result.activeStorageId).toBe(active.account.storageId)
    expect(result.account.isActive).toBe(false)
  })

  it('completes device authorization once from an isolated credential file and preserves active identity', async () => {
    const authStore = await store()
    const active = await authStore.upsertCredential(credential('account-a', 'user-a'), { activate: true })
    let pendingHome = ''
    let proc: ReturnType<ReturnType<typeof loginSpawn>>
    const baseSpawn = loginSpawn(home => { pendingHome = home })
    const fakeSpawn = vi.fn((command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      expect(args).toContain('--device-auth')
      proc = baseSpawn(command, args, options)
      queueMicrotask(() => proc.stdout.write('\u001b[1mhttps://auth.openai.com/codex/device\u001b[0m\nABCD-EFGHJ\n'))
      return proc
    })
    const coordinator = new AccountAuthCoordinator(authStore, { spawnImpl: fakeSpawn as unknown as typeof import('node:child_process').spawn, createProbe: probeFactory(inspection('user-b@example.test')) })
    const started = await coordinator.startLogin({ intent: 'add', method: 'device' })
    expect(started).toMatchObject({ method: 'device', userCode: 'ABCD-EFGHJ', loginUrl: 'https://auth.openai.com/codex/device' })
    expect((await coordinator.getLoginStatus())?.status).toBe('waiting')
    await writeFile(join(pendingHome, 'auth.json'), credential('account-b', 'user-b'))
    proc!.emit('exit', 0)
    await expect.poll(() => coordinator.isAccountOperationInProgress()).toBe(false)
    expect((await authStore.readState()).accounts).toHaveLength(2)
    await expect.poll(async () => (await coordinator.getLoginStatus())?.status).toBe('completed')
    const result = (await coordinator.getLoginStatus())!.result!
    expect(result.activeStorageId).toBe(active.account.storageId)
    expect(result.poolSize).toBe(2)
    expect((await coordinator.getLoginStatus())?.userCode).toBeNull()
    expect(coordinator.isAccountOperationInProgress()).toBe(false)
  })

  it('cancels a device session before allowing another login and rejects stale completion', async () => {
    const authStore = await store()
    const baseSpawn = loginSpawn(() => undefined)
    const fakeSpawn = (command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      const proc = baseSpawn(command, args, options)
      queueMicrotask(() => proc.stdout.write('https://auth.openai.com/codex/device\nABCD-EFGH\n'))
      return proc
    }
    const coordinator = new AccountAuthCoordinator(authStore, { spawnImpl: fakeSpawn as unknown as typeof import('node:child_process').spawn })
    const first = await coordinator.startLogin({ intent: 'add', method: 'device' })
    await coordinator.cancelLogin(first.loginSessionId)
    const next = await coordinator.startLogin({ intent: 'add' })
    await expect(coordinator.completeLogin({ loginSessionId: first.loginSessionId, callbackUrl: '' })).rejects.toMatchObject({ code: 'login_not_running' })
    expect(next.loginSessionId).not.toBe(first.loginSessionId)
    await coordinator.cancelLogin(next.loginSessionId)
  })

  it('cleans up a rejected device authorization and a synchronous spawn failure', async () => {
    const authStore = await store()
    let proc: ReturnType<ReturnType<typeof loginSpawn>>
    const baseSpawn = loginSpawn(() => undefined)
    const fakeSpawn = vi.fn((command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      proc = baseSpawn(command, args, options)
      queueMicrotask(() => proc.stdout.write('https://auth.openai.com/codex/device\nABCD-EFGH\n'))
      return proc
    })
    const coordinator = new AccountAuthCoordinator(authStore, { spawnImpl: fakeSpawn as unknown as typeof import('node:child_process').spawn })
    fakeSpawn.mockImplementationOnce(() => { throw new Error('fixture spawn failed') })
    await expect(coordinator.startLogin({ intent: 'add', method: 'device' })).rejects.toThrow('fixture spawn failed')
    expect(coordinator.isAccountOperationInProgress()).toBe(false)
    await coordinator.startLogin({ intent: 'add', method: 'device' })
    proc!.emit('exit', 1)
    await expect.poll(() => coordinator.isAccountOperationInProgress()).toBe(false)
    expect(await coordinator.getLoginStatus()).toMatchObject({ status: 'failed', userCode: null, loginUrl: null })
    expect((await authStore.readState()).accounts).toHaveLength(0)
    const next = await coordinator.startLogin({ intent: 'add' })
    await coordinator.cancelLogin(next.loginSessionId)
  })

  it('re-authenticates an existing identity in place without duplicating the pool', async () => {
    const authStore = await store()
    const active = await authStore.upsertCredential(credential('account-a', 'user-a'), { activate: true })
    let pendingHome = ''
    const appServer = runtime()
    const coordinator = new AccountAuthCoordinator(authStore, {
      spawnImpl: loginSpawn((home) => { pendingHome = home }) as unknown as typeof import('node:child_process').spawn,
      fetchImpl: async () => {
        await writeFile(join(pendingHome, 'auth.json'), credential('account-a', 'user-a', 'refresh-new'))
        return new Response('', { status: 302 })
      },
      createProbe: probeFactory(inspection('user-a@example.test')),
    })

    const started = await coordinator.startLogin({ intent: 'add' })
    const result = await coordinator.completeLogin({
      loginSessionId: started.loginSessionId,
      callbackUrl: 'http://localhost:1455/auth/callback?code=secret',
    }, appServer)

    expect(result.outcome).toBe('reauthenticated')
    expect(result.poolSize).toBe(1)
    expect(result.activeStorageId).toBe(active.account.storageId)
    expect((await authStore.readCredential(active.account.storageId)).auth.tokens?.refresh_token).toBe('refresh-new')
    expect(appServer.disposeCount).toBe(1)
  })

  it('rejects a targeted re-auth identity mismatch without writing either account', async () => {
    const authStore = await store()
    const a = await authStore.upsertCredential(credential('account-a', 'user-a'), { activate: true })
    const b = await authStore.upsertCredential(credential('account-b', 'user-b'))
    const beforeRevision = b.account.credentialRevision
    let pendingHome = ''
    const coordinator = new AccountAuthCoordinator(authStore, {
      spawnImpl: loginSpawn((home) => { pendingHome = home }) as unknown as typeof import('node:child_process').spawn,
      fetchImpl: async () => {
        await writeFile(join(pendingHome, 'auth.json'), credential('account-a', 'user-a', 'wrong-target'))
        return new Response('', { status: 302 })
      },
      createProbe: probeFactory(),
    })

    const started = await coordinator.startLogin({ intent: 'reauth', targetStorageId: b.account.storageId })
    await expect(coordinator.completeLogin({
      loginSessionId: started.loginSessionId,
      callbackUrl: 'http://localhost:1455/auth/callback?code=secret',
    })).rejects.toMatchObject({ code: 'account_identity_mismatch' })

    const state = await authStore.readState()
    expect(state.accounts).toHaveLength(2)
    expect(state.activeStorageId).toBe(a.account.storageId)
    expect(state.accounts.find((entry) => entry.storageId === b.account.storageId)?.credentialRevision).toBe(beforeRevision)
    expect((await authStore.readCredential(b.account.storageId)).auth.tokens?.refresh_token).toBe('refresh-account-b')
  })
})

describe('API outlet credential ownership', () => {
  function accessToken(accountId: string, userId: string, expires: number): string {
    const parts = jwt(accountId, userId).split('.')
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return `header.${Buffer.from(JSON.stringify({ ...payload, exp: expires })).toString('base64url')}.signature`
  }
  function expiredCredential(accountId: string, userId: string): string {
    const value = JSON.parse(credential(accountId, userId))
    value.tokens.access_token = accessToken(accountId, userId, Math.floor(Date.now() / 1000) - 10)
    return JSON.stringify(value)
  }
  it('coalesces API and active-runtime refresh and materializes the new active credential', async () => {
    const accounts = await store()
    const saved = await accounts.upsertCredential(expiredCredential('a', 'user-a'), { activate: true })
    const token = accessToken('a', 'user-a', Math.floor(Date.now() / 1000) + 3600)
    const fetchImpl = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
      return new Response(JSON.stringify({ access_token: token, refresh_token: 'rotated-once' }), { status: 200 })
    })
    const coordinator = new AccountAuthCoordinator(accounts, { fetchImpl: fetchImpl as typeof fetch })
    const results = await Promise.all([
      coordinator.getApiCredential(null),
      coordinator.getApiCredential(null),
      coordinator.refreshActiveTokens({ previousAccountId: 'a' }),
    ])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(results[0].accessToken).toBe(token)
    expect(results[1].accessToken).toBe(token)
    expect(JSON.stringify(results)).not.toContain('rotated-once')
    const active = await accounts.readActiveCredential()
    expect(active?.auth.tokens?.refresh_token).toBe('rotated-once')
    expect((await accounts.readState()).activeStorageId).toBe(saved.account.storageId)
  })
  it('refreshes a fixed API account without changing WebUI active credentials', async () => {
    const accounts = await store()
    const active = await accounts.upsertCredential(credential('a', 'user-a'), { activate: true })
    const fixed = await accounts.upsertCredential(expiredCredential('b', 'user-b'))
    const token = accessToken('b', 'user-b', Math.floor(Date.now() / 1000) + 3600)
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: token, refresh_token: 'fixed-rotated' }), { status: 200 }))
    const coordinator = new AccountAuthCoordinator(accounts, { fetchImpl: fetchImpl as typeof fetch })
    const projection = await coordinator.getApiCredential(fixed.account.storageId)
    expect(projection.accountId).toBe('b')
    expect((await accounts.readState()).activeStorageId).toBe(active.account.storageId)
    expect((await accounts.readActiveCredential())?.identity.accountId).toBe('a')
    expect((await accounts.readCredential(fixed.account.storageId)).auth.tokens?.refresh_token).toBe('fixed-rotated')
  })
})

it('skips activation credentials needing refresh without taking the global account lock', async () => {
  const accounts = await store()
  const saved = await accounts.upsertCredential(credential('background', 'user'), { activate: false })
  const fetchImpl = vi.fn(async () => { throw new Error('must not refresh') })
  const coordinator = new AccountAuthCoordinator(accounts, { fetchImpl })
  await expect(coordinator.getApiCredential(saved.account.storageId, { allowRefresh: false })).rejects.toMatchObject({ code: 'background_refresh_skipped' })
  expect(fetchImpl).not.toHaveBeenCalled()
  expect(coordinator.isAccountOperationInProgress()).toBe(false)
  expect((await accounts.readState()).accounts[0].credentialRevision).toBe(saved.account.credentialRevision)
})
