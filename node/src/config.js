'use strict';

/**
 * Centralised configuration, loaded once from the environment.
 *
 * Validation fails fast at startup so the service never boots half-configured.
 * Everything is read from process.env by default, but loadConfig accepts an
 * explicit env object to make it trivial to test.
 */

const REQUIRED = ['EBS_DB_USER', 'EBS_DB_PASSWORD', 'EBS_DB_CONNECT_STRING', 'CLIENT_SECRET'];

function intOr(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function intOrUndefined(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((key) => !env[key] || String(env[key]).trim() === '');
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    host: env.HOST || '127.0.0.1',
    port: intOr(env.PORT, 3000),
    logLevel: env.LOG_LEVEL || 'info',
    // 'pretty' (default) = human-readable lines; 'json' = machine-readable.
    logFormat: /^json$/i.test(String(env.LOG_FORMAT || '').trim()) ? 'json' : 'pretty',
    clientSecret: env.CLIENT_SECRET,
    db: {
      user: env.EBS_DB_USER,
      password: env.EBS_DB_PASSWORD,
      connectString: env.EBS_DB_CONNECT_STRING,
      // Thin mode by default. Set EBS_DB_THICK=true for instances that enforce
      // Oracle Native Network Encryption (ORA-12660), which Thin cannot do.
      // Thick mode loads Oracle Instant Client from EBS_CLIENT_LIB_DIR (or the
      // default library search path if unset).
      thick: /^(true|1|yes)$/i.test(String(env.EBS_DB_THICK || '').trim()),
      clientLibDir: env.EBS_CLIENT_LIB_DIR && env.EBS_CLIENT_LIB_DIR.trim() !== ''
        ? env.EBS_CLIENT_LIB_DIR.trim()
        : undefined,
      poolMin: intOr(env.EBS_POOL_MIN, 1),
      poolMax: intOr(env.EBS_POOL_MAX, 4),
      poolIncrement: intOr(env.EBS_POOL_INCREMENT, 1),
      poolTimeout: intOr(env.EBS_POOL_TIMEOUT, 60),
      queueTimeout: intOr(env.EBS_QUEUE_TIMEOUT, 60000),
    },
    query: {
      defaultLimit: intOr(env.DEFAULT_QUERY_LIMIT, 50),
      maxLimit: intOr(env.MAX_QUERY_LIMIT, 500),
    },
    // Payables Open Interface Import settings (POST /invoices). See README.
    import: {
      programApplication: env.EBS_IMPORT_PROGRAM_APP || 'SQLAP',
      programShortName: env.EBS_IMPORT_PROGRAM_SHORT || 'APXIIMPT',
      source: env.EBS_IMPORT_SOURCE || 'MAKE_API',
      // APXIIMPT's "Batch Name" SRS parameter is required but has no effect
      // when AP_USE_INV_BATCH_CONTROLS is off (the common case) - see
      // importRepository.js for how this default was derived.
      batchName: env.EBS_IMPORT_BATCH_NAME || 'N/A',
      appsUserId: intOrUndefined(env.EBS_APPS_USER_ID),
      responsibilityId: intOrUndefined(env.EBS_APPS_RESP_ID),
      responsibilityApplId: intOrUndefined(env.EBS_APPS_RESP_APPL_ID),
    },
  };
}

module.exports = { loadConfig, REQUIRED };
