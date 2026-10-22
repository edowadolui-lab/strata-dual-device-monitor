import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const server = createServer((request, response) => {
  const primary = request.url === '/metrics?workers=1';
  const authenticated = primary ? request.headers.authorization === 'Bearer synthetic-primary-key' :
    request.headers['x-stage-token'] === 'synthetic-stage-token';
  if (!authenticated) { response.writeHead(401); response.end(); return; }
  const payload = primary ? {
    engine: { model: 'Synthetic packaging fixture', version: 'test', max_context: 131072 },
    live: { state: 'idle', generated: 0 }, hardware: {}, hardware_static: {},
    stages: { local_layers: [0, 43], workers: [{ address: '192.168.50.2:7841', layers: [44, 47], state: 'connected' }] },
  } : { ok: true, ram: { total_mib: 24000, available_mib: 8000 }, ports: { '7841': { running: true } } };
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
});
server.listen(0, '127.0.0.1', () => writeFileSync(process.argv[2], JSON.stringify({ port: server.address().port })));
