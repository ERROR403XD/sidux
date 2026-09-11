import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { AccountAuthCoordinator } from './accountAuthCoordinator.js'
import { checkActivationAccount, isActivationAccountBusy } from './accountActivationAdmission.js'
import type { ApiProxyGateway } from './apiProxy/gateway.js'
import { AccountActivationScheduler } from './accountActivationScheduler.js'
import { AccountActivationSession } from './accountActivationSession.js'

const ACTIVATION_MODEL = 'gpt-5.6-luna'
export function createAccountActivationRuntime(coordinator: AccountAuthCoordinator, _gateway: ApiProxyGateway) {
  const directory = join(coordinator.store.codexHome, 'account-activation')
  const sessions = join(directory, 'sessions')
  const busy = (id: string) => isActivationAccountBusy(coordinator, id)
  return new AccountActivationScheduler(directory, {
    model: ACTIVATION_MODEL,
    initialize: async () => {
      await mkdir(sessions, { recursive: true, mode: 0o700 })
      for (const name of await readdir(sessions)) {
        if (/^session-[a-zA-Z0-9]+$/.test(name)) await rm(join(sessions, name), { recursive: true, force: true })
      }
    },
    accountExists: async id => (await coordinator.store.readState()).accounts.some(row => row.storageId === id),
    busy,
    check: (id, phase) => checkActivationAccount(coordinator, id, phase === 'before'),
    prepare: async (id, signal) => {
      const credential = await coordinator.getApiCredential(id, { allowRefresh: false })
      const session = new AccountActivationSession(sessions, credential, { model: ACTIVATION_MODEL, signal })
      const lease = coordinator.executions.register({ storageId: id, kind: 'activation', ownerId: 'scheduled-activation', disconnect: () => { void session.dispose() } })
      try {
        lease.assertCurrent()
        await session.prepare()
        return {
          send: async (requestSignal: AbortSignal) => {
            lease.assertCurrent()
            await session.send(AbortSignal.any([requestSignal, lease.signal]))
          },
          dispose: async () => {
            try { await session.dispose() } finally { lease.release() }
          },
        }
      } catch {
        try { await session.dispose() } finally { lease.release() }
        throw new Error('激活连接未就绪')
      }
    },
  })
}
