#!/usr/bin/env node
// Deterministic IPC fixture. It never contacts an upstream model service.
const { createInterface } = require('node:readline')
const { readFileSync } = require('node:fs')
const { randomUUID } = require('node:crypto')
if (!process.argv.includes('app-server')) process.exit(0)
let account = JSON.parse(readFileSync(process.env.CODEX_HOME + '/auth.json', 'utf8')).tokens.account_id
const threads = new Map()
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const notify = (method, params) => send({ method, params })
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params: p = {} } = JSON.parse(line)
  if (!method || id === undefined) return
  let result = {}
  if (method === 'account/login/start') account = p.chatgptAccountId
  if (method === 'account/read') result = { account: { id: account, email: account + '@example.test' }, pid: process.pid }
  if (method === 'config/read') result = { config: { model_provider: 'openai', model: 'fixture' } }
  if (method === 'account/rateLimits/read') result = { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } } }
  if (method === 'thread/start') {
    const thread = { id: randomUUID(), cwd: p.cwd, status: { type: 'idle' }, turns: [] }
    threads.set(thread.id, thread)
    result = { thread, model: 'fixture' }
  }
  if (method === 'thread/list') result = { data: [...threads.values()], nextCursor: null }
  if (method === 'thread/loaded/list') result = { data: [...threads.keys()], nextCursor: null }
  if (method === 'thread/backgroundTerminals/list') result = { terminals: [] }
  if (method === 'thread/read' || method === 'thread/resume') result = { thread: threads.get(p.threadId) }
  if (method === 'turn/start') {
    const thread = threads.get(p.threadId)
    if (!thread) { send({ id, error: { message: 'wrong_runtime' } }); return }
    const turn = { id: randomUUID(), status: 'inProgress', items: [{ id: randomUUID(), type: 'userMessage', content: p.input || [] }] }
    thread.turns.push(turn)
    thread.status.type = 'active'
    result = { turn }
    notify('turn/started', { threadId: thread.id, turn })
    if (!JSON.stringify(p.input).includes('STALL')) setTimeout(() => {
      turn.status = 'completed'
      turn.items.push({ id: randomUUID(), type: 'agentMessage', text: 'OUTPUT:' + account })
      thread.status.type = 'idle'
      notify('turn/completed', { threadId: thread.id, turn })
    }, 10)
  }
  if (method === 'turn/interrupt') {
    const thread = threads.get(p.threadId)
    const turn = thread?.turns.find(turn => turn.id === p.turnId)
    if (turn) { turn.status = 'interrupted'; thread.status.type = 'idle'; notify('turn/completed', { threadId: thread.id, turn }) }
  }
  send({ id, result })
})
