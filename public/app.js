'use strict';
const $ = id => document.getElementById(id);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const fmt = (value, digits = 0) => finite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '—';
const compact = value => finite(value) ? value >= 1000 ? `${fmt(value / 1000, value >= 10000 ? 1 : 2).replace(/\.0$/, '')}k` : fmt(value) : '—';
const put = (id, value) => { const node = $(id); if (node) node.textContent = value ?? '—'; };
const pct = (used, max) => finite(used) && finite(max) && max > 0 ? Math.max(0, Math.min(100, used / max * 100)) : 0;
const memory = (used, total) => finite(used) && finite(total) ? `${fmt(used, 1)} / ${fmt(total, 1)} GiB` : '—';
const layers = value => Array.isArray(value) && value.length === 2 ? `${value[0]}–${value[1]}` : 'Unconfirmed';
const samples = [];

function badge(id, label, state = 'online') {
  const node = $(id); node.className = `badge ${state === 'online' || state === 'connected' ? '' : state === 'offline' || state === 'disconnected' ? 'error' : 'muted'}`;
  node.replaceChildren(document.createElement('i'), document.createTextNode(label));
}
function deviceStatus(prefix, connection) {
  const state = connection?.state ?? 'unknown';
  const node = $(`${prefix}-status`);
  node.textContent = state === 'online' ? '● Online' : state === 'offline' ? '● Offline' : '● Unknown';
  node.className = `status-label ${state}`;
  node.closest('.device').classList.toggle('stale', state !== 'online');
}
function blocks(id, assignment) {
  const node = $(id), key = JSON.stringify(assignment);
  if (node.dataset.assignment === key) return;
  node.dataset.assignment = key; node.replaceChildren();
  if (!Array.isArray(assignment)) return;
  const count = Math.min(64, assignment[1] - assignment[0] + 1);
  for (let i = 0; i < count; i++) { const block = document.createElement('span'); block.title = `Layer ${assignment[0] + i}`; node.append(block); }
}
function freshText(connection) {
  if (!connection?.lastSuccessAt) return 'No successful reading yet.';
  const at = new Date(connection.lastSuccessAt).toLocaleTimeString();
  return connection.state === 'online' ? `Last successful reading ${at} · ${fmt(connection.ageSeconds, 1)} seconds ago.` : `Last successful reading ${at}. Source unavailable; current readings are cleared.`;
}
function renderRequests(data) {
  const rows = Array.isArray(data.recentRequests) ? data.recentRequests : [];
  const table = $('requests'); table.replaceChildren();
  if (!rows.length) {
    const row = table.insertRow(), cell = row.insertCell(); cell.colSpan = 4; cell.className = 'empty'; cell.textContent = 'No request summaries available';
  }
  for (const request of rows) {
    const row = table.insertRow();
    const time = request.time ? new Date(request.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
    const duration = finite(request.durationSeconds) ? request.durationSeconds >= 60 ? `${Math.floor(request.durationSeconds / 60)}m ${Math.round(request.durationSeconds % 60)}s` : `${fmt(request.durationSeconds, 1)}s` : '—';
    for (const value of [time, fmt(request.outputTokens), finite(request.decodeTps) ? `${fmt(request.decodeTps, 1)} t/s` : '—', duration]) row.insertCell().textContent = value;
    row.title = `Prompt: ${fmt(request.promptTokens)} tokens · ${request.finish ?? 'completed'}`;
  }
  put('request-count', `${fmt(data.totals?.requests ?? rows.length)} total`);
  put('total-in', fmt(data.totals?.tokensIn)); put('total-out', fmt(data.totals?.tokensOut));
}
function render(data) {
  const primary = data.primary ?? {}, apex = data.apex ?? {}, link = data.link ?? {}, model = data.model ?? {}, live = data.inference ?? {};
  const primaryOnline = primary.connection?.state === 'online', apexOnline = apex.connection?.state === 'online';
  const connected = primaryOnline && link.state === 'connected';
  const active = primaryOnline && ['reading', 'generating', 'thinking'].includes(live.state);
  const generating = active && ['generating', 'thinking'].includes(live.state);
  const reachable = Number(primaryOnline) + Number(apexOnline);
  badge('connection-badge', `${reachable}/2 devices reachable`, reachable === 2 ? 'online' : reachable ? 'unknown' : 'offline');
  badge('link-status', connected ? 'Remote stage connected' : link.state === 'connecting' ? 'Connecting remote stage' : 'Remote stage unconfirmed', connected ? 'connected' : link.state);
  put('updated', `Updated ${new Date(data.sampledAt).toLocaleTimeString()}`);
  document.body.classList.toggle('active-phase', active);
  const names = { idle: 'Ready · idle', reading: 'Reading prompt', generating: 'Generating', thinking: 'Thinking', unloaded: 'Model unloaded', unavailable: 'Engine unavailable', loading: 'Loading model', error: 'Engine error' };
  put('phase', names[live.state] ?? 'Waiting for telemetry');
  put('phase-description', !primaryOnline ? 'The primary engine is not responding.' : live.state === 'idle' ? 'Model loaded. Waiting for the next client request.' : live.state === 'reading' ? 'The model is processing the input conversation.' : generating ? `The model is producing a response${connected ? ' across both devices' : ''}.` : 'Reading the running model state.');
  $('phase-dot').style.color = primaryOnline ? 'var(--primary)' : 'var(--red)';
  const progress = live.state === 'reading' ? pct(live.promptRead, live.promptTotal) : generating ? pct(live.generated, live.maxTokens) : 0;
  $('phase-progress').style.width = `${progress}%`;
  put('progress-label', live.state === 'reading' ? `${fmt(live.promptRead)} / ${fmt(live.promptTotal)} input tokens` : generating ? `${fmt(live.generated)} tokens generated` : finite(live.queued) && live.queued > 0 ? `${live.queued} queued` : 'No request in flight');
  const modelName = model.name ?? 'Model identity unavailable';
  put('model-name', modelName.replace('SC117-', '').replace('-abliterated-IQ3_XXS', ' · IQ3_XXS'));
  put('model-tag', model.mtpEnabled ? 'MTP configured' : 'Engine metrics');
  const speed = generating ? live.decodeTps ?? live.decodeMeanTps : primaryOnline ? data.lastRequest?.decodeTps : null;
  put('speed', fmt(speed, 1)); put('speed-source', generating ? 'Live' : finite(speed) ? 'Last request' : 'Unavailable');
  put('speed-detail', live.state === 'reading' && finite(live.prefillTps) ? `Input reading: ${fmt(live.prefillTps)} tok/s · output rate is from the last request` : 'Whole-model output, across both devices');
  samples.push(generating && finite(speed) ? speed : null); if (samples.length > 60) samples.shift();
  const maximum = Math.max(1, ...samples.filter(finite));
  const points = samples.map((value, index) => finite(value) ? `${index * 300 / Math.max(1, samples.length - 1)},${34 - value / maximum * 30}` : null).filter(Boolean).join(' ');
  $('speed-chart').querySelector('polyline').setAttribute('points', points);
  put('context-used', compact(live.tokensUsed)); put('context-max', `/ ${finite(live.contextMax) ? `${fmt(live.contextMax / 1024)}K` : '—'}`);
  $('context-progress').style.width = `${pct(live.tokensUsed, live.contextMax)}%`;
  put('context-detail', finite(live.tokensUsed) ? `${fmt(live.tokensUsed)} of ${fmt(live.contextMax)} tokens · ${fmt(pct(live.tokensUsed, live.contextMax))}% used` : 'No current context reading');
  deviceStatus('primary', primary.connection); deviceStatus('apex', apex.connection);
  put('primary-name', primary.name ?? 'Primary PC'); put('apex-name', apex.name ?? 'Remote worker');
  put('primary-hardware', [primary.gpu?.name, primary.cpu?.name].filter(Boolean).join(' · ') || 'Hardware identity unavailable');
  put('apex-hardware', [apex.gpu?.name, apex.cpu?.name].filter(Boolean).join(' · ') || 'Hardware identity unavailable');
  put('primary-layers', layers(model.localLayers)); put('apex-layers', layers(model.remoteLayers));
  blocks('primary-blocks', model.localLayers); blocks('apex-blocks', model.remoteLayers);
  put('primary-now', !primaryOnline ? 'Engine unavailable' : active ? `Active request · layers ${layers(model.localLayers)}, coordination & sampling` : 'Ready for the next request');
  put('apex-now', !apexOnline ? 'Worker agent unavailable' : apex.worker?.running === false ? 'Worker process stopped' : !connected ? 'Worker reachable · engine link unconfirmed' : active ? `Remote stage in active request · layers ${layers(model.remoteLayers)}` : 'Remote worker ready · waiting for activations');
  put('primary-gpu-load', finite(primary.gpu?.utilizationPct) ? `${fmt(primary.gpu.utilizationPct)}%` : '—');
  put('primary-vram', memory(primary.gpu?.memoryUsedGiB, primary.gpu?.memoryTotalGiB));
  put('primary-cpu-load', finite(primary.cpu?.utilizationPct) ? `${fmt(primary.cpu.utilizationPct)}%` : '—');
  put('primary-ram', memory(primary.memory?.usedGiB, primary.memory?.totalGiB));
  put('primary-temp', finite(primary.gpu?.tempC) ? `${fmt(primary.gpu.tempC)} °C` : 'Temperature unavailable');
  put('primary-power', finite(primary.gpu?.powerW) ? `${fmt(primary.gpu.powerW)} W GPU power` : 'Power unavailable');
  $('primary-memory-bar').style.width = `${pct(primary.gpu?.memoryUsedGiB, primary.gpu?.memoryTotalGiB)}%`;
  put('apex-worker', apex.worker?.running === true ? 'Running' : apex.worker?.running === false ? 'Stopped' : 'Unconfirmed');
  put('apex-ram', memory(apex.memory?.usedGiB, apex.memory?.totalGiB));
  put('apex-available', finite(apex.memory?.availableGiB) ? `${fmt(apex.memory.availableGiB, 1)} GiB` : '—');
  put('apex-ram-percent', finite(apex.memory?.usedGiB) ? `${fmt(pct(apex.memory.usedGiB, apex.memory.totalGiB))}%` : '—');
  $('apex-memory-bar').style.width = `${pct(apex.memory?.usedGiB, apex.memory?.totalGiB)}%`;
  put('primary-address', link.primaryAddress); put('apex-address', link.apexAddress);
  put('transport', link.transport ?? 'TCP'); put('worker-state', link.state === 'connected' ? 'Engine handshake confirmed' : link.state ?? 'Unknown');
  put('link-rtt', finite(link.apiHeartbeatMs) ? `${fmt(link.apiHeartbeatMs)} ms · agent HTTP` : 'Unavailable');
  $('link-graphic').classList.toggle('active', active && connected);
  put('local-role', `The primary GPU and CPU expert pool run layers ${layers(model.localLayers)}.`);
  put('remote-role', `The remote stage runs layers ${layers(model.remoteLayers)} and returns the final activation rows over the configured TCP link.`);
  put('sample-role', 'The primary engine runs the output head, chooses the next tokens, and streams the reply to the client.');
  put('mtp-role', model.mtpEnabled ? `Primary PC · ${model.mtp?.installed ? 'files installed' : 'file check incomplete'}${finite(model.mtpMax) ? ` · max ${model.mtpMax} drafts` : ''}` : 'Not enabled in this configuration');
  put('vision-role', model.vision?.enabled ? `${model.vision.device === 'primary CPU' ? 'Primary PC · CPU encoder' : 'Primary PC · GPU encoder'}${model.vision.mmprojInstalled ? ' · projector installed' : ''}` : 'Not enabled in this configuration');
  put('primary-freshness', freshText(primary.connection)); put('apex-freshness', freshText(apex.connection));
  const evidence = [...(data.evidence ?? []), link.transportEvidence, link.connectedEvidence, link.heartbeatNote,
    link.liveStageTimingAvailable ? 'Stage timing fields come from the engine. No per-device token rate is inferred.' : 'Per-stage compute timing is unavailable. No per-device token rate is inferred.'].filter(Boolean);
  $('evidence').replaceChildren(...evidence.map(value => { const item = document.createElement('li'); item.textContent = value; return item; }));
  renderRequests(data);
  const notices = [];
  if (!primaryOnline) notices.push('Primary engine telemetry is unavailable.');
  if (!apexOnline) notices.push('Remote agent telemetry is unavailable.');
  if (primaryOnline && !connected) notices.push('The primary engine has not confirmed the remote stage connection.');
  $('notice').hidden = !notices.length; $('notice').textContent = notices.join(' ');
}
async function refresh() {
  try {
    const response = await fetch('/api/status', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Unavailable');
    const data = await response.json(); if (data.schemaVersion !== 1) throw new Error('Unknown response');
    render(data);
  } catch {
    badge('connection-badge', 'Monitor disconnected', 'offline'); put('updated', 'Telemetry is not updating');
    $('notice').hidden = false; $('notice').textContent = 'The local monitor is not responding. Current readings are cleared; your model is managed separately.';
    $('link-graphic').classList.remove('active'); document.body.classList.remove('active-phase');
    for (const id of ['speed', 'context-used', 'primary-gpu-load', 'primary-vram', 'primary-cpu-load', 'primary-ram', 'primary-temp', 'primary-power', 'apex-worker', 'apex-ram', 'apex-available', 'apex-ram-percent', 'link-rtt']) put(id, '—');
    put('speed-source', 'Unavailable'); put('context-detail', 'No current context reading'); put('worker-state', 'Unconfirmed');
    $('speed-chart').querySelector('polyline').setAttribute('points', ''); $('phase-dot').style.color = 'var(--red)';
    put('phase', 'Telemetry unavailable'); put('phase-description', 'No current engine activity can be confirmed.');
    put('primary-now', 'Current state unavailable'); put('apex-now', 'Current state unavailable');
    for (const id of ['phase-progress', 'context-progress', 'primary-memory-bar', 'apex-memory-bar']) $(id).style.width = '0';
    deviceStatus('primary', {state:'unknown'}); deviceStatus('apex', {state:'unknown'});
    badge('link-status', 'Connection unconfirmed', 'unknown');
  } finally { setTimeout(refresh, 2000); }
}
refresh();
