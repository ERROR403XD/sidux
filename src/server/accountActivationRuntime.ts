import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { AccountAuthCoordinator } from './accountAuthCoordinator.js'
import type { ApiProxyGateway } from './apiProxy/gateway.js'
import { ProxyComponent } from './apiProxy/component.js'
import { AccountAppServerProbe } from './accountAppServerProbe.js'
import { normalizeRateLimitPayload } from './accountAuthStore.js'
import { AccountActivationScheduler } from './accountActivationScheduler.js'
const ACTIVATION_MODEL = 'gpt-5.6-luna'
export function createAccountActivationRuntime(coordinator: AccountAuthCoordinator, gateway: ApiProxyGateway) {
  const directory = join(coordinator.store.codexHome, 'account-activation')
  const busy = (id: string) => coordinator.blocksApiAccount(id) || coordinator.isAccountRefreshInProgress(id) || gateway.accountHasConnections(id) || coordinator.executions.snapshot().some(entry => entry.storageId === id && entry.busy && entry.kind !== 'activation')
  return new AccountActivationScheduler(directory, {
    model: ACTIVATION_MODEL,
    accountExists: async id => (await coordinator.store.readState()).accounts.some(row => row.storageId === id),
    busy,
    check: async id => {
      const state = await coordinator.store.readState()
      const account = state.accounts.find(row => row.storageId === id)
      const reason = !account ? '账号已移除' : state.activeStorageId === id ? '当前账号已连接' : busy(id) ? '账号有活动连接或操作' : !['ready', 'stale'].includes(account.authStatus) ? '账号认证状态不可用' : ''
      return { allowed: !reason, reason, stamp: JSON.stringify([state.operationEpoch, state.activeStorageId, account?.credentialRevision, gateway.accountActivityEpoch(id)]) }
    },
    quota: async (id, signal) => {
      const credential = await coordinator.getApiCredential(id, { allowRefresh: false })
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const home = await mkdtemp(join(directory, 'probe-'))
      const probe = new AccountAppServerProbe({ profileDir: home, expectedAccountId: credential.accountId,
        persistRefreshedCredential: async () => { throw new Error('激活不刷新凭据') },
        externalTokens: { accessToken: credential.accessToken, chatgptAccountId: credential.accountId },
      })
      const lease = coordinator.executions.register({ storageId: id, kind: 'activation', ownerId: 'quota-probe', disconnect: () => { void probe.dispose() } })
      let abortedCleanup: Promise<void> | undefined
      const abort = () => { abortedCleanup = probe.dispose(); void abortedCleanup.catch(() => {}) }
      signal.addEventListener('abort', abort, { once: true })
      try {
        if (signal.aborted) throw new Error('额度读取超时')
        const result = await probe.inspect()
        const snapshot = normalizeRateLimitPayload(result.rateLimits)
        return [snapshot?.primary, snapshot?.secondary].find(window => window?.windowMinutes === 300) || null
      } catch { throw new Error('无法读取目标 5h 额度，跳过本次') }
      finally {
        lease.release()
        signal.removeEventListener('abort', abort)
        await probe.dispose()
        await abortedCleanup
        await rm(home, { recursive: true, force: true })
      }
    },
    prepare: async (id, signal) => {
      const component = new ProxyComponent(directory, coordinator, { allowRefresh: false })
      const lease = coordinator.executions.register({ storageId: id, kind: 'activation', ownerId: 'scheduled-activation', disconnect: () => { void component.stop() } })
      try {
        if (signal.aborted) throw new Error('准备超时')
        lease.assertCurrent()
        const generation = await component.prepare(id)
        const response = await fetch(`${generation.url}/v1/models`, { headers: { Authorization: `Bearer ${generation.key}` }, signal })
        const models = await response.json() as { data?: Array<{ id: string }> }
        if (!response.ok || !models.data?.some(model => model.id === ACTIVATION_MODEL)) throw new Error('激活模型不可用')
        return {
          send: async (requestSignal: AbortSignal) => {
            try {
              const response = await fetch(`${generation.url}/v1/responses`, {
                method: 'POST', headers: { Authorization: `Bearer ${generation.key}`, 'Content-Type': 'application/json' }, signal: AbortSignal.any([requestSignal, lease.signal]),
                body: JSON.stringify({ model: ACTIVATION_MODEL, instructions: 'Reply briefly.', input: [{ role: 'user', content: [{ type: 'input_text', text: '请只回复 OK。' }] }], stream: false, store: false, service_tier: 'default', reasoning: { effort: 'low' } }),
              })
              const body = await response.json() as { status?: string; output?: unknown[] }
              if (!response.ok || body.status !== 'completed' || !body.output?.length) throw new Error()
            } catch { throw new Error('发送结果未确认，不自动重发') }
          },
          dispose: async () => { lease.release(); await component.stop() },
        }
      } catch {
        lease.release()
        await component.stop()
        throw new Error('独立连接未就绪或模型不可用，跳过本次')
      }
    },
  })
}
