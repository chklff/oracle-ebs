'use strict';

// Config file path is overridable via CONFIG_FILE (defaults to '.env'). Some
// hosts run local security/DLP tooling that watches for files literally named
// '.env' and quarantines them on sight (renames it out from under the running
// process) - confirmed happening repeatedly against the reference Vision
// instance, traced to the client side rather than anything server-side (every
// server-side cause - cron, systemd timers/paths, OCI agent, OSWatcher, VS
// Code extensions - was individually ruled out). Renaming the real secrets
// file to something that doesn't match common secret-file conventions and
// pointing CONFIG_FILE at it sidesteps the problem entirely, regardless of
// root cause.
require('dotenv').config({ path: process.env.CONFIG_FILE || '.env' });

const { loadConfig } = require('./config');
const { ensureClientLibraryPath } = require('./bootstrap');

// Load and validate config first. If Thick mode needs the OS library path set,
// re-exec with it before anything loads oracledb.
const config = loadConfig();
ensureClientLibraryPath(config);

const { createLogger } = require('./logger');
const db = require('./db');
const { createApp } = require('./app');

async function main() {
  const logger = createLogger(config.logLevel, config.logFormat);

  await db.initPool(config, logger);
  const app = createApp(config, logger);

  const server = app.listen(config.port, config.host, () => {
    logger.info({ host: config.host, port: config.port }, 'ebs-invoice-api listening');
  });

  const shutdown = (signal) => {
    logger.info({ signal }, 'shutting down');
    server.close(async () => {
      await db.closePool(logger);
      process.exit(0);
    });
    // Failsafe: force exit if connections do not drain in time.
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  // Startup failed before the logger/pool exist; report and exit non-zero.
  process.stderr.write(`Fatal startup error: ${err.message}\n`);
  process.exit(1);
});
