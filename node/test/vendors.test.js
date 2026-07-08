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

describe('GET /vendors', () => {
  test('401 without the client secret', async () => {
    await request(app).get('/vendors').expect(401);
  });

  test('400 without org_id', async () => {
    await request(app).get('/vendors').set(AUTH_HEADER).expect(400);
  });

  test('lists vendors usable in the operating unit', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [
        { VENDOR_ID: 1, NAME: 'GE Plastics' },
        { VENDOR_ID: 11, NAME: 'Advantage Corp' },
      ],
    });
    const res = await request(app).get('/vendors?org_id=204').set(AUTH_HEADER).expect(200);
    expect(res.body).toEqual([
      { vendor_id: 1, name: 'GE Plastics' },
      { vendor_id: 11, name: 'Advantage Corp' },
    ]);
  });

  test('filters by name', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ VENDOR_ID: 1, NAME: 'GE Plastics', TAX_ID: null }],
    });
    const res = await request(app).get('/vendors?org_id=204&name=plastics').set(AUTH_HEADER).expect(200);
    expect(res.body).toEqual([{ vendor_id: 1, name: 'GE Plastics', tax_id: null }]);
    expect(mockExecute).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ org_id: 204, name: '%plastics%' }),
    );
  });

  test('filters by tax_id', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ VENDOR_ID: 4, NAME: 'United Parcel Service', TAX_ID: '12345678901' }],
    });
    const res = await request(app)
      .get('/vendors?org_id=204&tax_id=12345678901')
      .set(AUTH_HEADER)
      .expect(200);
    expect(res.body).toEqual([{ vendor_id: 4, name: 'United Parcel Service', tax_id: '12345678901' }]);
    expect(mockExecute).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ org_id: 204, tax_id: '12345678901' }),
    );
  });

  test('searches by tax_id across all orgs when org_id is omitted', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ VENDOR_ID: 21, NAME: 'Advanced Network Devices', TAX_ID: 'PL521-020-14-90' }],
    });
    const res = await request(app).get('/vendors?tax_id=PL521-020-14-90').set(AUTH_HEADER).expect(200);
    expect(res.body).toEqual([{ vendor_id: 21, name: 'Advanced Network Devices', tax_id: 'PL521-020-14-90' }]);
    const [sql, binds] = mockExecute.mock.calls.at(-1);
    expect(binds).not.toHaveProperty('org_id');
    expect(sql).not.toMatch(/ap_supplier_sites_all/);
  });

  test('searches by name across all orgs when org_id is omitted', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });
    await request(app).get('/vendors?name=plastics').set(AUTH_HEADER).expect(200);
    const [, binds] = mockExecute.mock.calls.at(-1);
    expect(binds).not.toHaveProperty('org_id');
  });
});

describe('GET /vendor-sites', () => {
  test('401 without the client secret', async () => {
    await request(app).get('/vendor-sites').expect(401);
  });

  test('400 without vendor_id', async () => {
    await request(app).get('/vendor-sites?org_id=204').set(AUTH_HEADER).expect(400);
  });

  test('lists sites for a vendor in the operating unit', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [
        { VENDOR_SITE_ID: 1, VENDOR_SITE_CODE: 'GE PLASTICS' },
        { VENDOR_SITE_ID: 985, VENDOR_SITE_CODE: 'GE PLASTICS 3W' },
      ],
    });
    const res = await request(app)
      .get('/vendor-sites?org_id=204&vendor_id=1')
      .set(AUTH_HEADER)
      .expect(200);
    expect(res.body).toEqual([
      { vendor_site_id: 1, vendor_site_code: 'GE PLASTICS' },
      { vendor_site_id: 985, vendor_site_code: 'GE PLASTICS 3W' },
    ]);
  });
});
