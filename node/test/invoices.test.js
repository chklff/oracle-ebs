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

function sampleRow(overrides = {}) {
  const row = {
    INVOICE_ID: 12345,
    INVOICE_NUM: 'INV-001',
    INVOICE_DATE: '2026-06-01',
    VENDOR_ID: 987,
    VENDOR_NAME: 'Acme Corp',
    INVOICE_AMOUNT: 1500,
    CURRENCY_CODE: 'USD',
    GL_DATE: '2026-06-05',
    PAYMENT_STATUS_FLAG: 'N',
    ORG_ID: 101,
    ATTRIBUTE_CATEGORY: null,
    ...overrides,
  };
  for (let i = 1; i <= 15; i += 1) {
    if (row[`ATTRIBUTE${i}`] === undefined) row[`ATTRIBUTE${i}`] = null;
  }
  return row;
}

describe('GET /invoices', () => {
  test('401 without the client secret', async () => {
    await request(app).get('/invoices?org_id=101').expect(401);
  });

  test('400 when org_id is missing', async () => {
    const res = await request(app).get('/invoices').set(AUTH_HEADER).expect(400);
    expect(res.body.error).toMatch(/org_id/);
  });

  test('returns mapped invoices with nested custom_fields', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [sampleRow({ ATTRIBUTE1: 'PO-42' })] });
    const res = await request(app)
      .get('/invoices?org_id=101&limit=10')
      .set(AUTH_HEADER)
      .expect(200);

    expect(res.body.count).toBe(1);
    expect(res.body.limit).toBe(10);
    const inv = res.body.data[0];
    expect(inv.invoice_num).toBe('INV-001');
    expect(inv.vendor_name).toBe('Acme Corp');
    expect(inv.custom_fields.attribute1).toBe('PO-42');
    expect(inv.custom_fields.attribute15).toBeNull();
  });

  test('clamps limit to the configured maximum', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .get('/invoices?org_id=101&limit=99999')
      .set(AUTH_HEADER)
      .expect(200);
    expect(res.body.limit).toBe(500);
  });

  test('400 on a malformed date filter', async () => {
    await request(app)
      .get('/invoices?org_id=101&date_from=06-01-2026')
      .set(AUTH_HEADER)
      .expect(400);
  });
});

