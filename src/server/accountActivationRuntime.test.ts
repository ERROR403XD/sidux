import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiProxyGateway } from './apiProxy/gateway'
import type { AccountAuthCoordinator } from './accountAuthCoordinator'
import { AccountExecutionRegistry } from './accountExecution'
import { createAccountActivationRuntime } from './accountActivationRuntime'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const done of cleanup.splice(0).reverse()) await done(); vi.restoreAllMocks() })
async function fixture(mode: 'complete' | 'disconnect' | 'busy' | 'sync-error' | 'revision' | 'removed' = 'complete') {
  const root = await mkdtemp(join(tmpdir(), 'activation-api-'))
  cleanup.push(() => rm(root,{recursive:true,force:true}))
  let now = Date.parse('2026-09-11T07:59:00Z')
  vi.spyOn(Date,'now').mockImplementation(() => now)
  const executions = new AccountExecutionRegistry()
  const account = {storageId:'a',accountId:'fixed-a',credentialRevision:1,authStatus:'ready',quotaStatus:'ready',quotaUpdatedAtIso:'',quotaSnapshot:{primary:{windowMinutes:300,usedPercent:0,resetsAt:Math.floor(now/1000)+18000},secondary:null}}
  let reads=0
  const refresh = vi.fn(async () => {
    reads++
    if(reads>1 && mode==='sync-error')throw new Error('upstream secret')
    account.quotaUpdatedAtIso=new Date(now).toISOString()
    if(reads>1)account.quotaSnapshot.primary.usedPercent=1
    return account
  })
  const coordinator = {executions,store:{codexHome:root,readState:async()=>({activeStorageId:'primary-unchanged',accounts:[account]})},blocksApiAccount:()=>false,isAccountRefreshInProgress:()=>false,isAccountOperationInProgress:()=>false,refreshAccount:refresh} as unknown as AccountAuthCoordinator
  const requests: any[]=[]
  let normal: ReturnType<AccountExecutionRegistry['register']> | undefined
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk
    requests.push(JSON.parse(body))
    if(mode==='removed'){executions.revoke('a');res.destroy();return}
    if(mode==='busy'){
      normal=executions.register({storageId:'a',kind:'primary',ownerId:'normal',disconnect:vi.fn()})
      res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: {"type":"response.created"}\n\n');return
    }
    if(mode==='disconnect'){res.end('data: {"type":"response.created"}\n\n');return}
    res.writeHead(200,{'Content-Type':'text/event-stream'})
    res.end('data: {"type":"response.completed","response":{"id":"r","status":"completed"}}\n\n')
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  cleanup.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))})
  const release=vi.fn()
  const gateway={prepareActivation:vi.fn(async(id:string)=>({url:`http://127.0.0.1:${(server.address() as any).port}/v1/responses`,headers:{'Content-Type':'application/json'},storageId:id,revision:mode==='revision'?2:1,release}))} as unknown as ApiProxyGateway
  const service=createAccountActivationRuntime(coordinator,gateway)
  cleanup.push(()=>service.dispose())
  await service.ready
  await service.configure({enabled:true,accountIds:['a'],times:['08:00'],timezone:'UTC'})
  now=(await service.snapshot()).nextAt!
  await service.tick()
  await service.tick()
  return {service,requests,release,coordinator,executions,root,refresh,normal}
}
describe('activation runtime with real local HTTP transport',()=>{
  it('releases before quota refresh, syncs target quota, creates no session directories and sends only once',async()=>{
    const f=await fixture()
    const run=(await f.service.snapshot()).runs[0]!
    expect(run.status).toBe('sent');expect(run.reason).toContain('窗口已确认')
    expect(f.requests).toHaveLength(1);expect(f.requests[0].input[0].content[0].text).toBe('hi')
    expect(f.refresh).toHaveBeenCalledTimes(2)
    expect(f.release).toHaveBeenCalledOnce()
    expect(f.executions.snapshot()).toEqual([])
    expect(await readdir(f.root)).toEqual(['account-activation'])
    expect(await readdir(join(f.root,'account-activation'))).not.toContain('sessions')
    expect((await f.coordinator.store.readState()).activeStorageId).toBe('primary-unchanged')
  })
  it.each(['disconnect','busy','removed'] as const)('does not retry %s and preserves normal execution',async mode=>{
    const f=await fixture(mode)
    expect((await f.service.snapshot()).runs[0]!.status).toBe('unknown')
    expect(f.requests).toHaveLength(1);expect(f.refresh).toHaveBeenCalledOnce()
    expect(f.release).toHaveBeenCalledOnce()
    if(mode==='busy')expect(f.normal!.signal.aborted).toBe(false)
  })
  it('keeps generation sent when independent quota synchronization fails',async()=>{
    const f=await fixture('sync-error')
    expect((await f.service.snapshot()).runs[0]).toMatchObject({status:'sent',reason:'请求已完成；额度同步失败，不重发'})
    expect(f.requests).toHaveLength(1)
  })
  it('never sends through a component with a different credential revision',async()=>{
    const f=await fixture('revision')
    expect(f.requests).toHaveLength(0)
    expect(f.release).toHaveBeenCalledOnce()
    expect(f.executions.snapshot()).toEqual([])
  })

})
