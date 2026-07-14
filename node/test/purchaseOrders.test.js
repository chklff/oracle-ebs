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

  test('lists open, approved shipments for a PO', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [
        {
          PO_LINE_ID: 39835,
          PO_LINE_LOCATION_ID: 78018,
          PO_RELEASE_ID: null,
          LINE_NUM: 7,
          ITEM_DESCRIPTION: 'Legal Services',
          UNIT_PRICE: 450,
          UNIT_OF_MEASURE: 'HRS',
          MATCH_OPTION: 'P',
          SHIPMENT_NUM: 1,
          QUANTITY: 159,
          QUANTITY_RECEIVED: 0,
          QUANTITY_BILLED: 0,
        },
      ],
    });
    const res = await request(app).get('/purchase-orders/34071/lines').set(AUTH_HEADER).expect(200);
    expect(res.body).toEqual([
      {
        po_line_id: 39835,
        po_line_location_id: 78018,
        po_release_id: null,
        line_num: 7,
        item_description: 'Legal Services',
        unit_price: 450,
        unit_of_measure: 'HRS',
        match_option: 'P',
        shipment_num: 1,
        quantity: 159,
        quantity_received: 0,
        quantity_billed: 0,
      },
    ]);
    const [sql] = mockExecute.mock.calls.at(-1);
    expect(sql).toMatch(/approved_flag = 'Y'/);
  });

  test('surfaces po_release_id for a Blanket PO release shipment', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [
        {
          PO_LINE_ID: 9168,
          PO_LINE_LOCATION_ID: 11729,
          PO_RELEASE_ID: 2868,
          LINE_NUM: 1,
          ITEM_DESCRIPTION: 'Some Item',
          UNIT_PRICE: 89.95,
          UNIT_OF_MEASURE: 'EA',
          MATCH_OPTION: 'P',
          SHIPMENT_NUM: 1,
          QUANTITY: 3,
          QUANTITY_RECEIVED: 0,
          QUANTITY_BILLED: 0,
        },
      ],
    });
    const res = await request(app).get('/purchase-orders/9065/lines').set(AUTH_HEADER).expect(200);
    expect(res.body[0].po_release_id).toBe(2868);
  });
});
