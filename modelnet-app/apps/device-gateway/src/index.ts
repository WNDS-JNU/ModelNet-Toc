import { createAuthenticator } from './auth.js';
import { startGatewayServer } from './app.js';
import { loadGatewayConfig } from './config.js';
import { consoleLogger } from './logger.js';

const config = loadGatewayConfig();
const authenticator = createAuthenticator(config);
const started = await startGatewayServer({ authenticator, config, logger: consoleLogger });

consoleLogger.info('device gateway listening', { host: config.host, port: started.port });

const shutdown = async () => {
  consoleLogger.info('device gateway shutting down');
  await started.close();
  process.exit(0);
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
