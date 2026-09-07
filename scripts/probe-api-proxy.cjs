// Fixed-component contract probe. Uses only fabricated credentials and loopback TLS.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const http2 = require('node:http2');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { WebSocket, WebSocketServer } = require('ws');
const binary = process.env.CPA_BINARY;
if (!binary) throw new Error('Set CPA_BINARY to the verified CLIProxyAPI executable.');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codexapp-cpa-probe-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const records = [];
const connections = [];
const assertions = [];
const pass = name => assertions.push(name);
let child;
let childLog = '';
let sequence = 0;
let upstreamStatus = 200;
let backend, proxy, wss;
const peers = new Set();
const track = socket => { peers.add(socket); socket.once('close', () => peers.delete(socket)); };
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
function response() {
  return { id: `resp_fixture_${++sequence}`, object: 'response', created_at: 1700000000,
    status: 'completed', model: 'gpt-5.6-luna',
    output: [{ type: 'message', id: `msg_${sequence}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'fixture-ok', annotations: [] }] }],
    usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } };
}
function events(result) {
  return [{ type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
    { type: 'response.output_text.delta', item_id: `msg_${sequence}`, output_index: 0, content_index: 0, delta: 'fixture-ok' },
    { type: 'response.completed', response: result }];
}
function projection(token, expired = new Date(Date.now() + 3600_000).toISOString()) {
  const auth = { type: 'codex', access_token: token, account_id: 'fixture-account', expired, websockets: true };
  const target = path.join(home, 'auth', 'selected.json');
  fs.writeFileSync(target + '.tmp', JSON.stringify(auth), { mode: 0o600 });
  fs.renameSync(target + '.tmp', target);
}
(async () => {
  fs.mkdirSync(path.join(home, 'auth'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=chatgpt.com', '-addext', 'subjectAltName=DNS:chatgpt.com', '-keyout', path.join(home, 'key.pem'), '-out', path.join(home, 'cert.pem')], { stdio: 'ignore' });
  backend = http2.createSecureServer({ allowHTTP1: true, key: fs.readFileSync(path.join(home, 'key.pem')), cert: fs.readFileSync(path.join(home, 'cert.pem')) }, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    records.push({ transport: 'http', path: req.url, authorization: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
    if (upstreamStatus !== 200) { res.writeHead(upstreamStatus, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { type: 'fixture_error', message: 'fixture rejection' } })); return; }
    if (req.url.endsWith('/compact')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'response.compaction', id: 'cmp_fixture', output: [{ type: 'compaction', encrypted_content: 'fixture-opaque' }], usage: { input_tokens: 10, output_tokens: 2 } })); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const event of events(response())) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  backend.on('connection', track);
  wss = new WebSocketServer({ server: backend });
  wss.on('connection', (ws, req) => {
    ws.on('message', data => {
      records.push({ transport: 'ws', path: req.url, authorization: req.headers.authorization, body: JSON.parse(data) });
      for (const event of events(response())) ws.send(JSON.stringify(event));
    });
  });
  const tlsPort = await listen(backend);
  proxy = http.createServer((req, res) => { res.writeHead(502); res.end(); });
  proxy.on('connection', track);
  proxy.on('connect', (req, socket, head) => {
    connections.push(req.url);
    if (req.url !== 'chatgpt.com:443') { socket.end('HTTP/1.1 502 Blocked by fixture\r\n\r\n'); return; }
    const target = net.connect(tlsPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) target.write(head);
      socket.pipe(target); target.pipe(socket);
    });
    track(target);
    socket.on('error', () => target.destroy());
    target.on('error', () => socket.destroy());
    socket.on('close', () => target.destroy());
    target.on('close', () => socket.destroy());
  });
  const proxyPort = await listen(proxy);
  const reserve = net.createServer(); const apiPort = await listen(reserve); await new Promise(r => reserve.close(r));
  const config = {
    host: '127.0.0.1', port: apiPort, 'auth-dir': path.join(home, 'auth'),
    'api-keys': ['fixture-client-key'], 'proxy-url': `http://127.0.0.1:${proxyPort}`,
    'remote-management': { 'allow-remote': false, 'secret-key': '', 'disable-control-panel': true, 'disable-auto-update-panel': true },
    'commercial-mode': true, 'logging-to-file': false, 'request-log': false,
    'request-retry': 0, 'max-retry-credentials': 1, 'max-retry-interval': 0, 'disable-cooling': true,
    'quota-exceeded': { 'switch-project': false, 'switch-preview-model': false },
    'ws-auth': true, 'disable-image-generation': 'passthrough',
    'usage-statistics-enabled': false, plugins: { enabled: false },
    routing: { strategy: 'fill-first' }, streaming: { 'bootstrap-retries': 0 },
  };
  fs.writeFileSync(path.join(home, 'config.yaml'), JSON.stringify(config));
  projection('fixture-access-v1');
  child = spawn(binary, ['-local-model', '-config', path.join(home, 'config.yaml')], { cwd: home, env: { PATH: process.env.PATH, HOME: home, SSL_CERT_FILE: path.join(home, 'cert.pem') }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { childLog = (childLog + data).slice(-24000); });
  const base = `http://127.0.0.1:${apiPort}`;
  const headers = { Authorization: 'Bearer fixture-client-key', 'Content-Type': 'application/json' };
  async function call(route, body, overrides) {
    const res = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: overrides || headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(12000) });
    return { status: res.status, text: await res.text() };
  }
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await call('/v1/models'); if (r.status === 200 && r.text.includes('gpt-5.6-luna')) { ready = true; break; } } catch {}
    if (child.exitCode !== null) break;
    await sleep(250);
  }
  assert(ready, 'component not ready: ' + childLog); pass('access-only credential loads');
  assert.equal((await call('/v1/models', undefined, {})).status, 401); pass('API key required');
  const catalog = await call('/v1/models?client_version=0.153.4');
  assert.equal(catalog.status, 200); assert(catalog.text.includes('supported_reasoning_levels')); pass('Codex model catalog shape');
  const request = { model: 'gpt-5.6-luna', input: [{ role: 'user', content: 'fixture-only' }], instructions: 'fixture', reasoning: { effort: 'high' }, store: false };
  const json = await call('/v1/responses', request);
  assert.equal(json.status, 200, json.text); assert.equal(JSON.parse(json.text).status, 'completed');
  assert.equal(records.at(-1).authorization, 'Bearer fixture-access-v1'); pass('Responses JSON with projected access token');
  const sse = await call('/v1/responses', { ...request, stream: true });
  assert.equal(sse.status, 200, sse.text); assert(sse.text.includes('response.completed')); pass('Responses SSE terminal');
  const fakeEncrypted = Buffer.alloc(73, 42); fakeEncrypted[0] = 0x80; fakeEncrypted.fill(0, 1, 9);
  for (const [model, effort] of [['gpt-5.6-luna', 'max'], ['gpt-6-astra', 'max']]) {
    const advanced = { ...request, model, reasoning: { effort }, service_tier: 'priority',
      parallel_tool_calls: true, include: ['reasoning.encrypted_content'],
      text: { format: { type: 'json_schema', name: 'fixture', strict: true, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } } },
      tools: [{ type: 'function', name: 'fixture_function', parameters: { type: 'object', properties: {} } },
        { type: 'custom', name: 'fixture_custom', format: { type: 'text' } }],
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'fixture-only' }, { type: 'input_image', image_url: 'data:image/png;base64,ZmFrZQ==' }] },
        { type: 'reasoning', id: 'rs_fixture_reasoning', encrypted_content: fakeEncrypted.toString('base64url') },
        { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'fixture tool step' }] },
        { type: 'function_call', call_id: 'fixture_call', name: 'fixture_function', arguments: '{}' },
        { type: 'function_call_output', call_id: 'fixture_call', output: '{}' },
        { type: 'custom_tool_call', call_id: 'fixture_custom_call', name: 'fixture_custom', input: 'fixture' },
        { type: 'custom_tool_call_output', call_id: 'fixture_custom_call', output: 'fixture' }] };
    const result = await call('/v1/responses', advanced);
    assert.equal(result.status, 200, result.text);
    const forwarded = records.at(-1).body;
    for (const field of ['model', 'reasoning', 'service_tier', 'parallel_tool_calls', 'include', 'text', 'tools', 'input']) {
      assert.deepEqual(forwarded[field], advanced[field], `${model} ${field} must survive translation`);
    }
    pass(`${model} ${effort}: priority, image, schema, function/custom calls, phase and encrypted reasoning preserved`);
  }
  const ultra = await call('/v1/responses', { ...request, model: 'gpt-6-astra', reasoning: { effort: 'ultra' } });
  assert.equal(ultra.status, 400); pass('pinned component rejects ultra explicitly; gateway catalog must omit it');
  const compact = await call('/v1/responses/compact', request);
  assert.equal(compact.status, 200, compact.text); assert(compact.text.includes('fixture-opaque')); pass('compact opaque content');
  projection('fixture-access-v2');
  for (let i = 0; i < 30; i++) { await call('/v1/responses', request); if (records.at(-1).authorization === 'Bearer fixture-access-v2') break; await sleep(250); }
  assert.equal(records.at(-1).authorization, 'Bearer fixture-access-v2'); pass('atomic credential projection hot reload');
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/v1/responses', { headers });
  ws.on('error', () => {}); await once(ws, 'open');
  async function turn(body) {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { ws.off('message', receive); reject(new Error('WS terminal timeout')); }, 12000);
      function receive(raw) { const event = JSON.parse(raw); if (event.type === 'response.completed' || event.type === 'error') { clearTimeout(timeout); ws.off('message', receive); resolve(event); } }
      ws.on('message', receive); ws.send(JSON.stringify({ type: 'response.create', ...body }));
    });
  }
  const first = await turn(request); assert.equal(first.type, 'response.completed', JSON.stringify(first));
  const second = await turn({ ...request, previous_response_id: first.response.id, input: [{ role: 'user', content: 'continue-fixture' }] });
  assert.equal(second.type, 'response.completed', JSON.stringify(second)); pass('WebSocket two-turn continuation');
  ws.close(); await once(ws, 'close');
  projection('fixture-access-v3', new Date(Date.now() - 1000).toISOString());
  await sleep(6500);
  assert(!connections.some(host => host.includes('auth.openai.com'))); pass('expired access-only projection does not call OAuth refresh');
  const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'auth', 'selected.json')));
  assert.equal(onDisk.access_token, 'fixture-access-v3'); assert(!onDisk.refresh_token); pass('projection remains free of refresh tokens');
  const expiredResult = await call('/v1/responses', request);
  assert.equal(expiredResult.status, 503); pass('expired projection fails closed');
  projection('fixture-access-v4');
  for (let i = 0; i < 30; i++) { await call('/v1/responses', request); if (records.at(-1).authorization === 'Bearer fixture-access-v4') break; await sleep(250); }
  assert.equal(records.at(-1).authorization, 'Bearer fixture-access-v4'); pass('valid projection restores routing after expiry');
  if (process.env.CPA_GATEWAY_PROBE) {
    upstreamStatus = 200;
    await require(path.resolve(process.env.CPA_GATEWAY_PROBE)).run({ base, request, key: 'fixture-client-key' });
  }
  upstreamStatus = 400;
  assert.equal((await call('/v1/responses', request)).status, 400);
  upstreamStatus = 200;
  const afterBadRequest = await call('/v1/responses', request);
  assert.equal(afterBadRequest.status, 200, afterBadRequest.text); pass('valid request recovers after upstream 400');
  const before = records.length; upstreamStatus = 500;
  const failure = await call('/v1/responses', request); assert.equal(failure.status, 500, failure.text);
  assert.equal(records.length - before, 1); pass('no additional retry on upstream 500');
  upstreamStatus = 200;
  const afterServerError = await call('/v1/responses', request);
  assert.equal(afterServerError.status, 200, afterServerError.text); pass('valid request recovers after upstream 500 with cooling owned by gateway');
  assert(!fs.existsSync(path.join(home, 'logs')) || fs.readdirSync(path.join(home, 'logs')).length === 0); pass('raw error logs disabled');
  const report = { component: 'CLIProxyAPI v7.2.152 linux_amd64_no-plugin', assertions, requests: records.slice(0, 20).map(r => ({ transport: r.transport, path: r.path, inputCount: r.body?.input?.length, previousResponseId: r.body?.previous_response_id || null })), pending: ['real-account generation and refresh', 'actual Codex CLI tool/compact/resume', 'cross-key cache ownership', 'in-flight cancellation and hot reload under long-lived WS'] };
  fs.mkdirSync('output/api-proxy-g0', { recursive: true });
  fs.writeFileSync('output/api-proxy-g0/component-probe.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); console.error(childLog); process.exitCode = 1; }).finally(async () => {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), sleep(3000)]); if (child.exitCode === null) child.kill('SIGKILL'); }
  if (wss) for (const ws of wss.clients) ws.terminate();
  for (const socket of peers) socket.destroy();
  if (wss) wss.close();
  if (backend) backend.close();
  if (proxy) proxy.close();
  fs.rmSync(home, { recursive: true, force: true });
});