describe('GET /invoices/:id', () => {
  test('returns the invoice with its lines', async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [sampleRow()] })
      .mockResolvedValueOnce({
        rows: [
          {
            LINE_NUMBER: 1,
            LINE_TYPE: 'ITEM',
            AMOUNT: 1500,
            DESCRIPTION: 'Consulting',
            DIST_CODE_COMBINATION_ID: 55501,
          },
        ],
      });

    const res = await request(app).get('/invoices/12345').set(AUTH_HEADER).expect(200);
    expect(res.body.invoice_id).toBe(12345);
    expect(res.body.org_id).toBe(101);
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0].line_type).toBe('ITEM');
  });

  test('404 when the invoice does not exist', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/invoices/99999').set(AUTH_HEADER).expect(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

describe('POST /invoices', () => {
  const validBody = {
    org_id: 101,
    invoice_num: 'INV-1001',
    invoice_date: '2026-07-01',
    vendor_id: 987,
    vendor_site_id: 654,
    invoice_amount: 1500,
    currency_code: 'USD',
    lines: [{ amount: 1500, dist_code_combination_id: 55501 }],
  };

  test('400 lists all missing required fields', async () => {
    const res = await request(app).post('/invoices').set(AUTH_HEADER).send({}).expect(400);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details).toEqual(expect.arrayContaining([expect.stringMatching(/org_id/)]));
    expect(res.body.details).toEqual(expect.arrayContaining([expect.stringMatching(/at least one line/)]));
  });

  test('400 when a line lacks an account and a code combination', async () => {
    const res = await request(app)
      .post('/invoices')
      .set(AUTH_HEADER)
      .send({ ...validBody, lines: [{ amount: 10 }] })
      .expect(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.stringMatching(/dist_code_combination_id or account/)]),
    );
  });

  test('400 when a line is both GL-coded and PO-matched', async () => {
    const res = await request(app)
      .post('/invoices')
      .set(AUTH_HEADER)
      .send({
        ...validBody,
        lines: [{ amount: 10, dist_code_combination_id: 55501, po_line_id: 61, po_line_location_id: 12067 }],
      })
      .expect(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.stringMatching(/must be exactly one of GL-coded, PO-matched, or a TAX line/)]),
    );
  });

  test('accepts a TAX-type line with no dist_code_combination_id/account/po_line_location_id', async () => {
    mockExecute
      .mockResolvedValueOnce({ outBinds: { out_invoice_id: [777] } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ outBinds: { request_id: 8675309 } });
    await request(app)
      .post('/invoices')
      .set(AUTH_HEADER)
      .send({
        ...validBody,
        lines: [
          {
            amount: 6.5,
            line_type: 'TAX',
            tax_regime_code: 'US-SALES-TAX-101',
            tax_status_code: 'STANDARD',
            tax_rate_code: 'STANDARD',
            tax_jurisdiction_code: 'ST-WA-121720',
          },
        ],
      })
      .expect(202);
  });

  test('400 when a TAX-type line is also GL-coded', async () => {
    const res = await request(app)
      .post('/invoices')
      .set(AUTH_HEADER)
      .send({
        ...validBody,
        lines: [{ amount: 10, line_type: 'TAX', dist_code_combination_id: 55501, tax_regime_code: 'US-SALES' }],
      })
      .expect(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.stringMatching(/must be exactly one of GL-coded, PO-matched, or a TAX line/)]),
    );
  });

  test('400 when a PO-matched line is missing quantity_invoiced', async () => {
    const res = await request(app)
      .post('/invoices')
      .set(AUTH_HEADER)
      .send({ ...validBody, lines: [{ amount: 10, po_line_id: 61, po_line_location_id: 12067 }] })
      .expect(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.stringMatching(/quantity_invoiced is required/)]),
    );
  });

  test('stages a PO-matched line', async () => {
    mockExecute
      .mockResolvedValueOnce({ outBinds: { out_invoice_id: [777] } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ outBinds: { request_id: 8675309 } });
    await request(app)
      .post('/invoices')
      .set(AUTH_HEADER)
      .send({
        ...validBody,
        lines: [{ amount: 10, po_line_id: 61, po_line_location_id: 12067, quantity_invoiced: 1 }],
      })
      .expect(202);
    const [, lineBinds] = mockExecute.mock.calls.at(-2);
    expect(lineBinds).toEqual(
      expect.objectContaining({
        po_line_id: 61,
        po_line_location_id: 12067,
        quantity_invoiced: 1,
        dist_code_combination_id: null,
      }),
    );
  });

  test('accepts po_line_location_id alone as a PO-matched line - po_line_id is not required', async () => {
    mockExecute
      .mockResolvedValueOnce({ outBinds: { out_invoice_id: [777] } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ outBinds: { request_id: 8675309 } });
    await request(app)
      .post('/invoices')
      .set(AUTH_HEADER)
      .send({
        ...validBody,
        lines: [{ amount: 10, po_line_location_id: 78018, quantity_invoiced: 1 }],
      })
      .expect(202);
    const [, lineBinds] = mockExecute.mock.calls.at(-2);
    expect(lineBinds).toEqual(
      expect.objectContaining({
        po_line_id: null,
        po_line_location_id: 78018,
        quantity_invoiced: 1,
      }),
    );
  });

  test('passes through the extended PO-matching fields and calc_tax_during_import', async () => {
    mockExecute
      .mockResolvedValueOnce({ outBinds: { out_invoice_id: [777] } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ outBinds: { request_id: 8675309 } });
    await request(app)
      .post('/invoices')
      .set(AUTH_HEADER)
      .send({
        ...validBody,
        calc_tax_during_import: true,
        lines: [
          {
            amount: 500,
            po_header_id: 5181,
            po_line_id: 5189,
            po_line_number: 1,
            po_line_location_id: 5420,
            po_shipment_num: 1,
            po_release_id: 2868,
            po_unit_of_measure: 'Each',
            unit_price: 100,
            quantity_invoiced: 5,
          },
        ],
      })
      .expect(202);
    const [, headerBinds] = mockExecute.mock.calls.at(-3);
    expect(headerBinds).toEqual(expect.objectContaining({ calc_tax_during_import: 'Y' }));
    const [, lineBinds] = mockExecute.mock.calls.at(-2);
    expect(lineBinds).toEqual(
      expect.objectContaining({
        po_header_id: 5181,
        po_line_number: 1,
        po_shipment_num: 1,
        po_release_id: 2868,
        po_unit_of_measure: 'Each',
        unit_price: 100,
      }),
    );
  });

  test('stages the invoice and returns the import request id', async () => {
    mockExecute
      // header insert -> RETURNING invoice_id
      .mockResolvedValueOnce({ outBinds: { out_invoice_id: [777] } })
      // single line insert
      .mockResolvedValueOnce({})
      // submit import PL/SQL block -> scalar request_id out bind
      .mockResolvedValueOnce({ outBinds: { request_id: 8675309 } });

    const res = await request(app).post('/invoices').set(AUTH_HEADER).send(validBody).expect(202);
    expect(res.body).toEqual({ status: 'submitted', request_id: 8675309, interface_invoice_id: 777 });
    expect(mockExecute).toHaveBeenCalledTimes(3);
  });

  test('defaults invoice_type to STANDARD and passes through an explicit one', async () => {
    mockExecute
      .mockResolvedValueOnce({ outBinds: { out_invoice_id: [777] } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ outBinds: { request_id: 8675309 } });
    await request(app).post('/invoices').set(AUTH_HEADER).send(validBody).expect(202);
    const [, headerBindsDefault] = mockExecute.mock.calls.at(-3);
    expect(headerBindsDefault).toEqual(expect.objectContaining({ invoice_type: 'STANDARD' }));

    mockExecute
      .mockResolvedValueOnce({ outBinds: { out_invoice_id: [778] } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ outBinds: { request_id: 8675310 } });
    await request(app)
      .post('/invoices')
      .set(AUTH_HEADER)
      .send({ ...validBody, invoice_type: 'PAYMENT REQUEST' })
      .expect(202);
    const [, headerBindsExplicit] = mockExecute.mock.calls.at(-3);
    expect(headerBindsExplicit).toEqual(expect.objectContaining({ invoice_type: 'PAYMENT REQUEST' }));
  });
});

