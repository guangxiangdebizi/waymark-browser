import { loadConfig } from './config.js';
import { AuditLog } from './audit/AuditLog.js';
import { BrowserRuntime } from './browser/BrowserRuntime.js';
import { ChallengeBroker } from './challenge/ChallengeBroker.js';
import { startServer } from './server.js';
import { createCapabilities } from './capabilities/local.js';

const config = loadConfig();
const audit = new AuditLog(config.audit.directory);
const capabilities = await createCapabilities(config);
const runtime = new BrowserRuntime(config, audit, capabilities);
const challenges = new ChallengeBroker(runtime, config, capabilities);
await runtime.launch();
const server = await startServer(config, runtime, challenges);
await runtime.tabs('new', undefined, `http://${config.server.host}:${config.server.port}/home`);

async function shutdown() {
  await server.close();
  await runtime.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

