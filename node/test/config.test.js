'use strict';

const { loadConfig } = require('../src/config');

const BASE = {
  EBS_DB_USER: 'u',
  EBS_DB_PASSWORD: 'p',
  EBS_DB_CONNECT_STRING: 'localhost/XE',
  CLIENT_SECRET: 's',
};

describe('loadConfig', () => {
  test('throws listing every missing required variable', () => {
    expect(() => loadConfig({})).toThrow(/EBS_DB_USER.*EBS_DB_PASSWORD.*EBS_DB_CONNECT_STRING.*CLIENT_SECRET/);
  });

  test('defaults to Thin mode', () => {
    const cfg = loadConfig(BASE);
    expect(cfg.db.thick).toBe(false);
    expect(cfg.db.clientLibDir).toBeUndefined();
  });

  test('enables Thick mode from truthy values', () => {
    for (const v of ['true', 'TRUE', '1', 'yes']) {
      expect(loadConfig({ ...BASE, EBS_DB_THICK: v }).db.thick).toBe(true);
    }
    for (const v of ['false', '0', 'no', '']) {
      expect(loadConfig({ ...BASE, EBS_DB_THICK: v }).db.thick).toBe(false);
    }
  });

  test('captures the client lib dir when provided', () => {
    const cfg = loadConfig({ ...BASE, EBS_DB_THICK: 'true', EBS_CLIENT_LIB_DIR: '/opt/oracle/lib' });
    expect(cfg.db.clientLibDir).toBe('/opt/oracle/lib');
  });
});
