// Netlify serverless function: proxies live Odoo data for the dashboard.
// Credentials come from environment variables (never shipped to the browser):
//   ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD (or API key)
//
// Responses are gzip-compressed and paged (limit/offset) to stay within
// Netlify's function response-size and execution-time limits.

const zlib = require("zlib");

const ODOO_URL = (process.env.ODOO_URL || "").replace(/\/+$/, "");
const { ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD } = process.env;

const MAX_PAGE_SIZE = 20000;

async function jsonrpc(service, method, args) {
  const response = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args } })
  });
  if (!response.ok) throw new Error(`Odoo HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) {
    throw new Error(JSON.stringify(payload.error.data || payload.error).slice(-800));
  }
  return payload.result;
}

async function authenticate() {
  const uid = await jsonrpc("common", "authenticate", [ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD, {}]);
  if (!uid) throw new Error("Odoo authentication failed: check ODOO_DB / ODOO_USERNAME / ODOO_PASSWORD");
  return uid;
}

function searchRead(uid, model, domain, fields, limit, offset) {
  return jsonrpc("object", "execute_kw", [
    ODOO_DB, uid, ODOO_PASSWORD, model, "search_read", [domain],
    { fields, limit, offset, order: "id asc" }
  ]);
}

const ORDER_FIELDS = ["name", "date_order", "create_date", "partner_id", "user_id", "state", "amount_total"];
const INVOICE_FIELDS = ["name", "invoice_date", "create_date", "invoice_origin", "partner_id", "invoice_user_id", "amount_total"];
const ORDER_LINE_FIELDS = ["order_id", "create_date", "product_id", "product_uom_qty", "qty_invoiced", "price_subtotal"];
const EXCLUDED_ORDER_STATES = ["draft", "cancel"];

function jsonResponse(statusCode, payload) {
  const gzipped = zlib.gzipSync(JSON.stringify(payload));
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    },
    body: gzipped.toString("base64"),
    isBase64Encoded: true
  };
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const resource = params.resource || "orders";
  const dateFrom = params.date_from || "2025-01-01";
  const limit = Math.min(Number(params.limit) || MAX_PAGE_SIZE, MAX_PAGE_SIZE);
  const offset = Math.max(Number(params.offset) || 0, 0);

  if (!ODOO_URL || !ODOO_DB || !ODOO_USERNAME || !ODOO_PASSWORD) {
    return jsonResponse(500, { error: "Odoo credentials not configured (ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD)" });
  }

  try {
    const uid = await authenticate();
    let data;

    if (resource === "orders") {
      const domain = [["date_order", ">=", dateFrom], ["state", "not in", EXCLUDED_ORDER_STATES]];
      if (params.web_only === "true") domain.push(["user_id.name", "=", "Web Order"]);
      data = await searchRead(uid, "sale.order", domain, ORDER_FIELDS, limit, offset);
    } else if (resource === "invoices") {
      const domain = [
        ["move_type", "=", "out_invoice"],
        ["state", "=", params.state || "posted"],
        ["invoice_date", ">=", dateFrom]
      ];
      data = await searchRead(uid, "account.move", domain, INVOICE_FIELDS, limit, offset);
    } else if (resource === "order_lines") {
      const domain = [["order_id.date_order", ">=", dateFrom], ["order_id.state", "not in", EXCLUDED_ORDER_STATES]];
      data = await searchRead(uid, "sale.order.line", domain, ORDER_LINE_FIELDS, limit, offset);
      data = data.map(row => ({
        ...row,
        order_name: Array.isArray(row.order_id) ? row.order_id[1] : row.order_id || "",
        partner_id: "",
        order_date: row.create_date || ""
      }));
    } else if (resource === "partners") {
      // Distinct partners with Web Orders since date_from, mapped to their client class (category).
      let webOrders, partners, categories;
      try {
        webOrders = await searchRead(uid, "sale.order",
          [["date_order", ">=", dateFrom], ["user_id.name", "=", "Web Order"], ["state", "not in", EXCLUDED_ORDER_STATES]],
          ["partner_id"], 100000, 0);
      } catch (e) { throw new Error(`partners step 1 (web orders): ${e.message}`); }
      const partnerIds = [...new Set(webOrders.map(o => Array.isArray(o.partner_id) ? o.partner_id[0] : o.partner_id).filter(Boolean))];
      try {
        categories = await searchRead(uid, "res.partner.category", [], ["name"], 1000, 0);
      } catch (e) { throw new Error(`partners step 3 (categories): ${e.message}`); }
      const categoryNames = new Map(categories.map(c => [c.id, c.name]));
      try {
        partners = partnerIds.length
          ? await searchRead(uid, "res.partner", [["id", "in", partnerIds]], ["name", "category_id", "phone", "email"], 100000, 0)
          : [];
      } catch (e) { throw new Error(`partners step 2 (${partnerIds.length} partners): ${e.message}`); }
      data = partners.map(p => ({
        id: p.id,
        name: p.name,
        phone: p.phone || "",
        email: p.email || "",
        class: (p.category_id || []).map(id => categoryNames.get(id)).filter(Boolean)[0] || ""
      }));
    } else {
      return jsonResponse(400, { error: `Unknown resource: ${resource}` });
    }

    return jsonResponse(200, { data });
  } catch (error) {
    return jsonResponse(502, { error: error.message });
  }
};
