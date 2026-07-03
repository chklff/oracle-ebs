'use strict';

const oracledb = require('oracledb');

// Return query rows as plain objects keyed by column name.
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
// Fetch CLOBs as strings so callers get plain values, not lob streams.
oracledb.fetchAsString = [oracledb.CLOB];

let pool = null;

/**
 * Create the shared connection pool. Idempotent: repeated calls return the
 * existing pool.
 */
async function initPool(config, logger) {
  if (pool) return pool;
  pool = await oracledb.createPool({
    user: config.db.user,
    password: config.db.password,
    connectString: config.db.connectString,
    poolMin: config.db.poolMin,
    poolMax: config.db.poolMax,
    poolIncrement: config.db.poolIncrement,
    poolTimeout: config.db.poolTimeout,
    queueTimeout: config.db.queueTimeout,
  });
  if (logger) {
    logger.info(
      { poolMin: config.db.poolMin, poolMax: config.db.poolMax },
      'oracle connection pool created',
    );
  }
  return pool;
}

function getPool() {
  if (!pool) throw new Error('Connection pool has not been initialised');
  return pool;
}

/**
 * Acquire a pooled connection, run fn(conn), and always release it back to the
 * pool. Any uncommitted work is rolled back by the driver on close.
 */
async function withConnection(fn) {
  const conn = await getPool().getConnection();
  try {
    return await fn(conn);
  } finally {
    try {
      await conn.close();
    } catch (_) {
      // Releasing a connection should never mask the original result/error.
    }
  }
}

/** Lightweight connectivity probe for GET /health. */
async function healthCheck() {
  return withConnection(async (conn) => {
    const result = await conn.execute('SELECT 1 AS ok FROM dual');
    return Array.isArray(result.rows) && result.rows.length === 1;
  });
}

async function closePool(logger) {
  if (!pool) return;
  await pool.close(10);
  pool = null;
  if (logger) logger.info('oracle connection pool closed');
}

module.exports = { initPool, getPool, withConnection, healthCheck, closePool, oracledb };
