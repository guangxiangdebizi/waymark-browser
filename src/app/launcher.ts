import { startWaymark } from './start.js';

const { runtime, closed } = await startWaymark();
process.on('SIGINT', () => { void runtime.close(); });
process.on('SIGTERM', () => { void runtime.close(); });
await closed;