describe('GET /invoices/import-status/:request_id', () => {
  test('decodes phase and status codes when no interface row matches', async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [{ REQUEST_ID: 8675309, PHASE_CODE: 'C', STATUS_CODE: 'C' }] })
      .mockResolvedValueOnce({ rows: [] }); // no ap_invoices_interface row for this request_id

    const res = await request(app)
      .get('/invoices/import-status/8675309')
      .set(AUTH_HEADER)
      .expect(200);
    expect(res.body).toEqual({
      request_id: 8675309,
      phase: 'Completed',
      status: 'Normal',
      phase_code: 'C',
      status_code: 'C',
    });
  });

  test('ignores an ambiguous request_id match (multiple rows swept together) without interface_invoice_id', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [{ REQUEST_ID: 8675309, PHASE_CODE: 'C', STATUS_CODE: 'C' }] }).mockResolvedValueOnce({
      rows: [
        { INVOICE_ID: 1, INVOICE_NUM: 'A', VENDOR_ID: 1, ORG_ID: 101, STATUS: 'REJECTED' },
        { INVOICE_ID: 2, INVOICE_NUM: 'B', VENDOR_ID: 1, ORG_ID: 101, STATUS: 'PROCESSED' },
      ],
    });

    const res = await request(app)
      .get('/invoices/import-status/8675309')
      .set(AUTH_HEADER)
      .expect(200);
    expect(res.body).toEqual({
      request_id: 8675309,
      phase: 'Completed',
      status: 'Normal',
      phase_code: 'C',
      status_code: 'C',
    });
  });

  test('interface_invoice_id gives a precise outcome even when request_id is ambiguous', async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [{ REQUEST_ID: 8675309, PHASE_CODE: 'C', STATUS_CODE: 'C' }] })
      .mockResolvedValueOnce({
        rows: [{ INVOICE_ID: 5173458, INVOICE_NUM: 'INV-1001', VENDOR_ID: 987, ORG_ID: 101, STATUS: 'PROCESSED' }],
      })
      .mockResolvedValueOnce({ rows: [{ INVOICE_ID: 565059 }] });

    const res = await request(app)
      .get('/invoices/import-status/8675309?interface_invoice_id=5173458')
      .set(AUTH_HEADER)
      .expect(200);
    expect(res.body).toMatchObject({ interface_status: 'PROCESSED', invoice_id: 565059 });
  });

  test('includes the rejection reason when the interface row was rejected', async () => {
    mockExecute
      .mockResolvedValueOnce({ rows: [{ REQUEST_ID: 8675309, PHASE_CODE: 'C', STATUS_CODE: 'E' }] })
      .mockResolvedValueOnce({
        rows: [{ INVOICE_ID: 5173458, INVOICE_NUM: 'INV-1001', VENDOR_ID: 987, ORG_ID: 101, STATUS: 'REJECTED' }],
      })
      .mockResolvedValueOnce({ rows: [{ REJECT_LOOKUP_CODE: 'NO SUPPLIER SITE' }] });

    const res = await request(app)
      .get('/invoices/import-status/8675309')
      .set(AUTH_HEADER)
      .expect(200);
    expect(res.body).toMatchObject({
      interface_status: 'REJECTED',
      invoice_id: null,
      rejection_reasons: ['NO SUPPLIER SITE'],
    });
  });

  test('404 for an unknown request id', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });
    await request(app).get('/invoices/import-status/1').set(AUTH_HEADER).expect(404);
  });
});
