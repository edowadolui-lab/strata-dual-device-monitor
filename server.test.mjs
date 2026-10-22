import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createMonitor, createAppServer } from './server.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'strata-dual-monitor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const apiKey = 'private-api-key-never-public-321', stageToken = 'private-stage-token-never-public-987';
  const mtp = join(root, 'Strata-data', 'mtp', 'rt');
  mkdirSync(mtp, { recursive: true });
  writeFileSync(join(mtp, '..', 'mtp-q2_0.gguf'), 'fixture');
  const mmproj = join(root, 'Strata-Models', 'mmproj.gguf');
  mkdirSync(join(root, 'Strata-Models'));
  writeFileSync(mmproj, 'fixture');
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    primary: { metricsURL: 'http://127.0.0.1:8081/metrics?workers=1', apiKey },
    remote: { agentURL: 'http://192.168.50.2:7840/info', stagePeer: '192.168.50.2:7841', stageToken,
      name: 'Remote test', cpuName: 'Test CPU', gpuName: 'Test GPU' },
    transportLabel: 'TCP over USB4', contextMax: 32768, localLayerCount: 44,
    mtp: { enabled: true, runtimeFolder: mtp, draftModelFile: join(mtp, '..', 'mtp-q2_0.gguf') },
    vision: { enabled: true, gpu: false, threads: 8, max_tokens: 300, mmprojFile: mmproj } }));
  return { root, apiKey, stageToken };
}

function primary(extra = {}) {
  return { engine: { model: 'test SC117', version: '0.1.45.3', max_context: 32768, mtp_max: 4 },
    live: { state: 'generating', prompt_tokens: 120, generated: 30, tok_s: 54.2, tok_s_mean: 53.1,
      prefill_tok_s_mean: 350, prompt_read: 120, prompt_total: 120, queued: 0 },
    hardware: { gpu_util: 85, gpu_mem_used: 11 * 1024 ** 3, gpu_mem_total: 12 * 1024 ** 3,
      ram_used: 50 * 1024 ** 3, ram_total: 64 * 1024 ** 3, gpu_temp: 55, gpu_power: 72, cpu: 40 },
    hardware_static: { gpu_name: 'RTX test', cpu_name: 'Intel test', threads: 16 },
    stages: { local_layers: [0, 43], timing: false,
      workers: [{ address: '192.168.50.2:7841', state: 'connected', layers: [44, 47], reconnects: 0 }] },
    requests: [{ id: 'request-1', time: 1792636523, prompt_tokens: 100, output_tokens: 40,
      decode_tok_s: 51.5, prompt_ms: 200, reused: 10, duration_s: 1.2, finish: 'stop' }],
    totals: { requests: 1, prompt_tokens: 100, output_tokens: 40 }, ...extra };
}
function apex(extra = {}) {
  return { ok: true, host: 'APEX test', cpus: 32, gpus: [],
    ram: { total_mib: 24 * 1024, available_mib: 8 * 1024 }, workers: [7841],
    ports: { '7841': { running: true, restarts: 0 } }, ...extra };
}
const response = value => ({ ok: true, json: async () => value });

test('combines GET-only sources and reports measured roles without invented AMD telemetry', async t => {
  const { root, apiKey, stageToken } = fixture(t);
  const calls = [];
  const monitor = createMonitor({ root, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return response(url.includes(':8081') ? primary() : apex());
  } });
  t.after(() => monitor.close());
  const status = await monitor.poll();
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.options.method === 'GET'));
  assert.equal(calls[0].options.headers.authorization, `Bearer ${apiKey}`);
  assert.equal(calls[1].options.headers['X-Stage-Token'], stageToken);
  assert.ok(calls.every(call => call.options.redirect === 'error'));
  assert.equal(status.primary.connection.state, 'online');
  assert.equal(status.apex.connection.state, 'online');
  assert.equal(status.primary.gpu.memoryUsedGiB, 11);
  assert.equal(status.apex.memory.totalGiB, 24);
  assert.equal(status.apex.memory.usedGiB, 16);
  assert.equal(status.apex.gpu.utilizationPct, null);
  assert.equal(status.apex.gpu.telemetryAvailable, false);
  assert.equal(status.link.state, 'connected');
  assert.equal(status.link.workerMs, null);
  assert.equal(status.link.linkMs, null);
  assert.equal(status.model.offloadedBlocks, 4);
  assert.deepEqual(status.model.localLayers, [0, 43]);
  assert.deepEqual(status.model.remoteLayers, [44, 47]);
  assert.equal(status.model.totalLayers, 48);
  assert.equal(status.model.mtpEnabled, true);
  assert.equal(status.model.mtp.installed, true);
  assert.equal(status.model.vision.device, 'primary CPU');
  assert.equal(status.model.vision.mmprojInstalled, true);
  assert.equal(status.inference.tokensUsed, 150);
  assert.equal(status.recentRequests[0].prefillTps, 450);
  assert.equal(status.lastRequest.decodeTps, 51.5);
  assert.deepEqual(status.totals, { requests: 1, tokensIn: 100, tokensOut: 40 });
  status.primary.gpu.utilizationPct = 999;
  assert.equal(monitor.snapshot().primary.gpu.utilizationPct, 85);
});

