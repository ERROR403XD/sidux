#!/usr/bin/env node
// Deterministic IPC fixture. It never contacts an upstream model service.
const { createInterface } = require('node:readline')
const { readFileSync, writeFileSync, readdirSync } = require('node:fs')
const { randomUUID } = require('node:crypto')
if (!process.argv.includes('app-server')) process.exit(0)
let account = 'none'
try { account = JSON.parse(readFileSync(process.env.CODEX_HOME + '/auth.json', 'utf8')).tokens.account_id } catch {}
const threads = new Map()
const loaded = new Set()
const refreshReplies = new Map()
let nextRefreshId = 900000
const save = thread => writeFileSync(process.env.CODEX_HOME + '/fixture-thread-' + thread.id + '.json', JSON.stringify(thread))
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const notify = (method, params) => send({ method, params })
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  const { id, method, params: p = {} } = message
  if (!method && refreshReplies.has(id)) {
    const finish = refreshReplies.get(id)
    refreshReplies.delete(id)
    finish(message)
    return
  }
  if (!method || id === undefined) return
  let result = {}
  if (method === 'account/login/start') account = p.chatgptAccountId
  if (method === 'account/read') result = { account: { id: account, email: account + '@example.test' }, pid: process.pid }
  if (method === 'config/read') result = { config: { model_provider: 'openai', model: 'fixture' } }
  if (method === 'account/rateLimits/read') result = { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } } }
  if (method === 'thread/start') {
    const thread = { id: randomUUID(), cwd: p.cwd, status: { type: 'idle' }, turns: [] }
    threads.set(thread.id, thread)
    loaded.add(thread.id)
    save(thread)
    result = { thread, model: 'fixture' }
  }
  if (method === 'thread/list') result = { data: readdirSync(process.env.CODEX_HOME).filter(name => /^fixture-thread-.*\.json$/.test(name)).map(name => JSON.parse(readFileSync(process.env.CODEX_HOME + '/' + name, 'utf8'))), nextCursor: null }
  if (method === 'thread/loaded/list') result = { data: [...loaded], nextCursor: null }
  if (method === 'thread/backgroundTerminals/list') result = { data: [], nextCursor: null }
  if (method === 'thread/unsubscribe') result = { status: loaded.has(p.threadId) ? 'unsubscribed' : 'notLoaded' }
  if (method === 'thread/resume') {
    const thread = JSON.parse(readFileSync(process.env.CODEX_HOME + '/fixture-thread-' + p.threadId + '.json', 'utf8'))
    // Native Codex does not persist a resumable rollout until the first turn.
    if (!thread.turns.length) { send({ id, error: { message: 'no rollout found for thread id ' + p.threadId } }); return }
    threads.set(thread.id, thread)
    loaded.add(thread.id)
    result = { thread }
  }
  if (method === 'thread/read') {
    if (!loaded.has(p.threadId)) { send({ id, error: { message: 'thread not loaded: ' + p.threadId } }); return }
    result = { thread: threads.get(p.threadId) }
  }
  if (method === 'turn/start') {
    const thread = threads.get(p.threadId)
    if (!thread) { send({ id, error: { message: 'wrong_runtime' } }); return }
    const turn = { id: randomUUID(), status: 'inProgress', items: [{ id: randomUUID(), type: 'userMessage', content: p.input || [] }] }
    thread.turns.push(turn)
    thread.status.type = 'active'
    result = { turn }
    notify('turn/started', { threadId: thread.id, turn })
    const finish = () => {
      turn.status = 'completed'
      turn.items.push({ id: randomUUID(), type: 'agentMessage', text: 'OUTPUT:' + account })
      thread.status.type = 'idle'
      save(thread)
      notify('turn/completed', { threadId: thread.id, turn })
    }
    if (JSON.stringify(p.input).includes('REFRESH')) {
      const requestId = nextRefreshId++
      refreshReplies.set(requestId, message => {
        if (message.error || message.result?.chatgptAccountId !== account) {
          turn.status = 'failed'
          notify('turn/completed', { threadId: thread.id, turn })
        } else finish()
      })
      send({ id: requestId, method: 'account/chatgptAuthTokens/refresh', params: { previousAccountId: account, reason: 'unauthorized' } })
    } else if (!JSON.stringify(p.input).includes('STALL')) setTimeout(finish, 10)
  }
  if (method === 'turn/interrupt') {
    const thread = threads.get(p.threadId)
    const turn = thread?.turns.find(turn => turn.id === p.turnId)
    if (turn) { turn.status = 'interrupted'; thread.status.type = 'idle'; notify('turn/completed', { threadId: thread.id, turn }) }
  }
  send({ id, result })
})
