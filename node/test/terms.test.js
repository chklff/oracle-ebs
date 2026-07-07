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

describe('GET /terms', () => {
  test('401 without the client secret', async () => {
    await request(app).get('/terms').expect(401);
  });

  test('lists enabled payment terms', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [
        { TERM_ID: 10001, NAME: 'Immediate' },
        { TERM_ID: 10002, NAME: '30 Net (terms date + 30)' },
      ],
    });
    const res = await request(app).get('/terms').set(AUTH_HEADER).expect(200);
    expect(res.body).toEqual([
      { term_id: 10001, name: 'Immediate' },
      { term_id: 10002, name: '30 Net (terms date + 30)' },
    ]);
  });
});
