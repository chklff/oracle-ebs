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

describe('GET /purchase-orders', () => {
  test('401 without the client secret', async () => {
    await request(app).get('/purchase-orders').expect(401);
  });

  test('400 without org_id or vendor_id', async () => {
    await request(app).get('/purchase-orders?org_id=204').set(AUTH_HEADER).expect(400);
  });

  test('lists open purchase orders for a vendor', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ PO_HEADER_ID: 61, PO_NUMBER: '501', TYPE: 'BLANKET' }],
    });
    const res = await request(app)
      .get('/purchase-orders?org_id=204&vendor_id=1')
      .set(AUTH_HEADER)
      .expect(200);
    expect(res.body).toEqual([{ po_header_id: 61, po_number: '501', type: 'BLANKET' }]);
  });
});

describe('GET /purchase-orders/:po_header_id/lines', () => {
  test('401 without the client secret', async () => {
    await request(app).get('/purchase-orders/61/lines').expect(401);
  });

  test('lists open shipments for a PO', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [
        {
          PO_LINE_ID: 61,
          PO_LINE_LOCATION_ID: 12067,
          LINE_NUM: 1,
          ITEM_DESCRIPTION: 'Leather Computer Case',
          UNIT_PRICE: 100,
          MATCH_OPTION: 'P',
          QUANTITY: 50,
          QUANTITY_RECEIVED: 0,
          QUANTITY_BILLED: 0,
        },
      ],
    });
    const res = await request(app).get('/purchase-orders/61/lines').set(AUTH_HEADER).expect(200);
    expect(res.body).toEqual([
      {
        po_line_id: 61,
        po_line_location_id: 12067,
        line_num: 1,
        item_description: 'Leather Computer Case',
        unit_price: 100,
        match_option: 'P',
        quantity: 50,
        quantity_received: 0,
        quantity_billed: 0,
      },
    ]);
  });
});
