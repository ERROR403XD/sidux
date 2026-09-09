import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ACCOUNT_STATE_SCHEMA_VERSION,
  AccountAuthStore,
  AccountStoreError,
  accountStorageId,
  parseAccountCredential,
} from './accountAuthStore.js'

const temporaryHomes: string[] = []

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

function credential(accountId: string, userId = 'user-1', refreshToken = 'refresh-1'): string {
  return JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      account_id: accountId,
      access_token: jwt({
        'https://api.openai.com/profile': { email: `${userId}@example.test` },
        'https://api.openai.com/auth': { user_id: userId, chatgpt_plan_type: 'plus' },
      }),
      refresh_token: refreshToken,
    },
  })
}

async function createStore(): Promise<AccountAuthStore> {
  const home = await mkdtemp(join(tmpdir(), 'codexapp-account-store-'))
  temporaryHomes.push(home)
  return new AccountAuthStore(home)
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(temporaryHomes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

describe('AccountAuthStore', () => {
  it('preserves all imported accounts, active identity and saved metadata when reopening the same home', async () => {
    const store = await createStore()
    for (const id of ['a', 'b', 'c']) await store.upsertCredential(credential(`account-${id}`, `user-${id}`))
    const state = await store.readState()
    state.activeStorageId = state.accounts[1]!.storageId
    state.operationEpoch = 9
    state.accounts[0]!.alias = '日常使用'
    state.accounts[0]!.authStatus = 'reauth_required'
    state.accounts[0]!.unavailableReason = 'reauth_required'
    state.accounts[2]!.credentialRevision = 7
    state.accounts[2]!.quotaStatus = 'ready'
    state.accounts[2]!.quotaSnapshot = {
      limitId: 'codex', limitName: 'Codex', primary: { usedPercent: 42, windowMinutes: 300, resetsAt: 2000000000 },
      secondary: null, credits: null, planType: 'plus',
    }
    await store.materializeActive(state.activeStorageId)
    await store.writeState(state)
    const paths = [store.statePath, store.activeAuthPath, ...state.accounts.map(account => store.credentialPath(account.storageId))]
    const before = await Promise.all(paths.map(path => readFile(path, 'utf8')))
    const reopened = new AccountAuthStore(store.codexHome)
    const loaded = await reopened.readState()
    expect(loaded.accounts).toEqual(state.accounts)
    expect(loaded.activeStorageId).toBe(state.activeStorageId)
    expect(loaded.operationEpoch).toBe(9)
    expect(await Promise.all(paths.map(path => readFile(path, 'utf8')))).toEqual(before)
  })

  it('preserves the local alias through credential rotation and reauthentication without changing identity', async () => {
    const store = await createStore()
    const { account } = await store.upsertCredential(credential('account-a'), { activate: true })
    await store.updateState(state => ({
      state: { ...state, accounts: state.accounts.map(entry => ({ ...entry, alias: '自动化专用' })) }, result: undefined,
    }))
    const refreshed = await store.upsertCredential(credential('account-a', 'user-1', 'rotated'), {
      expectedStorageId: account.storageId, expectedRevision: account.credentialRevision, materializeIfActive: true,
    })
    expect(refreshed.account).toMatchObject({ alias: '自动化专用', storageId: account.storageId, email: account.email, credentialRevision: account.credentialRevision + 1 })
    expect((await store.readActiveCredential())?.identity).not.toHaveProperty('alias')
    const relogged = await store.upsertCredential(credential('account-a', 'user-1', 'relogin'))
    expect(relogged.account.alias).toBe('自动化专用')
    expect((await new AccountAuthStore(store.codexHome).readState()).accounts[0]?.alias).toBe('自动化专用')
  })

  it('extracts a stable identity from account and user identity', () => {
    const first = parseAccountCredential(credential('workspace-a', 'user-a'))
    const again = parseAccountCredential(credential('workspace-a', 'user-a', 'rotated'))
    const otherUser = parseAccountCredential(credential('workspace-a', 'user-b'))
    expect(first.identity.storageId).toBe(again.identity.storageId)
    expect(first.identity.storageId).not.toBe(otherUser.identity.storageId)
    expect(first.identity.storageId).toBe(accountStorageId('workspace-a', 'user-a'))
  })

  it.each([
    ['broken JSON', '{', 'invalid_auth_json'],
    ['missing account id', JSON.stringify({ tokens: { access_token: 'x' } }), 'missing_account_id'],
    ['missing access token', JSON.stringify({ tokens: { account_id: 'a' } }), 'missing_access_token'],
  ])('rejects %s without echoing credential data', (_label, raw, code) => {
    try {
      parseAccountCredential(raw)
      throw new Error('expected failure')
    } catch (error) {
      expect(error).toBeInstanceOf(AccountStoreError)
      expect((error as AccountStoreError).code).toBe(code)
      expect((error as Error).message).not.toContain(raw)
    }
  })

  it('requires a refresh token when requested', () => {
    expect(() => parseAccountCredential(credential('a', 'u', ''), { requireRefreshToken: true }))
      .toThrowError(expect.objectContaining({ code: 'missing_refresh_token' }))
  })

  it('migrates legacy state metadata without changing the credential body', async () => {
    const store = await createStore()
    const raw = credential('account-a')
    const parsed = parseAccountCredential(raw)
    await store.writeCredential(parsed.identity.storageId, raw)
    await writeFile(store.statePath, JSON.stringify({
      activeAccountId: 'account-a',
      activeStorageId: parsed.identity.storageId,
      accounts: [{
        accountId: 'account-a',
        storageId: parsed.identity.storageId,
        lastRefreshedAtIso: '2026-01-01T00:00:00.000Z',
      }],
    }))

    const state = await store.readState()
    expect(state.schemaVersion).toBe(ACCOUNT_STATE_SCHEMA_VERSION)
    expect(state.accounts[0]?.credentialRevision).toBe(1)
    expect(await readFile(store.credentialPath(parsed.identity.storageId), 'utf8')).toBe(raw)
  })

  it('migrates an account-id-only snapshot directory to the stable identity path', async () => {
    const store = await createStore()
    const raw = credential('account-a', 'user-a')
    const legacyStorageId = accountStorageId('account-a', null)
    const stableStorageId = accountStorageId('account-a', 'user-a')
    await mkdir(join(store.accountsRoot, legacyStorageId), { recursive: true })
    await writeFile(store.credentialPath(legacyStorageId), raw)
    await writeFile(store.statePath, JSON.stringify({
      activeAccountId: 'account-a',
      activeStorageId: legacyStorageId,
      accounts: [{ accountId: 'account-a', storageId: legacyStorageId, lastRefreshedAtIso: '2026-01-01T00:00:00.000Z' }],
    }))
    await writeFile(store.activeAuthPath, raw)

    const state = await store.readState()
    expect(state.activeStorageId).toBe(stableStorageId)
    expect(await readFile(store.credentialPath(stableStorageId), 'utf8')).toBe(raw)
    await expect(stat(join(store.accountsRoot, legacyStorageId))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses 0700 account directories and 0600 atomic credential files', async () => {
    const store = await createStore()
    const raw = credential('account-a')
    const parsed = parseAccountCredential(raw)
    await store.writeCredential(parsed.identity.storageId, raw)
    expect((await stat(store.accountsRoot)).mode & 0o777).toBe(0o700)
    expect((await stat(join(store.accountsRoot, parsed.identity.storageId))).mode & 0o777).toBe(0o700)
    expect((await stat(store.credentialPath(parsed.identity.storageId))).mode & 0o777).toBe(0o600)
  })

  it('deduplicates re-auth and rejects stale revision or mismatched target identity', async () => {
    const store = await createStore()
    const added = await store.upsertCredential(credential('account-a', 'user-a'))
    const refreshed = await store.upsertCredential(credential('account-a', 'user-a', 'refresh-2'), {
      expectedStorageId: added.account.storageId,
      expectedRevision: 1,
    })
    expect(added.outcome).toBe('added')
    expect(refreshed.outcome).toBe('reauthenticated')
    expect(refreshed.state.accounts).toHaveLength(1)
    expect(refreshed.account.credentialRevision).toBe(2)

    await expect(store.upsertCredential(credential('account-a', 'user-a', 'refresh-3'), {
      expectedRevision: 1,
    })).rejects.toMatchObject({ code: 'credential_revision_conflict' })
    await expect(store.upsertCredential(credential('account-b', 'user-b'), {
      expectedStorageId: added.account.storageId,
    })).rejects.toMatchObject({ code: 'account_identity_mismatch' })
  })

  it('refuses to write a credential into another storage id', async () => {
    const store = await createStore()
    await expect(store.writeCredential('wrong-id', credential('account-a')))
      .rejects.toMatchObject({ code: 'storage_id_conflict' })
  })
})
