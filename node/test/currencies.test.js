'use strict';

const mockExecute = jest.fn();

jest.mock('../src/db', () => ({
  initPool: jest.fn(),
  closePool: jest.fn(),
  getPool: jest.fn(),
  healthCheck: jest.fn(),
  withConnection: (fn) => fn({ execute: (...args) => mockExecute(...args) }),
  oracledb: { BIND_OUT: 3003, NUMBER: 2010 },
}));

const request = require('supertest');
const { buildApp, AUTH_HEADER } = require('./helpers/testApp');

const app = buildApp();

describe('GET /currencies', () => {
  test('401 without the client secret', async () => {
    await request(app).get('/currencies').expect(401);
  });

  test('lists enabled currencies', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [
        { CURRENCY_CODE: 'AED', NAME: 'UAE Dirham' },
        { CURRENCY_CODE: 'USD', NAME: 'US Dollar' },
      ],
    });
    const res = await request(app).get('/currencies').set(AUTH_HEADER).expect(200);
    expect(res.body).toEqual([
      { currency_code: 'AED', name: 'UAE Dirham' },
      { currency_code: 'USD', name: 'US Dollar' },
    ]);
  });
});
