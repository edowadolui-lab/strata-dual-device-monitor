import { createServer } from 'node:http';
import { readFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve, join, relative, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const HERE = dirname(fileURLToPath(import.meta.url));
const GIB = 1024 ** 3;
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const number = value => value === null || value === undefined || value === '' ? null :
  Number.isFinite(Number(value)) ? Number(value) : null;
const gib = value => finite(value) === null ? null : value / GIB;
const mibToGiB = value => finite(value) === null ? null : value / 1024;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const iso = time => Number.isFinite(time) ? new Date(time).toISOString() : null;
const ERROR = 'This monitoring source did not respond. No model action was taken.';

function range(value) {
  return Array.isArray(value) && value.length === 2 && value.every(item => Number.isInteger(item) && item >= 0)
    && value[1] >= value[0] ? [...value] : null;
}

function safeText(value, secrets, fallback = null) {
  if (typeof value !== 'string') return fallback;
  let text = value.slice(0, 240);
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
  return text;
}

function privateIPv4(host) {
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  return octets[0] === 10 || octets[0] === 192 && octets[1] === 168 ||
    octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 || octets[0] === 169 && octets[1] === 254;
}

function endpoint(value, localOnly = false) {
  const url = new URL(value);
  const host = url.hostname;
  if (url.protocol !== 'http:' || url.username || url.password || url.hash ||
    !(host === '127.0.0.1' || host === 'localhost' || !localOnly && privateIPv4(host))) throw new Error('configuration');
  return url.href;
}

function readConfiguration(configPath, root, env, rememberedSecrets) {
  const cfg = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  if (!record(cfg) || !record(cfg.primary) || !record(cfg.remote)) throw new Error('configuration');
  const apiKey = env.STRATA_API_KEY ?? cfg.primary.apiKey;
  const stageToken = env.STRATA_STAGE_TOKEN ?? cfg.remote.stageToken;
  if (typeof apiKey !== 'string' || !apiKey || typeof stageToken !== 'string' || !stageToken) throw new Error('configuration');
  for (const secret of [apiKey, stageToken]) if (!rememberedSecrets.includes(secret)) rememberedSecrets.push(secret);
  const primaryURL = endpoint(env.STRATA_METRICS_URL ?? cfg.primary.metricsURL, true);
  const stageURL = endpoint(env.STRATA_AGENT_URL ?? cfg.remote.agentURL);
  const peer = env.STRATA_REMOTE_PEER ?? cfg.remote.stagePeer;
  const match = /^(\d+\.\d+\.\d+\.\d+):(\d+)$/.exec(peer ?? '');
  if (!match || !privateIPv4(match[1])) throw new Error('configuration');
  const workerPort = Number(match[2]);
  if (workerPort < 1 || workerPort > 65535) throw new Error('configuration');
  const split = number(cfg.localLayerCount);
  const localPath = value => typeof value === 'string' && value ? resolve(root, value) : null;
  const mtpPath = localPath(cfg.mtp?.runtimeFolder);
  const draftPath = localPath(cfg.mtp?.draftModelFile);
  const mtpEnabled = cfg.mtp?.enabled === true;
  const vision = record(cfg.vision) ? cfg.vision : null;
  const mmprojPath = localPath(vision?.mmprojFile);
  return { primaryURL, primaryKey: apiKey, stageURL, stageToken,
    apexAddress: match[1], workerPort, peer, primaryAddress: cfg.primary.displayAddress ?? '127.0.0.1',
    remoteName: cfg.remote.name ?? 'Remote worker', remoteCpuName: cfg.remote.cpuName ?? null,
    remoteGpuName: cfg.remote.gpuName ?? null,
    transport: cfg.transportLabel ?? 'TCP', context: number(cfg.contextMax), split,
    mtp: { enabled: mtpEnabled, installed: !!mtpPath && existsSync(mtpPath) && !!draftPath && existsSync(draftPath),
      runtimeFolder: null, draftModelFile: null },
    vision: { enabled: vision?.enabled === true, device: vision ? vision.gpu === false ? 'primary CPU' : 'primary GPU' : null,
      threads: number(vision?.threads), maxImageTokens: number(vision?.max_tokens),
      mmprojInstalled: !!mmprojPath && existsSync(mmprojPath), mmprojFile: null } };
}

/** Polls only existing read-only APIs. Importing this module does not start a server or make requests. */
export function createMonitor({ root = HERE, env = process.env,
  configPath = env.STRATA_MONITOR_CONFIG ?? join(root, 'config.json'), fetchImpl = fetch, now = Date.now,
  intervalMs = 1500, timeoutMs = 1800, staleAfterMs = 6000 } = {}) {
  const sources = { primary: { value: null, lastAttempt: null, lastSuccess: null, ok: false, durationMs: null },
    apex: { value: null, lastAttempt: null, lastSuccess: null, ok: false, durationMs: null } };
  const secrets = [];
  const controllers = new Set();
  let config = null, timer = null, pending = null, closed = false;
  let knownLayers = { total: null, local: null, remote: null };

  async function readSource(name, url, headers, validate) {
    const source = sources[name];
    source.lastAttempt = now();
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    const started = performance.now();
    try {
      const response = await fetchImpl(url, { method: 'GET', headers: { ...headers, accept: 'application/json' },
        redirect: 'error', signal: controller.signal });
      if (!response.ok) throw new Error('unavailable');
      const value = await response.json();
      if (!validate(value)) throw new Error('unavailable');
      if (!closed) { source.value = value; source.ok = true; source.lastSuccess = now();
        source.durationMs = Math.round((performance.now() - started) * 10) / 10; }
    } catch { if (!closed) { source.ok = false; source.value = null; source.durationMs = null; } }
    finally { clearTimeout(timeout); controllers.delete(controller); }
  }

  function sourceView(source) {
    const age = source.lastSuccess === null ? null : Math.max(0, (now() - source.lastSuccess) / 1000);
    const stale = age !== null && age * 1000 > staleAfterMs;
    return { state: source.lastAttempt === null ? 'unknown' : source.ok && !stale ? 'online' : 'offline',
      lastAttemptAt: iso(source.lastAttempt), lastSuccessAt: iso(source.lastSuccess), ageSeconds: age, stale,
      error: source.lastAttempt !== null && (!source.ok || stale) ? ERROR : null };
  }

  function snapshot() {
    const primaryConnection = sourceView(sources.primary), apexConnection = sourceView(sources.apex);
    const raw = primaryConnection.state === 'online' ? sources.primary.value : null;
    const agent = apexConnection.state === 'online' ? sources.apex.value : null;
    const text = value => safeText(value, secrets);
    const live = raw?.live ?? {}, engine = raw?.engine ?? {}, hardware = raw?.hardware ?? {},
      identity = raw?.hardware_static ?? {};
    const worker = raw?.stages?.workers?.find(item => item.address === config?.peer) ?? null;
    const localLayers = range(raw?.stages?.local_layers) ?? knownLayers.local ??
      (Number.isInteger(config?.split) && config.split > 0 ? [0, config.split - 1] : null);
    const remoteLayers = range(worker?.layers) ?? knownLayers.remote;
    const totalLayers = remoteLayers ? remoteLayers[1] + 1 : knownLayers.total;
    const workerPort = config?.workerPort ?? 7841;
    const port = agent?.ports?.[String(workerPort)];
    const running = typeof port?.running === 'boolean' ? port.running :
      Array.isArray(agent?.workers) ? agent.workers.includes(workerPort) : null;
    const stageState = typeof worker?.state === 'string' ? text(worker.state) : 'unknown';
    const connected = stageState === 'connected' && running !== false;
    const linkState = connected ? 'connected' : stageState === 'unknown' ? 'unknown' :
      ['connecting', 'waiting'].includes(stageState) ? 'connecting' : 'disconnected';
    const recentRequests = (Array.isArray(raw?.requests) ? raw.requests : []).slice(0, 12).map(row => ({
      id: text(row.id), time: iso(number(row.time) === null ? NaN : number(row.time) * 1000),
      promptTokens: number(row.prompt_tokens), outputTokens: number(row.output_tokens),
      decodeTps: number(row.decode_tok_s), prefillTps: number(row.prompt_ms) > 0 && number(row.prompt_tokens) !== null
        ? Math.max(0, row.prompt_tokens - (number(row.reused) ?? 0)) / (row.prompt_ms / 1000) : null,
      durationSeconds: number(row.duration_s), finish: text(row.finish) }));
    const lastRequest = recentRequests[0] ?? null;
    const active = ['reading', 'generating', 'thinking'].includes(live.state);
    const promptTokens = number(live.prompt_tokens), generated = number(live.generated);
    const totalRam = number(agent?.ram?.total_mib), availableRam = number(agent?.ram?.available_mib);
    const mtp = config?.mtp ?? { enabled: false, installed: false, runtimeFolder: null, draftModelFile: null };
    const vision = config?.vision ?? { enabled: false, device: null, threads: null, maxImageTokens: null,
      mmprojInstalled: false, mmprojFile: null };
    const roleNotes = ['Primary runs the leading transformer layers and final token sampling.',
      remoteLayers ? `Remote worker is assigned transformer layers ${remoteLayers[0]}–${remoteLayers[1]}.` : 'Remote layer assignment is awaiting engine evidence.',
      mtp.enabled ? 'MTP drafting stays on the primary PC.' : 'MTP drafting is not configured.',
      vision.enabled ? `The image encoder runs on the ${vision.device}.` : 'The image encoder is not configured.'];
    const evidence = [];
    if (raw) evidence.push('Primary metrics were read from the running Strata engine.');
    if (worker) evidence.push(`The primary engine reports the remote stage as ${stageState}.`);
    if (agent) evidence.push(`Remote agent reports worker port ${workerPort} ${running ? 'running' : running === false ? 'stopped' : 'unknown'}.`);
    evidence.push('AMD GPU utilization, temperature and power are not supplied by the current remote agent.');
    return { schemaVersion: 1, sampledAt: iso(now()),
      inference: { state: raw ? text(live.state) ?? 'unknown' : 'unavailable', phase: text(live.phase),
        promptRead: number(live.prompt_read), promptTotal: number(live.prompt_total), promptTokens,
        generated, maxTokens: number(live.max_tokens), decodeTps: number(live.tok_s),
        decodeMeanTps: number(live.tok_s_mean), prefillTps: number(live.prefill_tok_s_mean),
        elapsedSeconds: number(live.elapsed_s), contextMax: number(engine.max_context) ?? config?.context ?? null,
        tokensUsed: active && promptTokens !== null && generated !== null ? promptTokens + generated :
          lastRequest && lastRequest.promptTokens !== null && lastRequest.outputTokens !== null
            ? lastRequest.promptTokens + lastRequest.outputTokens : null,
        queued: number(live.queued), running: number(live.running) ?? (raw ? active ? 1 : 0 : null) },
      model: { name: text(engine.model), engineVersion: text(engine.version ?? engine.engine),
        mtpEnabled: mtp.enabled, mtpMax: number(engine.mtp_max), mtp, vision,
        totalLayers, localLayers, remoteLayers,
        offloadedBlocks: connected && remoteLayers ? remoteLayers[1] - remoteLayers[0] + 1 : 0,
        configuredOffloadedBlocks: remoteLayers ? remoteLayers[1] - remoteLayers[0] + 1 : null,
        layerAssignmentSource: raw?.stages ? 'engine metrics' : config ? 'configuration / previously reported engine metadata' : null },
      primary: { name: 'Primary PC', role: 'Coordinator, leading layers and sampling', connection: primaryConnection,
        cpu: { name: text(identity.cpu_name), logicalCores: number(identity.threads), utilizationPct: number(hardware.cpu) },
        memory: { usedGiB: gib(hardware.ram_used), totalGiB: gib(hardware.ram_total) },
        gpu: { name: text(identity.gpu_name), utilizationPct: number(hardware.gpu_util),
          memoryUsedGiB: gib(hardware.gpu_mem_used), memoryTotalGiB: gib(hardware.gpu_mem_total),
          tempC: number(hardware.gpu_temp), powerW: number(hardware.gpu_power), powerLimitW: number(hardware.gpu_power_limit),
          pcieRxMBs: number(hardware.gpu_pcie_rx_mb), telemetryAvailable: !!raw,
          expertCacheGiB: mibToGiB(number(engine.expert_cache_primary_mib ?? engine.expert_cache_mib)) } },
      apex: { name: text(config?.remoteName) ?? 'Remote worker', hostname: null, role: 'Remote transformer stage', connection: apexConnection,
        cpu: { name: text(config?.remoteCpuName), logicalCores: number(agent?.cpus), utilizationPct: null,
          identitySource: 'Operator configuration; not a GPU sensor reading' },
        memory: { usedGiB: totalRam !== null && availableRam !== null ? (totalRam - availableRam) / 1024 : null,
          availableGiB: mibToGiB(availableRam), totalGiB: mibToGiB(totalRam),
          note: 'OS-visible CPU memory. A reserved GPU allocation is not added to this total.' },
        gpu: { name: text(config?.remoteGpuName), identitySource: 'Operator configuration; not a GPU sensor reading', telemetryAvailable: false,
          utilizationPct: null, memoryUsedGiB: null, memoryTotalGiB: null, tempC: null, powerW: null, powerLimitW: null },
        worker: { running, state: stageState, layers: remoteLayers, restarts: number(port?.restarts) } },
      link: { transport: text(config?.transport) ?? 'TCP', transportEvidence: 'Transport label is operator-supplied; no bandwidth benchmark is run.',
        primaryAddress: text(config?.primaryAddress), apexAddress: config?.apexAddress ?? null,
        workerAddress: config?.peer ?? null, state: linkState,
        connectedEvidence: connected ? 'Primary engine reports a connected remote stage; remote worker is not reported stopped.' :
          'A connected remote stage is not currently confirmed.',
        apiHeartbeatMs: apexConnection.state === 'online' ? sources.apex.durationMs : null,
        heartbeatNote: 'Agent HTTP response time, including agent work; not network wire latency.',
        roundTripMs: number(worker?.round_trip_ms), workerMs: number(worker?.worker_ms), linkMs: number(worker?.link_ms),
        liveStageTimingAvailable: !!raw?.stages?.timing, reconnects: number(worker?.reconnects) },
      recentRequests, lastRequest,
      totals: { requests: number(raw?.totals?.requests), tokensIn: number(raw?.totals?.prompt_tokens),
        tokensOut: number(raw?.totals?.output_tokens) }, roleNotes, evidence };
  }

  function poll() {
    if (closed) return Promise.resolve(snapshot());
    if (pending) return pending;
    pending = (async () => {
      try { config = readConfiguration(configPath, root, env, secrets); }
      catch {
        for (const source of Object.values(sources)) { source.lastAttempt = now(); source.ok = false; source.value = null; }
        return snapshot();
      }
      await Promise.all([
        readSource('primary', config.primaryURL, { authorization: `Bearer ${config.primaryKey}` },
          value => record(value) && record(value.engine) && record(value.live)),
        readSource('apex', config.stageURL, { 'X-Stage-Token': config.stageToken },
          value => record(value) && value.ok === true && record(value.ram)),
      ]);
      const raw = sources.primary.ok ? sources.primary.value : null;
      const worker = raw?.stages?.workers?.find(item => item.address === config.peer);
      const local = range(raw?.stages?.local_layers), remote = range(worker?.layers);
      if (local) knownLayers.local = local;
      if (remote) { knownLayers.remote = remote; knownLayers.total = remote[1] + 1; }
      return snapshot();
    })().finally(() => { pending = null; });
    return pending;
  }

  function start() {
    if (closed || timer) return pending ?? Promise.resolve(snapshot());
    timer = setInterval(() => { void poll(); }, Math.max(1000, Number(intervalMs) || 1500));
    timer.unref?.();
    return poll();
  }

  function close() {
    closed = true;
    clearInterval(timer); timer = null;
    for (const controller of controllers) controller.abort();
  }
  return { start, close, poll, snapshot };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

export function createAppServer({ monitor = createMonitor(), publicDir = join(HERE, 'public') } = {}) {
  const publicRoot = resolve(publicDir);
  const server = createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const host = /^(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/i.exec(request.headers.host ?? '');
    const boundPort = server.address()?.port;
    if (!host || Number(host[2] ?? 80) !== boundPort) {
      response.writeHead(403); response.end('Local dashboard host required'); return;
    }
    if (request.method !== 'GET') { response.writeHead(405, { Allow: 'GET' }); response.end('Read-only monitor'); return; }
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/api/status') {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(monitor.snapshot())); return;
      }
      if (url.pathname === '/api/health') {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ service: 'strata-dual-device-monitor', version: 1, appVersion: '0.1.0',
          copyright: 'Copyright (c) 2026 edowadolui-lab', readOnly: true })); return;
      }
      if (url.pathname.startsWith('/api/')) { response.writeHead(404); response.end('Not found'); return; }
      const decoded = decodeURIComponent(url.pathname);
      if (decoded.includes('\\') || decoded.includes('\0')) throw new Error('path');
      const candidate = resolve(publicRoot, decoded === '/' ? 'index.html' : `.${decoded}`);
      const actual = realpathSync(candidate);
      const inside = relative(realpathSync(publicRoot), actual);
      if (inside.startsWith('..') || inside.includes(':') || !statSync(actual).isFile()) throw new Error('path');
      response.writeHead(200, { 'Content-Type': MIME[extname(actual).toLowerCase()] ?? 'application/octet-stream' });
      response.end(readFileSync(actual));
    } catch { response.writeHead(404); response.end('Not found'); }
  });
  server.on('close', () => monitor.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const monitor = createMonitor();
  const server = createAppServer({ monitor });
  const port = Number(process.env.STRATA_MONITOR_PORT ?? 47832);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid monitor port.');
  server.on('error', () => {
    monitor.close();
    console.error('Dual-device monitor could not open its local port.');
    process.exitCode = 1;
  });
  await monitor.start();
  server.listen(port, '127.0.0.1', () => console.log(`Dual-device monitor: http://127.0.0.1:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { monitor.close(); server.close(); });
}
