import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readAnyJsonBody, setJson } from '../httpUtils.js'
import { WebUiBrandingStore } from '../webUiBrandingStore.js'
import { createBrandingRoutes } from './brandingRoutes.js'

let home: string
let server: Server
let base: string
let store: WebUiBrandingStore

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'sidux-branding-route-'))
  store = new WebUiBrandingStore(home)
  const route = createBrandingRoutes(() => store)
  server = createServer((req, res) => {
    void route(req, res, new URL(req.url ?? '/', 'http://localhost'), { readJsonBody: readAnyJsonBody }).then(handled => {
      if (!handled) setJson(res, 404, { error: 'Unhandled' })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(home, { recursive: true, force: true })
})

async function post(body: string) {
  const response = await fetch(`${base}/codex-api/webui-branding`, { method: 'POST', body })
  return { status: response.status, body: await response.json() }
}

describe('branding route/store contract', () => {
  it('persists a normalized title and restores it through the same store owner', async () => {
    expect(await post('{"title":"  fixture  ","titleMode":"prefix"}')).toMatchObject({ status: 200, body: { data: { title: 'fixture', titleMode: 'prefix' } } })
    expect(JSON.parse(await readFile(join(home, 'webui-branding.json'), 'utf8'))).toMatchObject({ title: 'fixture', titleMode: 'prefix' })
    expect(await new WebUiBrandingStore(home).snapshot()).toMatchObject({ title: 'fixture', titleMode: 'prefix' })
  })

  it('maps validation/parse errors to 400 and permits a later valid save', async () => {
    expect(await post('{"titleMode":"bad"}')).toEqual({ status: 400, body: { error: '标题显示方式无效' } })
    const malformed = await post('{broken')
    expect(malformed.status).toBe(400)
    expect(malformed.body).toHaveProperty('error')
    expect((await post('{"title":"next"}')).status).toBe(200)
  })

  it('keeps non-object bodies as empty updates and serializes concurrent saves', async () => {
    for (const body of ['', 'null', '[]']) expect((await post(body)).status).toBe(200)
    const responses = await Promise.all([post('{"title":"updated"}'), post('{"titleMode":"prefix"}')])
    expect(responses.every(result => result.status === 200)).toBe(true)
    expect(await store.snapshot()).toMatchObject({ title: 'updated', titleMode: 'prefix' })
  })

  it('falls through methods and other paths', async () => {
    expect((await fetch(`${base}/codex-api/webui-branding`)).status).toBe(404)
    expect((await fetch(`${base}/codex-api/other`, { method: 'POST' })).status).toBe(404)
  })
})