test('idle shows previous request usage separately from null current speed', async t => {
  const { root } = fixture(t);
  const monitor = createMonitor({ root, fetchImpl: async url => response(url.includes(':8081') ?
    primary({ live: { state: 'idle', tok_s: null, prompt_tokens: null, generated: null } }) : apex()) });
  t.after(() => monitor.close());
  const status = await monitor.poll();
  assert.equal(status.inference.state, 'idle');
  assert.equal(status.inference.decodeTps, null);
  assert.equal(status.inference.tokensUsed, 140);
  assert.equal(status.lastRequest.decodeTps, 51.5);
});

test('source failures and expired samples clear current readings and connected claims', async t => {
  const { root, apiKey } = fixture(t);
  let clock = 100000, failPrimary = false;
  const monitor = createMonitor({ root, now: () => clock, staleAfterMs: 3000,
    fetchImpl: async url => {
      if (url.includes(':8081') && failPrimary) throw new Error(apiKey);
      return response(url.includes(':8081') ? primary() : apex());
    } });
  t.after(() => monitor.close());
  await monitor.poll();
  clock += 4000;
  const stale = monitor.snapshot();
  assert.equal(stale.primary.connection.stale, true);
  assert.equal(stale.primary.connection.state, 'offline');
  assert.equal(stale.primary.gpu.utilizationPct, null);
  assert.equal(stale.inference.state, 'unavailable');
  assert.equal(stale.model.offloadedBlocks, 0);
  assert.equal(stale.link.state, 'unknown');
  failPrimary = true;
  await monitor.poll();
  const failed = monitor.snapshot();
  assert.equal(failed.primary.connection.state, 'offline');
  assert.equal(failed.apex.connection.state, 'online');
  assert.equal(failed.primary.gpu.powerW, null);
  assert.equal(JSON.stringify(failed).includes(apiKey), false);
});

test('APEX stopped worker or an unrelated connected peer does not count as offloaded blocks', async t => {
  const { root } = fixture(t);
  let unrelated = false;
  const monitor = createMonitor({ root, fetchImpl: async url => response(url.includes(':8081') ?
    primary(unrelated ? { stages: { workers: [{ address: '10.0.0.99:7841', state: 'connected', layers: [44, 47] }] } } : {}) :
    apex({ ports: { '7841': { running: false, restarts: 1 } }, workers: [] })) });
  t.after(() => monitor.close());
  let status = await monitor.poll();
  assert.equal(status.apex.worker.running, false);
  assert.equal(status.model.offloadedBlocks, 0);
  assert.notEqual(status.link.state, 'connected');
  unrelated = true;
  status = await monitor.poll();
  assert.equal(status.apex.worker.state, 'unknown');
  assert.equal(status.model.offloadedBlocks, 0);
});

test('allowlisted projection redacts echoed secrets and ignores raw private objects', async t => {
  const { root, apiKey, stageToken } = fixture(t);
  const monitor = createMonitor({ root, fetchImpl: async url => response(url.includes(':8081') ?
    primary({ engine: { model: `echo ${apiKey}` }, authorization: apiKey,
      env: { STRATA_STAGE_TOKEN: stageToken }, requests: [{ id: stageToken, prompt: 'private prompt', time: 1 }] }) :
    apex({ host: `echo ${stageToken}`, args: ['--private', apiKey] })) });
  t.after(() => monitor.close());
  const json = JSON.stringify(await monitor.poll());
  assert.equal(json.includes(apiKey), false);
  assert.equal(json.includes(stageToken), false);
  assert.equal(json.includes('private prompt'), false);
  assert.equal(json.includes('STRATA_STAGE_TOKEN'), false);
  assert.equal(json.includes(root.replaceAll('\\', '\\\\')), false);
});

