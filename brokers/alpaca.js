/**
 * Alpaca broker client — factory that returns a fully configured client.
 *
 * Multi-strategy usage: each strategy can hold its own Alpaca account
 * by calling createAlpacaClient() with different credentials.
 */

const INTERVAL_MAP = {
  "1m": "1Min",
  "5m": "5Min",
  "15m": "15Min",
  "30m": "30Min",
  "1H": "1Hour",
  "4H": "4Hour",
  "1D": "1Day",
  "1W": "1Week",
  "1M": "1Month",
};

export function createAlpacaClient({ apiKey, secretKey, baseUrl, dataUrl }) {
  if (!apiKey || !secretKey) {
    throw new Error("createAlpacaClient: apiKey and secretKey are required");
  }
  baseUrl = baseUrl || "https://paper-api.alpaca.markets";
  dataUrl = dataUrl || "https://data.alpaca.markets";

  const authHeaders = {
    "APCA-API-KEY-ID": apiKey,
    "APCA-API-SECRET-KEY": secretKey,
  };

  async function placeOrder({ symbol, side, notional, qty, type = "market", timeInForce = "day" }) {
    const body = { symbol: symbol.replace("/", ""), side, type, time_in_force: timeInForce };
    if (notional != null) body.notional = Number(notional).toFixed(2);
    if (qty != null) body.qty = String(qty);
    const res = await fetch(`${baseUrl}/v2/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(`Alpaca order failed: ${data.message || JSON.stringify(data)}`);
    }
    return { orderId: data.id, status: data.status, symbol: data.symbol };
  }

  async function fetchPositions() {
    const res = await fetch(`${baseUrl}/v2/positions`, { headers: authHeaders });
    if (!res.ok) {
      throw new Error(`Alpaca positions fetch failed: ${res.status} ${await res.text()}`);
    }
    return await res.json();
  }

  async function closePosition(symbol) {
    const res = await fetch(
      `${baseUrl}/v2/positions/${encodeURIComponent(symbol)}`,
      { method: "DELETE", headers: authHeaders },
    );
    const data = await res.json();
    if (!res.ok) {
      throw new Error(`Alpaca position close failed: ${data.message || JSON.stringify(data)}`);
    }
    return { orderId: data.id, status: data.status };
  }

  async function fetchCandles(symbol, interval, { start, end, limit = 1000 } = {}) {
    const alpacaTimeframe = INTERVAL_MAP[interval] || "1Day";
    const isCrypto = symbol.includes("/");
    const endpoint = isCrypto ? `/v1beta3/crypto/us/bars` : `/v2/stocks/${symbol}/bars`;

    const endDate = end || new Date().toISOString().slice(0, 10);
    const startDate = start || (() => {
      const msBack = (interval === "1D" || interval === "1W" || interval === "1M")
        ? 400 * 24 * 60 * 60 * 1000
        : 30 * 24 * 60 * 60 * 1000;
      return new Date(Date.now() - msBack).toISOString().slice(0, 10);
    })();

    const params = new URLSearchParams({
      timeframe: alpacaTimeframe,
      limit: String(limit),
      start: startDate,
      end: endDate,
    });
    if (isCrypto) {
      params.set("symbols", symbol);
    } else {
      params.set("feed", "iex");
      params.set("adjustment", "raw");
    }

    const url = `${dataUrl}${endpoint}?${params}`;
    const res = await fetch(url, { headers: authHeaders });
    if (!res.ok) {
      throw new Error(`Alpaca data API error: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    const bars = isCrypto ? (data.bars[symbol] || []) : (data.bars || []);
    return bars.map((b) => ({
      time: new Date(b.t).getTime(),
      date: b.t.slice(0, 10),
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      volume: b.v,
    }));
  }

  async function fetchAccount() {
    const res = await fetch(`${baseUrl}/v2/account`, { headers: authHeaders });
    if (!res.ok) {
      throw new Error(`Alpaca account fetch failed: ${res.status} ${await res.text()}`);
    }
    return await res.json();
  }

  return { placeOrder, fetchPositions, closePosition, fetchCandles, fetchAccount };
}
