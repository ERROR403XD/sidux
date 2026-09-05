import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { AutomationEngine, type AutomationRuntime } from '../src/server/automationEngine.js'
import { buildComposerCommands, filterComposerCommands } from '../src/components/content/composerCommands.js'

const duration = Number(process.env.AUTOMATION_PROFILE_MS || 600000)
const root = await mkdtemp(join(tmpdir(), 'codexapp-0190-performance-'))
const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable()
const engines: AutomationEngine[] = []
const results: Record<string, unknown>[] = []
const elapsed: number[] = []
let runtimeCalls = 0
const runtime: AutomationRuntime = {
  accountBusy: () => false, canStart: async () => { runtimeCalls++; return true },
  createThread: async () => { runtimeCalls++; return { threadId: 'profile' } }, prepare: async () => { runtimeCalls++; return {} },
  start: async () => { runtimeCalls++; return { turnId: 'profile' } }, inspect: async () => { runtimeCalls++; return { status: 'completed' } }, interrupt: async () => { runtimeCalls++ },
}
const started = performance.now(), cpuStart = process.cpuUsage(), rssStart = process.memoryUsage().rss
try {
  for (const count of [1, 10, 100]) {
    const home = join(root, String(count))
    for (let index = 0; index < count; index++) {
      const id = `profile-${index}`, directory = join(home, 'automations', id)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'automation.toml'), `id='${id}'\nname='性能测试'\nkind='cron'\nprompt='Internal fixture only'\nrrule='FREQ=WEEKLY;BYDAY=MO;BYHOUR=1;BYMINUTE=0'\ncwds=['${home}']\n`)
    }
    const before = performance.now()
    const engine = new AutomationEngine(home, runtime, Date.now, false)
    await engine.readyPromise; engines.push(engine)
    if (!engine.snapshot().ready) throw new Error(engine.snapshot().error || 'Not ready')
    results.push({ tasks: count, startupMs: performance.now() - before })
  }
  while (performance.now() - started < duration) {
    const before = performance.now()
    await Promise.all(engines.map((engine) => engine.tick()))
    elapsed.push(performance.now() - before)
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  const search = [100, 1000].map((count) => {
    const commands = buildComposerCommands(Array.from({ length: count }, (_, index) => ({ name: `test-${index}`, description: '审查代码和优化体验', path: `/skills/${index}` })), [])
    const timings: number[] = []
    for (let iteration = 0; iteration < 1000; iteration++) { const before = performance.now(); filterComposerCommands(commands, iteration % 2 ? '审查' : 'test-5'); timings.push(performance.now() - before) }
    timings.sort((a, b) => a - b)
    return { candidates: count, p95Ms: timings[950] }
  })
  elapsed.sort((a, b) => a - b)
  const result = { durationMs: performance.now() - started, definitions: results, runtimeCalls, tickP95Ms: elapsed[Math.floor(elapsed.length * .95)], tickMaxMs: elapsed.at(-1), eventLoopP99Ms: delay.percentile(99) / 1e6, rssDeltaMB: (process.memoryUsage().rss - rssStart) / 1048576, cpu: process.cpuUsage(cpuStart), search }
  await mkdir('output/playwright', { recursive: true })
  await writeFile('output/playwright/automation-0190-performance.json', JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} finally { delay.disable(); for (const engine of engines) await engine.dispose(); await rm(root, { recursive: true, force: true }) }
