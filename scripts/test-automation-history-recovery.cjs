const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const assert = require('node:assert/strict')

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'history-process-recovery-'))
  const entry = process.env.HISTORY_TEST_ENTRY || path.resolve('dist-cli/index.js')
  const report = { entry, checkpoints: [] }
  try {
    const preload = path.join(root, 'crash.cjs')
    await fs.writeFile(preload, `const fs=require('node:fs/promises');const original=fs.rename;let calls=0;fs.rename=async(...args)=>{await original(...args);if(String(args[1]).startsWith(process.env.CODEXAPP_HISTORY_FAULT_PATH)&&++calls===Number(process.env.CODEXAPP_HISTORY_FAULT_AFTER))process.kill(process.pid,'SIGKILL')};require('node:module').syncBuiltinESMExports();`)
    for (let checkpoint = 1; checkpoint <= 5; checkpoint++) {
      const home = path.join(root, `home-${checkpoint}`)
      const directory = path.join(home, 'codexapp-automations')
      await fs.mkdir(path.join(directory, 'history-v2', 'pending'), { recursive: true })
      const run = { runId: 'history-fixture', automationId: 'fixture', target: '/fixture', kind: 'cron', key: `manual:fixture:crash-${checkpoint}`, revision: 'r1', trigger: 'manual', scheduledAt: 1000, timezone: 'Asia/Shanghai', createdAt: 1000, startedAt: 1000, finishedAt: 2000, status: 'completed', attempt: 1, threadId: 'fixture-thread', turnId: 'fixture-turn', model: 'fixture', error: null, errorCode: null }
      const hash = value => crypto.createHash('sha256').update(value).digest('hex')
      const digest = hash(run.key)
      await fs.writeFile(path.join(directory, 'history-v2', 'pending', `${digest}.json`), JSON.stringify(run))
      await fs.writeFile(path.join(home, 'auth.json'), 'fixture-auth-sentinel')
      const env = { ...process.env, CODEX_HOME: home, CODEXAPP_HISTORY_FAULT_PATH: path.join(directory, 'history-v2'), CODEXAPP_HISTORY_FAULT_AFTER: String(checkpoint) }
      delete env.OPENAI_API_KEY
      delete env.CODEX_API_KEY
      const crashed = spawnSync(process.execPath, ['--require', preload, entry, 'automation-history', '--home', home], { env, encoding: 'utf8', timeout: 30000 })
      assert.equal(crashed.signal, 'SIGKILL', crashed.stderr)
      const recovered = spawnSync(process.execPath, [entry, 'automation-history', '--home', home, '--export-legacy'], { env, encoding: 'utf8', timeout: 30000 })
      assert.equal(recovered.status, 0, recovered.stderr)
      assert.deepEqual(JSON.parse(recovered.stdout.trim()), { records: 1, exportedLegacy: true })
      assert.deepEqual(await fs.readdir(path.join(directory, 'history-v2', 'pending')), [])
      const index = JSON.parse(await fs.readFile(path.join(directory, 'history-keys', `${digest}.json`), 'utf8'))
      const body = JSON.parse(await fs.readFile(path.join(directory, 'history', hash(index.automationId), index.name), 'utf8'))
      assert.deepEqual(body, run)
      assert.equal(await fs.readFile(path.join(home, 'auth.json'), 'utf8'), 'fixture-auth-sentinel')
      report.checkpoints.push({ checkpoint, killedOwnChild: true, lockRecovered: true, singleOriginalRun: true, legacyReaderCompatible: true, authUnchanged: true })
    }
    const reportPath = process.env.UI_REPORT_PATH || 'output/0219-final/history-process.json'
    await fs.mkdir(path.dirname(reportPath), { recursive: true })
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2))
    console.log('HISTORY_PROCESS_RECOVERY_PASS', JSON.stringify(report))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })
