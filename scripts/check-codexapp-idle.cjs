// Shared read-only preflight for candidate replacement and production cutover.
async function checkIdle(baseUrl, { legacyScheduler = false } = {}) {
  async function readJson(path, init) {
    const response = await fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
    return response.json();
  }
  if (!legacyScheduler) {
    const { data } = await readJson('/codex-api/automation-runtime');
    if (data?.ready !== true || data.activeCount !== 0 || data.queuedCount !== 0) {
      throw new Error('Automation scheduler is unavailable or still has active/queued runs');
    }
  }
  const queue = (await readJson('/codex-api/thread-queue-state')).data;
  if (!queue || typeof queue !== 'object' || Array.isArray(queue) || Object.values(queue).some(rows => !Array.isArray(rows))) {
    throw new Error('Invalid queue state; idle status is unknown');
  }
  const queuedCount = Object.values(queue).reduce((count, rows) => count + rows.length, 0);
  const pending = (await readJson('/codex-api/server-requests/pending')).data;
  if (!Array.isArray(pending)) throw new Error('Invalid pending request state; idle status is unknown');
  let cursor = null;
  let pages = 0;
  let activeTurns = 0;
  do {
    const payload = await readJson('/codex-api/rpc', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++pages, method: 'thread/list', params: { archived: false, limit: 100, sortKey: 'updated_at', modelProviders: [], cursor } }),
    });
    if (payload.error || !Array.isArray(payload.result?.data)) throw new Error('Unable to inspect active threads');
    for (const thread of payload.result.data) {
      const status = typeof thread.status === 'string' ? thread.status : thread.status?.type;
      if (['active', 'inProgress', 'running'].includes(status)) activeTurns++;
      else if (!['idle', 'notLoaded', 'systemError', 'completed', 'interrupted', 'failed'].includes(status)) {
        throw new Error('Unknown thread status; idle status is unknown');
      }
    }
    cursor = payload.result.nextCursor || null;
  } while (cursor && pages < 20);
  if (cursor) throw new Error('Thread inventory exceeded the bounded 2000-thread idle check');
  return { activeTurns, queuedCount, pendingCount: pending.length, pages, idle: !activeTurns && !queuedCount && !pending.length };
}

module.exports = { checkIdle };
if (require.main === module) {
  checkIdle(process.env.CODEXAPP_IDLE_CHECK_URL, { legacyScheduler: process.env.CODEXAPP_LEGACY_SCHEDULER === '1' })
    .then(result => {
      console.log(`idle-check|activeTurns=${result.activeTurns}|queued=${result.queuedCount}|pendingApprovals=${result.pendingCount}|pages=${result.pages}`);
      if (!result.idle) process.exitCode = 3;
    })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
