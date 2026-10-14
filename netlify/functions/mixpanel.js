// Netlify serverless function: proxies Mixpanel Query API events for the dashboard.
// Credentials come from environment variables (never shipped to the browser):
//   MIXPANEL_USERNAME, MIXPANEL_SECRET (service account)
// Optional:
//   MIXPANEL_REGION ("us" default, or "eu" for EU-resident projects)
//   MIXPANEL_CHECKOUT_EVENT (default "Checkout")
//   MIXPANEL_ABANDONED_CART_EVENT (default "Cart Abandoned")

const zlib = require("zlib");

const { MIXPANEL_USERNAME, MIXPANEL_SECRET } = process.env;
const REGION = (process.env.MIXPANEL_REGION || "us").toLowerCase();
const API_HOST = REGION === "eu" ? "https://eu.mixpanel.com" : "https://mixpanel.com";
const CHECKOUT_EVENT = process.env.MIXPANEL_CHECKOUT_EVENT || "Checkout";
const ABANDONED_CART_EVENT = process.env.MIXPANEL_ABANDONED_CART_EVENT || "Cart Abandoned";

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
  const events = [CHECKOUT_EVENT, ABANDONED_CART_EVENT];

  if (!MIXPANEL_USERNAME || !MIXPANEL_SECRET) {
    return jsonResponse(500, { error: "Mixpanel credentials not configured (MIXPANEL_USERNAME, MIXPANEL_SECRET)" });
  }

  const fromDate = params.from || "2025-01-01";
  const toDate = params.to || new Date().toISOString().slice(0, 10);

  try {
    const url = new URL(`${API_HOST}/api/query/events/`);
    url.searchParams.set("event", JSON.stringify(events));
    url.searchParams.set("from_date", fromDate);
    url.searchParams.set("to_date", toDate);
    url.searchParams.set("unit", "day");
    url.searchParams.set("type", "general");

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Basic ${Buffer.from(`${MIXPANEL_USERNAME}:${MIXPANEL_SECRET}`).toString("base64")}`
      }
    });
    if (!response.ok) {
      const text = (await response.text()).slice(-500);
      throw new Error(`Mixpanel HTTP ${response.status}: ${text}`);
    }
    const payload = await response.json();
    const series = (payload.data && payload.data.series) || {};
    const totals = Object.fromEntries(events.map(name => [name, 0]));
    const daily = Object.keys(series).sort().map(date => {
      const entry = { date };
      events.forEach(name => {
        const count = Number(series[date] && series[date][name]) || 0;
        entry[name] = count;
        totals[name] += count;
      });
      return entry;
    });
    return jsonResponse(200, { totals, daily, events });
  } catch (error) {
    return jsonResponse(502, { error: error.message });
  }
};