test('missing configuration is safe and single-flight close aborts outstanding GET calls', async t => {
  const { root } = fixture(t);
  let calls = 0;
  const missing = createMonitor({ root, configPath: join(root, 'missing.json'), fetchImpl: () => { calls++; } });
  const absent = await missing.poll();
  assert.equal(calls, 0);
  assert.equal(absent.primary.connection.state, 'offline');
  missing.close();
  const signals = [], releases = [];
  const monitor = createMonitor({ root, fetchImpl: async (url, options) => {
    calls++; signals.push(options.signal);
    return new Promise(resolve => releases.push(() => resolve(response(url.includes(':8081') ? primary() : apex()))));
  } });
  const first = monitor.poll(), second = monitor.poll();
  assert.equal(first, second);
  assert.equal(calls, 2);
  monitor.close();
  assert.ok(signals.every(signal => signal.aborted));
  releases.forEach(release => release());
  await first;
  assert.equal(monitor.snapshot().primary.connection.state, 'offline');
  await monitor.poll();
  assert.equal(calls, 2);
});

test('HTTP server exposes only cached GET status and contained static files', async t => {
  const { root } = fixture(t);
  const publicDir = join(root, 'public'); mkdirSync(publicDir);
  writeFileSync(join(publicDir, 'index.html'), '<html>monitor fixture</html>');
  writeFileSync(join(root, 'private.txt'), 'must-not-serve');
  let closed = false;
  const monitor = { snapshot: () => ({ schemaVersion: 1, safe: true }), close: () => { closed = true; } };
  const server = createAppServer({ monitor, publicDir });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /monitor fixture/);
  const status = await fetch(`${origin}/api/status`);
  assert.deepEqual(await status.json(), { schemaVersion: 1, safe: true });
  assert.equal(status.headers.get('access-control-allow-origin'), null);
  const rebindingStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}/api/status`, { headers: { host: 'attacker.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.on('error', reject); request.end();
  });
  assert.equal(rebindingStatus, 403);
  const health = await fetch(`${origin}/api/health`);
  assert.deepEqual(await health.json(), { service: 'strata-dual-device-monitor', version: 1, readOnly: true });
  for (const path of ['/private.txt', '/%2e%2e%2fprivate.txt', '/%2e%2e%5cprivate.txt', '/api/stop']) {
    assert.equal((await fetch(`${origin}${path}`)).status, 404);
  }
  const mutation = await fetch(`${origin}/api/status`, { method: 'POST' });
  assert.equal(mutation.status, 405);
  assert.equal(mutation.headers.get('allow'), 'GET');
  await new Promise(resolve => server.close(resolve));
  assert.equal(closed, true);
});

test('environment overrides select endpoints and secrets without disclosing them', async t => {
  const { root } = fixture(t);
  const calls = [];
  const env = { STRATA_API_KEY: 'override-api-key', STRATA_STAGE_TOKEN: 'override-stage-token',
    STRATA_METRICS_URL: 'http://localhost:8082/metrics?workers=1',
    STRATA_AGENT_URL: 'http://192.168.50.3:7840/info', STRATA_REMOTE_PEER: '192.168.50.3:7841' };
  const monitor = createMonitor({ root, env, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return response(url.includes(':8082') ? primary({ stages: { local_layers: [0, 43],
      workers: [{ address: '192.168.50.3:7841', state: 'connected', layers: [44, 47] }] } }) : apex());
  } });
  t.after(() => monitor.close());
  const status = await monitor.poll();
  assert.equal(calls[0].url, env.STRATA_METRICS_URL);
  assert.equal(calls[1].url, env.STRATA_AGENT_URL);
  assert.equal(calls[0].options.headers.authorization, 'Bearer override-api-key');
  assert.equal(calls[1].options.headers['X-Stage-Token'], 'override-stage-token');
  assert.equal(status.link.state, 'connected');
  assert.equal(status.apex.cpu.name, 'Test CPU');
  assert.equal(status.apex.gpu.name, 'Test GPU');
  assert.equal(status.apex.hostname, null);
  assert.equal(JSON.stringify(status).includes('override-api-key'), false);
});

test('invalid endpoint and missing credentials block outgoing requests', async t => {
  const { root } = fixture(t);
  for (const env of [
    { STRATA_METRICS_URL: 'http://198.51.100.5:8081/metrics' },
    { STRATA_AGENT_URL: 'http://198.51.100.5:7840/info' },
    { STRATA_AGENT_URL: 'http://name.example:7840/info' },
    { STRATA_METRICS_URL: 'http://user:password@127.0.0.1:8081/metrics' },
    { STRATA_REMOTE_PEER: '198.51.100.5:7841' },
    { STRATA_API_KEY: '' },
    { STRATA_STAGE_TOKEN: '' },
  ]) {
    let calls = 0;
    const monitor = createMonitor({ root, env, fetchImpl: () => { calls++; } });
    const status = await monitor.poll();
    assert.equal(calls, 0);
    assert.equal(status.primary.connection.state, 'offline');
    monitor.close();
  }
});
