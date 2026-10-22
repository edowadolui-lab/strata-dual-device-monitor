import { pathToFileURL } from 'node:url';

try {
  const { createMonitor } = await import(pathToFileURL(process.argv[2]).href);
  let sourcesValidated = 0;
  const monitor = createMonitor({ configPath: process.argv[3], env: {}, fetchImpl: async () => {
    sourcesValidated++;
    throw new Error('Validation does not connect');
  } });
  await monitor.poll();
  monitor.close();
  if (sourcesValidated !== 2) throw new Error('Invalid configuration');
  console.log('Configuration is valid. No network request or model action was performed.');
} catch {
  console.error('Invalid configuration. Use loopback primary HTTP, private-IPv4 remote HTTP, IPv4:port stage peer, and non-empty credentials.');
  process.exitCode = 1;
}
