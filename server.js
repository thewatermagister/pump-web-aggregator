// server.js
// Pump Web Aggregator: 1 upstream WS → many downstream website clients
// Streams BOTH:
//   - kind:"create" (new token)
//   - kind:"trade"  (buy/sell trades with side:"buy"|"sell")

const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(cors());
app.use(express.json());

// ====== CONFIG ======
const PORT = process.env.PORT || 8080;

// PumpPortal upstream
const UPSTREAM_WS = process.env.UPSTREAM_WS || "wss://pumpportal.fun/api/data";

// Cache for new clients
const CACHE_LIMIT = Number(process.env.CACHE_LIMIT || 200);

// How many recent mints to subscribe for trades (cap to prevent runaway)
const TRADE_SUB_LIMIT = Number(process.env.TRADE_SUB_LIMIT || 150);

// Only auto-subscribe to trades for tokens whose CREATE sol >= this
const MIN_SOL_CREATE_TO_TRACK = Number(process.env.MIN_SOL_CREATE_TO_TRACK || 0);

// Reconnect timing
const RECONNECT_MS = Number(process.env.RECONNECT_MS || 2000);

// ====== STATE ======
let upstream = null;
let upstreamConnected = false;

const downstreamClients = new Set();
const cachedRows = [];

// Track subscribed mints for trade stream
const subscribedTradeMints = new Set();
const subscribedTradeQueue = [];

// ====== HELPERS ======
function pushCache(row) {
  cachedRows.push(row);
  if (cachedRows.length > CACHE_LIMIT) cachedRows.shift();
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of downstreamClients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(msg);
      } catch {
        // ignore
      }
    }
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normCreate(msg) {
  return {
    kind: "create",
    t: msg.timestamp ? Number(msg.timestamp) : Date.now(),
    mint: msg.mint || msg.tokenAddress || msg.ca || "",
    trader: msg.trader || msg.owner || msg.deployer || "",
    sol: num(msg.solAmount ?? msg.sol ?? 0),
    name: msg.name || msg.tokenName || "",
    symbol: msg.symbol || msg.ticker || "",
    raw: msg,
  };
}

function detectSide(msg) {
  // Most common: msg.txType = "buy"/"sell"
  if (typeof msg.txType === "string") {
    const s = msg.txType.toLowerCase();
    if (s.includes("buy")) return "buy";
    if (s.includes("sell")) return "sell";
  }

  // Sometimes: msg.side = "buy"/"sell"
  if (typeof msg.side === "string") {
    const s = msg.side.toLowerCase();
    if (s.includes("buy")) return "buy";
    if (s.includes("sell")) return "sell";
  }

  // Sometimes booleans:
  if (msg.isBuy === true) return "buy";
  if (msg.isSell === true) return "sell";

  // Unknown
  return "";
}

function normTrade(msg) {
  return {
    kind: "trade",
    t: msg.timestamp ? Number(msg.timestamp) : Date.now(),
    mint: msg.mint || msg.tokenAddress || msg.ca || "",
    trader: msg.trader || msg.owner || msg.wallet || "",
    side: detectSide(msg), // "buy" | "sell" | ""
    sol: num(msg.solAmount ?? msg.sol ?? 0),
    name: msg.name || "",
    symbol: msg.symbol || "",
    raw: msg,
  };
}

function maybeSubscribeTrade(mint) {
  if (!mint) return;
  if (subscribedTradeMints.has(mint)) return;

  subscribedTradeMints.add(mint);
  subscribedTradeQueue.push(mint);

  // Drop oldest if over limit
  while (subscribedTradeQueue.length > TRADE_SUB_LIMIT) {
    const oldest = subscribedTradeQueue.shift();
    subscribedTradeMints.delete(oldest);
    // NOTE: we do not attempt upstream "unsubscribe" because API support varies.
    // This keeps OUR tracking bounded; upstream may keep sending older ones anyway.
  }

  if (upstream && upstream.readyState === WebSocket.OPEN) {
    const payload = { method: "subscribeTokenTrade", keys: [mint] };
    try {
      upstream.send(JSON.stringify(payload));
    } catch {
      // ignore
    }
  }
}

function connectUpstream() {
  if (
    upstream &&
    (upstream.readyState === WebSocket.OPEN ||
      upstream.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  console.log("[UPSTREAM] Connecting:", UPSTREAM_WS);
  upstream = new WebSocket(UPSTREAM_WS);

  upstream.on("open", () => {
    upstreamConnected = true;
    console.log("[UPSTREAM] Connected");

    // Always subscribe to new token creation
    try {
      upstream.send(JSON.stringify({ method: "subscribeNewToken" }));
    } catch {}

    // Keepalive ping
    if (!upstream._keepAlive) {
      upstream._keepAlive = setInterval(() => {
        try {
          if (upstream && upstream.readyState === WebSocket.OPEN) upstream.ping();
        } catch {}
      }, 25000);
    }
  });

  upstream.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // Trade detection: txType present OR explicit type
    const isTrade =
      typeof msg.txType === "string" ||
      msg.type === "trade" ||
      msg.event === "trade" ||
      msg.isBuy === true ||
      msg.isSell === true;

    if (isTrade) {
      const row = normTrade(msg);

      // If it didn't parse to buy/sell, we still forward it (UI can ignore if needed)
      pushCache(row);
      broadcast({ type: "row", row });
      return;
    }

    // Otherwise: treat as create/new token
    const row = normCreate(msg);

    // Auto-subscribe to trades for this mint if it passes the create SOL threshold
    if (row.sol >= MIN_SOL_CREATE_TO_TRACK) {
      maybeSubscribeTrade(row.mint);
    }

    pushCache(row);
    broadcast({ type: "row", row });
  });

  upstream.on("close", () => {
    console.log("[UPSTREAM] Closed");
    upstreamConnected = false;
    try {
      if (upstream && upstream._keepAlive) clearInterval(upstream._keepAlive);
    } catch {}
    upstream = null;
    setTimeout(connectUpstream, RECONNECT_MS);
  });

  upstream.on("error", (err) => {
    console.log("[UPSTREAM] Error:", err?.message || err);
    upstreamConnected = false;
    // let close/reconnect handle
  });
}

// ====== DOWNSTREAM WS SERVER ======
const server = http.createServer(app);

// IMPORTANT: no fixed path here.
// We accept both "/" and "/ws" so your Framer WS_URL can be either:
//   wss://yourapp.up.railway.app
//   wss://yourapp.up.railway.app/ws
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws, req) => {
  const path = (req && req.url) || "/";
  if (!(path === "/" || path.startsWith("/ws"))) {
    try {
      ws.close();
    } catch {}
    return;
  }

  downstreamClients.add(ws);

  // Send initial snapshot
  try {
    ws.send(
      JSON.stringify({
        type: "batch",
        rows: cachedRows.slice(-CACHE_LIMIT),
      })
    );
  } catch {}

  ws.on("close", () => downstreamClients.delete(ws));
  ws.on("error", () => downstreamClients.delete(ws));
});

// ====== HTTP ROUTES ======
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    pumpConnected: upstreamConnected,
    clients: downstreamClients.size,
    cachedRows: cachedRows.length,
    cacheLimit: CACHE_LIMIT,
    tradeSubLimit: TRADE_SUB_LIMIT,
    trackingMints: subscribedTradeMints.size,
    minCreateSolToTrack: MIN_SOL_CREATE_TO_TRACK,
    upstream: UPSTREAM_WS,
  });
});

// ====== START ======
server.listen(PORT, () => {
  console.log(`[HTTP] Listening on :${PORT}`);
  connectUpstream();
});
