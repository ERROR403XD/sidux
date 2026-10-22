#!/usr/bin/env node
const { closeSync, mkdirSync, openSync, writeFileSync, writeSync } = require('node:fs')
const { join } = require('node:path')
const { createHash } = require('node:crypto')

const home = process.argv[2]
const scenario = process.argv[3] || 'threads-201'
if (!home || !['empty', 'threads-201', 'session-index-3-months'].includes(scenario)) {
  console.error('Usage: node scripts/seed-022-baseline.cjs <home> empty|threads-201|session-index-3-months')
  process.exit(1)
}

mkdirSync(join(home, 'sessions', '2026', '10'), { recursive: true })
mkdirSync(join(home, 'codexapp-delivery'), { recursive: true })
mkdirSync(join(home, 'account-activation', 'history'), { recursive: true })
function fixtureJwt(accountId, userId, email, planType) {
  const payload = {
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/profile': { email },
    'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: planType, user_id: userId },
  }
  return `fixture.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

function writeAccountCredential(accountId, userId, email, planType) {
  const storageId = createHash('sha256').update(`${accountId}\u0000${userId}`).digest('hex')
  const raw = JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      account_id: accountId,
      access_token: fixtureJwt(accountId, userId, email, planType),
      refresh_token: `fixture-refresh-${accountId}`,
    },
  })
  mkdirSync(join(home, 'accounts', storageId), { recursive: true })
  writeFileSync(join(home, 'accounts', storageId, 'auth.json'), raw)
  return {
    accountId,
    storageId,
    userId,
    email,
    planType,
    credentialRevision: 1,
    authStatus: 'ready',
    lastRefreshedAtIso: new Date().toISOString(),
    lastVerifiedAtIso: new Date().toISOString(),
    lastActivatedAtIso: null,
    quotaSnapshot: {
      limitId: 'codex',
      limitName: 'Codex',
      primary: { usedPercent: accountId === 'baseline-a' ? 1 : 2, windowMinutes: 300, resetsAt: null },
      secondary: null,
      credits: null,
      planType,
    },
    quotaUpdatedAtIso: new Date().toISOString(),
    quotaStatus: 'ready',
    quotaError: null,
    unavailableReason: null,
  }
}

const accountRows = [
  writeAccountCredential('baseline-a', 'baseline-user-a', 'baseline-a@example.test', 'plus'),
  writeAccountCredential('baseline-b', 'baseline-user-b', 'baseline-b@example.test', 'pro'),
]
writeFileSync(
  join(home, 'auth.json'),
  require('node:fs').readFileSync(join(home, 'accounts', accountRows[0].storageId, 'auth.json'), 'utf8'),
)
writeFileSync(join(home, 'accounts.json'), JSON.stringify({
  schemaVersion: 1,
  operationEpoch: 1,
  activeAccountId: accountRows[0].accountId,
  activeStorageId: accountRows[0].storageId,
  accounts: accountRows,
}, null, 2))
writeFileSync(join(home, 'codexapp-delivery', 'pending.json'), JSON.stringify({
  version: 2,
  migratedLegacy: true,
  records: [],
}, null, 2))
if (scenario === 'empty') {
  console.log(JSON.stringify({ home, scenario, threadCount: 0 }))
  process.exit(0)
}

if (scenario === 'session-index-3-months') {
  const sessionIndexRecordCount = 1501
  const seededAtMs = Date.now()
  const openedIndex = openSync(join(home, 'session_index.jsonl'), 'w')
  for (let index = 1; index <= sessionIndexRecordCount; index += 1) {
    const updatedAtMs = seededAtMs - (sessionIndexRecordCount - index) * 86_400_000
    const record = {
      id: `022oldindex${String(index).padStart(6, '0')}`,
      thread_name: `022 Old Index ${String(index).padStart(4, '0')}`,
      updated_at: new Date(updatedAtMs).toISOString(),
    }
    writeSync(openedIndex, `${JSON.stringify(record)}\n`)
  }
  closeSync(openedIndex)
  console.log(JSON.stringify({
    home,
    scenario,
    threadCount: 0,
    sessionIndexRecordCount,
    historyDays: 90,
    retainedTitleLimit: 500,
  }))
  process.exit(0)
}

const now = Date.now()
const seededSeconds = Math.floor(now / 1000)
let firstThreadId = ''
let totalTurns = 0
for (let threadIndex = 0; threadIndex < 201; threadIndex += 1) {
  const id = `02200000000000000000000000000${String(threadIndex).padStart(3, '0')}`
  const turnCount = threadIndex === 0 ? 500 : threadIndex % 7 + 1
  totalTurns += turnCount
  const turns = Array.from({ length: turnCount }, (_, turnIndex) => ({
    id: `turn-${threadIndex}-${turnIndex}`,
    status: { type: 'completed' },
    items: [
      { type: 'userMessage', content: `0.2.22 baseline thread ${threadIndex} turn ${turnIndex}` },
      { type: 'agentMessage', text: `Fixture reply ${threadIndex}-${turnIndex} with stable text for rendering and history.` },
    ],
  }))
  const thread = {
    id,
    title: `022 Baseline ${String(threadIndex + 1).padStart(3, '0')}`,
    cwd: '/workspace',
    modelProvider: 'openai',
    preview: `022 Baseline ${String(threadIndex + 1).padStart(3, '0')}`,
    status: { type: 'idle' },
    turns,
    createdAt: seededSeconds - 201 * 60,
    updatedAt: Math.floor((now - threadIndex * 60_000) / 1000),
  }
  if (threadIndex === 0) firstThreadId = id
  writeFileSync(join(home, 'sessions', '2026', '10', `${id}.json`), JSON.stringify(thread))
}

writeFileSync(join(home, '022-baseline.json'), JSON.stringify({
  scenario,
  threadCount: 201,
  totalTurns,
  firstThreadId,
  seededAt: new Date(now).toISOString(),
  historyMonths: 3,
}, null, 2))
console.log(JSON.stringify({ home, scenario, threadCount: 201, totalTurns, firstThreadId }))
