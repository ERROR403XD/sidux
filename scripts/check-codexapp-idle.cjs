// Shared read-only preflight for candidate replacement and production cutover.
async function checkIdle(baseUrl, { legacyScheduler = false, legacyApiProxy = false } = {}) {
  const deadline = Date.now() + 45000;
  async function readJson(path, init, allowMissing = false) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Idle inventory exceeded its 45-second limit');
    const response = await fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(Math.min(10000, remaining)) });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
    return response.json();
  }
  async function liveActivity() {
    // Older candidates do not expose this snapshot. Their existing inventory
    // remains required; newer runtimes additionally cover pre-catalog turns.
    const payload = await readJson('/codex-api/runtime/activity', undefined, true);
    if (payload === null) return 0;
    const data = payload?.data;
    if (!Array.isArray(data?.activeTurnThreadIds) || data.activeTurnThreadIds.some(id => typeof id !== 'string' || !id)
      || !Number.isInteger(data.pendingOperationCount) || data.pendingOperationCount < 0) throw new Error('Invalid live runtime activity; idle status is unknown');
    return data.activeTurnThreadIds.length + data.pendingOperationCount;
  }
  async function activationActivity() {
    if (legacyApiProxy) return null;
    const payload = await readJson('/codex-api/api-proxy/activation/activity', undefined, true);
    // 0.2.18 and earlier do not expose this inventory; report that explicitly.
    if (payload === null) return null;
    const data = payload?.data;
    if (data?.ready !== true || typeof data.draining !== 'boolean'
      || !Number.isInteger(data.activeCount) || data.activeCount < 0) {
      throw new Error('Invalid activation activity; idle status is unknown');
    }
    return data.activeCount;
  }
  let activationCount = await activationActivity();
  let liveActivityCount = await liveActivity();
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
  let apiConnections = 0;
  let apiActiveRequests = 0;
  if (!legacyApiProxy) {
    const { data } = await readJson('/codex-api/api-proxy/status');
    if (!data?.settings || typeof data.settings.enabled !== 'boolean' || !data.activity
      || !Number.isInteger(data.activity.connections) || data.activity.connections < 0
      || !Number.isInteger(data.activity.activeRequests) || data.activity.activeRequests < 0) {
      throw new Error('Invalid API proxy activity; idle status is unknown');
    }
    apiConnections = data.activity.connections;
    apiActiveRequests = data.activity.activeRequests;
  }
  let cursor = null;
  let pages = 0;
  let activeTurns = 0;
  const cursors = new Set();
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
    if (cursor && (typeof cursor !== 'string' || cursors.has(cursor))) throw new Error('Thread inventory cursor did not advance');
    if (cursor) cursors.add(cursor);
  } while (cursor && pages < 20);
  if (cursor) throw new Error('Thread inventory exceeded the bounded 2000-thread idle check');
  const busy = !!(activationCount || liveActivityCount || activeTurns || queuedCount || pending.length || apiConnections || apiActiveRequests);
  let backgroundCheck = 'skipped-busy';
  let backgroundThreads = null;
  let loadedThreads = 0;
  if (!busy) {
    const { data: methods } = await readJson('/codex-api/meta/methods');
    if (!Array.isArray(methods) || methods.some(method => typeof method !== 'string')) throw new Error('Unable to inspect background terminal capability');
    backgroundCheck = 'unsupported';
    if (methods.includes('thread/backgroundTerminals/list')) {
      if (!methods.includes('thread/loaded/list')) throw new Error('Unable to inventory threads with background terminals');
      backgroundCheck = 'supported';
      backgroundThreads = 0;
      async function rpc(method, params) {
        const payload = await readJson('/codex-api/rpc', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }),
        });
        if (payload.error || !Array.isArray(payload.result?.data)) throw new Error(`Unable to inspect ${method}`);
        return payload.result;
      }
      const ids = new Set();
      const loadedCursors = new Set();
      cursor = null;
      do {
        const result = await rpc('thread/loaded/list', { limit: 100, cursor });
        if (result.data.length > 100 || result.data.some(id => typeof id !== 'string' || !id || id.length > 200)) throw new Error('Invalid loaded thread inventory');
        result.data.forEach(id => ids.add(id));
        cursor = result.nextCursor || null;
        if (cursor && (typeof cursor !== 'string' || loadedCursors.has(cursor))) throw new Error('Loaded thread cursor did not advance');
        if (cursor) loadedCursors.add(cursor);
        if (ids.size > 200 || (cursor && loadedCursors.size >= 2)) throw new Error('Loaded thread inventory exceeded the bounded 200-thread check');
      } while (cursor);
      const threads = [...ids];
      loadedThreads = threads.length;
      let next = 0;
      const reads = await Promise.allSettled(Array.from({ length: Math.min(4, threads.length) }, async () => {
        while (next < threads.length) {
          const threadId = threads[next++];
          // Presence alone blocks cutover; never read command output or full history.
          const result = await rpc('thread/backgroundTerminals/list', { threadId, limit: 1 });
          if (result.data.length > 1 || (!result.data.length && result.nextCursor)) throw new Error('Invalid background terminal inventory');
          if (result.data.length) backgroundThreads++;
        }
      }));
      const failed = reads.find(read => read.status === 'rejected');
      if (failed) throw failed.reason;
    }
  }
  liveActivityCount = Math.max(liveActivityCount, await liveActivity());
  const lastActivationCount = await activationActivity();
  if (lastActivationCount !== null) activationCount = Math.max(activationCount ?? 0, lastActivationCount);
  return { activationCount, liveActivityCount, activeTurns, queuedCount, pendingCount: pending.length, pages, apiConnections, apiActiveRequests, backgroundCheck, backgroundThreads, loadedThreads, idle: !busy && !backgroundThreads && !liveActivityCount && !activationCount };
}

module.exports = { checkIdle };
if (require.main === module) {
  checkIdle(process.env.CODEXAPP_IDLE_CHECK_URL, { legacyScheduler: process.env.CODEXAPP_LEGACY_SCHEDULER === '1', legacyApiProxy: process.env.CODEXAPP_LEGACY_API_PROXY === '1' })
    .then(result => {
      console.log(`idle-check|activation=${result.activationCount ?? 'unsupported'}|liveExecutions=${result.liveActivityCount}|activeTurns=${result.activeTurns}|queued=${result.queuedCount}|pendingApprovals=${result.pendingCount}|apiConnections=${result.apiConnections}|apiActiveRequests=${result.apiActiveRequests}|backgroundThreads=${result.backgroundThreads ?? result.backgroundCheck}|loadedThreads=${result.loadedThreads}|pages=${result.pages}`);
      if (!result.idle) process.exitCode = 3;
    })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
