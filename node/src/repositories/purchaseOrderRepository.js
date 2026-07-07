'use strict';

/**
 * Purchase order lookups. Back GET /purchase-orders and
 * GET /purchase-orders/:po_header_id/lines so callers can discover
 * po_header_id/po_line_id/po_line_location_id values for PO-matched invoice
 * lines. Shipment-level (po_line_locations_all), not line-level, since a
 * shipment is the actual matchable unit AP_INVOICE_LINES_INTERFACE expects -
 * a single PO line commonly has dozens of shipments/releases (a live Blanket
 * PO on the reference instance had 70+, mostly long since closed), so this
 * filters to ones still genuinely open to invoice rather than dumping
 * everything on the caller.
 */

const LIST_PURCHASE_ORDERS = `
  SELECT po_header_id AS po_header_id,
         segment1     AS po_number,
         type_lookup_code AS type
    FROM po_headers_all
   WHERE org_id = :org_id
     AND vendor_id = :vendor_id
     AND (closed_code IS NULL OR closed_code != 'FINALLY CLOSED')
   ORDER BY segment1`;

async function listPurchaseOrders(conn, { orgId, vendorId }) {
  const result = await conn.execute(LIST_PURCHASE_ORDERS, { org_id: orgId, vendor_id: vendorId });
  return (result.rows || []).map((row) => ({
    po_header_id: row.PO_HEADER_ID,
    po_number: row.PO_NUMBER,
    type: row.TYPE,
  }));
}

const LIST_PURCHASE_ORDER_LINES = `
  SELECT pl.po_line_id            AS po_line_id,
         loc.line_location_id     AS po_line_location_id,
         pl.line_num              AS line_num,
         pl.item_description      AS item_description,
         pl.unit_price            AS unit_price,
         loc.match_option         AS match_option,
         loc.quantity             AS quantity,
         loc.quantity_received    AS quantity_received,
         loc.quantity_billed      AS quantity_billed
    FROM po_lines_all pl
    JOIN po_line_locations_all loc ON loc.po_line_id = pl.po_line_id
   WHERE pl.po_header_id = :po_header_id
     AND loc.closed_code = 'OPEN'
     AND NVL(loc.cancel_flag, 'N') != 'Y'
   ORDER BY pl.line_num, loc.line_location_id`;

async function listPurchaseOrderLines(conn, poHeaderId) {
  const result = await conn.execute(LIST_PURCHASE_ORDER_LINES, { po_header_id: poHeaderId });
  return (result.rows || []).map((row) => ({
    po_line_id: row.PO_LINE_ID,
    po_line_location_id: row.PO_LINE_LOCATION_ID,
    line_num: row.LINE_NUM,
    item_description: row.ITEM_DESCRIPTION,
    unit_price: row.UNIT_PRICE,
    match_option: row.MATCH_OPTION,
    quantity: row.QUANTITY,
    quantity_received: row.QUANTITY_RECEIVED,
    quantity_billed: row.QUANTITY_BILLED,
  }));
}

module.exports = { listPurchaseOrders, listPurchaseOrderLines };
