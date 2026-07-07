'use strict';

/**
 * Descriptive Flexfield (DFF) metadata for AP invoices. Every EBS instance has
 * its own labels (or none at all) for the generic attribute1..15 columns on
 * ap_invoices_all - configured per customer in Oracle's Application Object
 * Library, never in this codebase. This is context-sensitive: which label set
 * applies to a given invoice depends on that invoice's own attribute_category
 * value, matched against descriptive_flex_context_code here. There is no
 * single flat column -> label map for an instance.
 */

const APPLICATION_ID = 200; // Payables (SQLAP)
const DESCRIPTIVE_FLEXFIELD_NAME = 'AP_INVOICES';

const LIST_CONTEXTS = `
  SELECT descriptive_flex_context_code AS context_code,
         descriptive_flex_context_name AS context_name,
         enabled_flag                  AS enabled_flag
    FROM fnd_descr_flex_contexts_vl
   WHERE application_id = :application_id
     AND descriptive_flexfield_name = :flexfield_name
   ORDER BY descriptive_flex_context_code`;

const LIST_COLUMN_USAGES = `
  SELECT descriptive_flex_context_code AS context_code,
         application_column_name       AS column_name,
         end_user_column_name          AS label,
         column_seq_num                AS display_order,
         enabled_flag                  AS enabled_flag,
         display_flag                  AS display_flag,
         required_flag                 AS required_flag
    FROM fnd_descr_flex_col_usage_vl
   WHERE application_id = :application_id
     AND descriptive_flexfield_name = :flexfield_name
   ORDER BY descriptive_flex_context_code, column_seq_num`;

function mapContext(row) {
  return {
    context_code: row.CONTEXT_CODE,
    context_name: row.CONTEXT_NAME,
    enabled: row.ENABLED_FLAG === 'Y',
    columns: [],
  };
}

function mapColumn(row) {
  return {
    column: row.COLUMN_NAME.toLowerCase(),
    label: row.LABEL,
    display_order: row.DISPLAY_ORDER,
    enabled: row.ENABLED_FLAG === 'Y',
    displayed: row.DISPLAY_FLAG === 'Y',
    required: row.REQUIRED_FLAG === 'Y',
  };
}

/**
 * Every context registered for the AP_INVOICES DFF, each with the
 * attributeN -> label columns configured under it. "Global Data Elements" is
 * the context used when an invoice's attribute_category is null/blank; it
 * commonly has zero configured columns (meaning attribute1..15 are unused for
 * invoices with no context set).
 */
async function getInvoiceDffSchema(conn) {
  const binds = { application_id: APPLICATION_ID, flexfield_name: DESCRIPTIVE_FLEXFIELD_NAME };

  const [contextsResult, columnsResult] = await Promise.all([
    conn.execute(LIST_CONTEXTS, binds),
    conn.execute(LIST_COLUMN_USAGES, binds),
  ]);

  const contextsByCode = new Map();
  (contextsResult.rows || []).forEach((row) => {
    contextsByCode.set(row.CONTEXT_CODE, mapContext(row));
  });

  (columnsResult.rows || []).forEach((row) => {
    let context = contextsByCode.get(row.CONTEXT_CODE);
    if (!context) {
      // Column usage referencing a context not returned above - keep it visible
      // rather than silently dropping data.
      context = { context_code: row.CONTEXT_CODE, context_name: row.CONTEXT_CODE, enabled: true, columns: [] };
      contextsByCode.set(row.CONTEXT_CODE, context);
    }
    context.columns.push(mapColumn(row));
  });

  return Array.from(contextsByCode.values());
}

module.exports = { getInvoiceDffSchema, APPLICATION_ID, DESCRIPTIVE_FLEXFIELD_NAME };
