import { join } from 'node:path'
import type { AccountAuthCoordinator } from './accountAuthCoordinator.js'
import { checkActivationAccount, isActivationAccountBusy } from './accountActivationAdmission.js'
import type { ApiProxyGateway } from './apiProxy/gateway.js'
import { AccountActivationScheduler } from './accountActivationScheduler.js'
import { sendActivationRequest } from './accountActivationRequest.js'

const ACTIVATION_MODEL = 'gpt-5.6-luna'
export function createAccountActivationRuntime(coordinator: AccountAuthCoordinator, gateway: ApiProxyGateway) {
  const busy = (id: string) => isActivationAccountBusy(coordinator, id)
  return new AccountActivationScheduler(join(coordinator.store.codexHome, 'account-activation'), {
    model: ACTIVATION_MODEL,
    accountExists: async id => (await coordinator.store.readState()).accounts.some(row => row.storageId === id),
    busy,
    check: (id, phase) => checkActivationAccount(coordinator, id, phase === 'before'),
    prepare: async (id, signal) => {
      const abort = new AbortController()
      const lease = coordinator.executions.register({ storageId: id, kind: 'activation', ownerId: 'scheduled-activation', disconnect: () => abort.abort() })
      const requestSignal = AbortSignal.any([signal, lease.signal, abort.signal])
      let transport: Awaited<ReturnType<ApiProxyGateway['prepareActivation']>> | undefined
      const dispose = async () => {
        abort.abort()
        transport?.release()
        lease.release()
      }
      try {
        transport = await gateway.prepareActivation(id, requestSignal)
        requestSignal.throwIfAborted()
        lease.assertCurrent()
        const fixed = transport
        return {
          send: async (sendSignal: AbortSignal) => {
            const current = (await coordinator.store.readState()).accounts.find(row => row.storageId === id)
            lease.assertCurrent()
            if (busy(id) || fixed.storageId !== id || current?.credentialRevision !== fixed.revision) throw new Error('激活账号状态已变化，不自动重发')
            try {
              await sendActivationRequest(fixed, ACTIVATION_MODEL, AbortSignal.any([requestSignal, sendSignal, AbortSignal.timeout(20000)]))
            } catch {
              throw new Error('激活结果未确认，不自动重发')
            }
          },
          dispose,
        }
      } catch {
        await dispose()
        throw new Error('激活连接未就绪，本次跳过')
      }
    },
    afterSend: async id => {
      if (busy(id) || coordinator.isAccountOperationInProgress()) return '请求已完成；账号忙碌，额度同步已跳过'
      const started = Date.now()
      const account = await coordinator.refreshAccount(id)
      if (account.quotaStatus !== 'ready' || !account.quotaUpdatedAtIso || !(Date.parse(account.quotaUpdatedAtIso) >= started)) return '请求已完成；额度同步失败'
      const window = [account.quotaSnapshot?.primary, account.quotaSnapshot?.secondary].find(row => row?.windowMinutes === 300)
      return window?.resetsAt && window.resetsAt * 1000 > Date.now() && window.usedPercent > 0
        ? '请求已完成；额度已同步，5 小时窗口已确认'
        : '请求已完成；额度已同步，5 小时窗口尚未确认'
    },
  })
}
