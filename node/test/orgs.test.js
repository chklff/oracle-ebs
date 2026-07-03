'use strict';

const mockExecute = jest.fn();

jest.mock('../src/db', () => ({
  initPool: jest.fn(),
  closePool: jest.fn(),
  getPool: jest.fn(),
  healthCheck: jest.fn(),
  // Invoke the caller's fn with a fake connection whose execute is programmable.
  withConnection: (fn) => fn({ execute: (...args) => mockExecute(...args) }),
  oracledb: { BIND_OUT: 3003, NUMBER: 2010 },
}));

const request = require('supertest');
const { buildApp, AUTH_HEADER } = require('./helpers/testApp');

const app = buildApp();

describe('GET /orgs', () => {
  test('401 without the client secret', async () => {
    await request(app).get('/orgs').expect(401);
  });

  test('lists operating units', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [
        { ORG_ID: 101, NAME: 'US Operations' },
        { ORG_ID: 204, NAME: 'Germany GmbH' },
      ],
    });
    const res = await request(app).get('/orgs').set(AUTH_HEADER).expect(200);
    expect(res.body).toEqual([
      { org_id: 101, name: 'US Operations' },
      { org_id: 204, name: 'Germany GmbH' },
    ]);
  });
});
