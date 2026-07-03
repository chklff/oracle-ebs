'use strict';

/**
 * Shared test harness. Builds the real Express app but against a mocked db
 * module so no Oracle instance is required.
 *
 * Usage in a test file:
 *   const { executeMock } = require('./helpers/testApp'); // must be required
 *   // ...after jest.mock('../src/db', ...) - see note below.
 *
 * Because jest.mock is hoisted per-file, each test file declares its own
 * jest.mock('../src/db') factory. This helper just centralises the app/config
 * construction and constants.
 */

const { createApp } = require('../../src/app');
const { createLogger } = require('../../src/logger');
const { loadConfig } = require('../../src/config');

const TEST_ENV = {
  EBS_DB_USER: 'make_ap_svc',
  EBS_DB_PASSWORD: 'secret',
  EBS_DB_CONNECT_STRING: 'localhost/XEPDB1',
  CLIENT_SECRET: 'test-secret',
  EBS_IMPORT_SOURCE: 'MAKE_API',
};

function buildApp() {
  const config = loadConfig(TEST_ENV);
  const logger = createLogger('silent');
  return createApp(config, logger);
}

const AUTH_HEADER = { 'X-Client-Secret': 'test-secret' };

module.exports = { buildApp, AUTH_HEADER, TEST_ENV };
