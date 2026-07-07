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

describe('GET /invoices/dff-schema', () => {
  test('401 without the client secret', async () => {
    await request(app).get('/invoices/dff-schema').expect(401);
  });

  test('groups column usages under their context', async () => {
    mockExecute
      .mockResolvedValueOnce({
        rows: [
          { CONTEXT_CODE: 'Global Data Elements', CONTEXT_NAME: 'Global Data Elements', ENABLED_FLAG: 'Y' },
          { CONTEXT_CODE: 'One-Time', CONTEXT_NAME: 'One-Time', ENABLED_FLAG: 'Y' },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            CONTEXT_CODE: 'One-Time',
            COLUMN_NAME: 'ATTRIBUTE5',
            LABEL: 'Misc Vendor City',
            DISPLAY_ORDER: 30,
            ENABLED_FLAG: 'Y',
            DISPLAY_FLAG: 'Y',
            REQUIRED_FLAG: 'Y',
          },
        ],
      });

    const res = await request(app).get('/invoices/dff-schema').set(AUTH_HEADER).expect(200);

    expect(res.body).toEqual({
      contexts: [
        {
          context_code: 'Global Data Elements',
          context_name: 'Global Data Elements',
          enabled: true,
          columns: [],
        },
        {
          context_code: 'One-Time',
          context_name: 'One-Time',
          enabled: true,
          columns: [
            {
              column: 'attribute5',
              label: 'Misc Vendor City',
              display_order: 30,
              enabled: true,
              displayed: true,
              required: true,
            },
          ],
        },
      ],
    });
  });
});
