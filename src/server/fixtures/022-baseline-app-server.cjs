#!/usr/bin/env node
// Deterministic 0.2.22 baseline fixture. It never contacts an upstream service.
const { createInterface } = require('node:readline')
const { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

if (process.argv.includes('--version')) {
  process.stdout.write('codex-script 0.2.22-baseline\n')
  process.exit(0)
}

const schemaOutIndex = process.argv.indexOf('--out')
if (schemaOutIndex !== -1) {
  const outputDir = process.argv[schemaOutIndex + 1]
  if (!outputDir) process.exit(1)
  const requestMethods = [
    'thread/turns/list',
    'thread/items/list',
    'thread/backgroundTerminals/list',
    'thread/loaded/list',
  ]
  const schema = methods => ({ oneOf: methods.map(method => ({ properties: { method: { const: method } } })) })
  mkdirSync(join(outputDir, 'v2'), { recursive: true })
  writeFileSync(join(outputDir, 'ClientRequest.json'), JSON.stringify(schema(requestMethods), null, 2))
  writeFileSync(join(outputDir, 'ServerNotification.json'), JSON.stringify(schema(['thread/event']), null, 2))
  writeFileSync(join(outputDir, 'v2', 'ThreadResumeParams.json'), JSON.stringify({
    properties: { initialTurnsPage: { type: 'boolean' } },
  }, null, 2))
  writeFileSync(join(outputDir, 'v2', 'ThreadForkParams.json'), JSON.stringify({
    properties: { lastTurnId: { type: 'string' }, deferGoalContinuation: { type: 'boolean' } },
  }, null, 2))
  process.exit(0)
}

if (!process.argv.includes('app-server')) process.exit(0)

const home = process.env.CODEX_HOME
const configuredProviderArg = process.argv.find(arg => arg.startsWith('model_provider='))
const configuredProvider = configuredProviderArg ? JSON.parse(configuredProviderArg.slice('model_provider='.length)) : 'openai'
function readCredentialAccount(directory) {
  try {
    return JSON.parse(readFileSync(join(directory, 'auth.json'), 'utf8')).tokens?.account_id || 'baseline'
  } catch {
    return 'baseline'
  }
}

let runtimeAccountId = readCredentialAccount(home)
const fixtureAccounts = {
  'baseline-a': { email: 'baseline-a@example.test', planType: 'plus' },
  'baseline-b': { email: 'baseline-b@example.test', planType: 'pro' },
}
const threadDir = join(home, 'sessions', '2026', '10')
const threads = new Map()
const loaded = new Set()
const capabilities = {
  historyPaging: true,
  resumeInitialPage: true,
  exactFork: true,
}

function send(value) {
  process.stdout.write(JSON.stringify(value) + '\n')
}

function loadThreads() {
  for (const name of existsSync(threadDir) ? readdirSync(threadDir) : []) {
    if (!name.endsWith('.json')) continue
    const thread = JSON.parse(readFileSync(join(threadDir, name), 'utf8'))
    threads.set(thread.id, thread)
  }
  return [...threads.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}

function summary(thread) {
  return {
    ...thread,
    createdAt: thread.createdAt > 10_000_000_000 ? Math.floor(thread.createdAt / 1000) : thread.createdAt,
    updatedAt: thread.updatedAt > 10_000_000_000 ? Math.floor(thread.updatedAt / 1000) : thread.updatedAt,
    turns: thread.turns.slice(-1),
  }
}

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  const { id, method, params = {} } = message
  if (!method || id === undefined) return
  let result = {}
  if (method === 'initialize') result = {}
  if (method === 'account/login/start') {
    runtimeAccountId = params.chatgptAccountId || runtimeAccountId
    result = { status: 'ok' }
  }
  if (method === 'account/read') result = {
    account: {
      id: runtimeAccountId,
      email: fixtureAccounts[runtimeAccountId]?.email || 'baseline@example.test',
      planType: fixtureAccounts[runtimeAccountId]?.planType || 'plus',
    },
    pid: process.pid,
  }
  if (method === 'config/read') result = { config: { model_provider: 'openai', model: 'baseline' } }
  if (method === 'account/rateLimits/read') result = { rateLimits: { primary: { usedPercent: 1, windowDurationMins: 300 } } }
  if (method === 'account/chatgptAuthTokens/refresh') result = { status: 'ok' }
  if (method === 'model/list') result = { data: [{ id: 'baseline-model', model: 'baseline-model' }], nextCursor: null }
  if (method === 'capabilities/read') result = capabilities
  if (method === 'thread/list') {
    const rows = loadThreads()
    const offset = typeof params.cursor === 'string' && params.cursor.startsWith('offset:') ? Number(params.cursor.slice(7)) : 0
    const limit = Math.min(Number(params.limit || 10), 50)
    const page = rows.slice(offset, offset + limit)
    const next = offset + limit < rows.length ? `offset:${offset + limit}` : null
    result = { data: page.map(summary), nextCursor: next }
  }
  if (method === 'thread/loaded/list') result = { data: [...loaded], nextCursor: null }
  if (method === 'thread/backgroundTerminals/list') result = { data: [], nextCursor: null }
  if (method === 'thread/goal/get') result = { goal: null }
  if (method === 'thread/resume') {
    const thread = threads.get(params.threadId) || JSON.parse(readFileSync(join(threadDir, `${params.threadId}.json`), 'utf8'))
    loaded.add(thread.id)
    threads.set(thread.id, thread)
    const page = thread.turns.slice(-10)
    result = {
      initialTurnsPage: {
        data: [...page].reverse(),
        nextCursor: page.length < thread.turns.length ? `offset:${thread.turns.length - 10}` : null,
      },
      thread,
      modelProvider: configuredProvider,
    }
  }
  if (method === 'thread/unsubscribe') {
    loaded.delete(params.threadId)
    result = { status: 'unsubscribed' }
  }
  if (method === 'thread/read') {
    const thread = threads.get(params.threadId) || (existsSync(join(threadDir, `${params.threadId}.json`))
      ? JSON.parse(readFileSync(join(threadDir, `${params.threadId}.json`), 'utf8'))
      : null)
    if (!thread) {
      send({ id, error: { message: `thread not loaded: ${params.threadId}` } })
      return
    }
    const turns = thread.turns.slice(-Number(params.limit || 10))
    result = { thread: { ...thread, turns } }
  }
  if (method === 'thread/turns/list') {
    const thread = threads.get(params.threadId)
    if (!thread) {
      send({ id, error: { message: `thread not loaded: ${params.threadId}` } })
      return
    }
    const limit = Math.min(Number(params.limit || 10), 50)
    const end = typeof params.cursor === 'string' && params.cursor.startsWith('offset:') ? Number(params.cursor.slice(7)) : thread.turns.length
    const start = Math.max(0, end - limit)
    const page = thread.turns.slice(start, end)
    const next = start > 0 ? `offset:${start}` : null
    result = { data: [...page].reverse(), nextCursor: next }
  }
  if (method === 'turn/start') {
    const thread = threads.get(params.threadId)
    if (!thread) {
      send({ id, error: { message: 'wrong_runtime' } })
      return
    }
    const turn = {
      id: `turn-${Date.now()}`,
      status: { type: 'completed' },
      items: [
        { type: 'userMessage', content: params.input || [] },
        { type: 'agentMessage', text: 'baseline fixture reply' },
      ],
    }
    thread.turns.push(turn)
    thread.updatedAt = Date.now()
    writeFileSync(join(threadDir, `${thread.id}.json`), JSON.stringify(thread))
    result = { turn }
  }
  send({ id, result })
})
