// server.js
// Pump Web Aggregator: 1 upstream WS → many downstream website clients

const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(cors());
app.use(express.json());

// ====== CONFIG ======
const PORT = process.env.PORT || 8080;

// Upstream PumpPortal socket (this matches the methods you saw in your error)
// Docs/examples commonly use:
const UPSTREAM_WS = process.env.UPSTREAM_WS || "wss://pumpportal.fun/api/data";

// How many rows to keep in memory for new clients ("batch" send)
const CACHE_LIMIT = Number(process.env.CACHE_LIMIT || 200);

// How many *recent tokens* we auto-subscribe to for trades
// (important: subscribing to every token forever will explode)
const TRADE_SUB_LIMIT = Number(process.env.TRADE_SUB_LIMIT || 150);

// Optional: only subscribe trades after a token is created AND it passes this SOL filter (create event sol)
const MIN_SOL_CREATE_TO_TRACK = Number(process.env.MIN_SOL_CREATE_TO_TRACK || 0);

// Reconnect timing
const RECONNECT_MS = Number(process.env.RECONNECT_MS || 2000);

// ====== STATE ======
let upstream = null;
let upstreamConnected = false;

const downstreamClients = new Set();

// Rolling cache of normalized rows
const cachedRows = [];

// Keep track of which mints we already subscribed to for trades
const subscribedTradeMints = new Set();
// Also keep insertion order so we can drop oldest
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
      } catch (e) {
        // ignore send errors
      }
    }
  }
}

function normCreate(msg) {
  // PumpPortal create/new token event usually contains:
  // mint, trader (deployer), solAmount, name, symbol, timestamp (varies)
  // We'll normalize what we can.
  return {
    kind: "create",
    t: Date.now(),
    mint: msg.mint || msg.tokenAddress || msg.ca || "",
    trader: msg.trader || msg.owner || msg.deployer || "",
    sol: Number(msg.solAmount ?? msg.sol ?? 0),
    name: msg.name || msg.tokenName || "",
    symbol: msg.symbol || msg.ticker || "",
    raw: msg,
  };
}

function normTrade(msg) {
  // PumpPortal trade event commonly includes:
  // mint, trader, txType ("buy"/"sell"), solAmount, timestamp
  return {
    kind: "trade",
    t: Date.now(),
    mint: msg.mint || msg.tokenAddress || msg.ca || "",
    trader: msg.trader || msg.owner || "",
    side: (msg.txType || msg.side || "").toLowerCase(), // buy/sell
    sol: Number(msg.solAmount ?? msg.sol ?? 0),
    name: msg.name || "",
    symbol: msg.symbol || "",
    raw: msg,
  };
}

function maybeSubscribeTrade(mint) {
  if (!mint) return;
  if (subscribedTradeMints.has(mint)) return;

  // Enforce limit: drop oldest from our tracking sets (no "unsubscribe" call assumed)
  subscribedTradeMints.add(mint);
  subscribedTradeQueue.push(mint);

  while (subscribedTradeQueue.length > TRADE_SUB_LIMIT) {
    const oldest = subscribedTradeQueue.shift();
    subscribedTradeMints.delete(oldest);
    // Note: PumpPortal may or may not support "unsubscribe" methods.
    // We simply stop caring about old mints; upstream may keep sending if it doesn't support unsubscribe.
  }

  if (upstream && upstream.readyState === WebSocket.OPEN) {
    const payload = { method: "subscribeTokenTrade", keys: [mint] };
    try {
      upstream.send(JSON.stringify(payload));
    } catch (e) {}
  }
}

function connectUpstream() {
  if (upstream && (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING)) {
    return;
  }

  console.log("[UPSTREAM] Connecting:", UPSTREAM_WS);
  upstream = new WebSocket(UPSTREAM_WS);

  upstream.on("open", () => {
    upstreamConnected = true;
    console.log("[UPSTREAM] Connected");

    // 1) Always subscribe to new token creation events
    try {
      upstream.send(JSON.stringify({ method: "subscribeNewToken" }));
    } catch (e) {}

    // Optional ping to keep some proxies happy
    // (ws auto-handles ping/pong at protocol level, but this is harmless)
    if (!upstream._keepAlive) {
      upstream._keepAlive = setInterval(() => {
        try {
          if (upstream && upstream.readyState === WebSocket.OPEN) upstream.ping();
        } catch (e) {}
      }, 25000);
    }
  });

  upstream.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return;
    }

    // Detect create vs trade:
    // PumpPortal trade messages often include txType.
    const isTrade = typeof msg.txType === "string" || msg.type === "trade";

    if (isTrade) {
      const row = normTrade(msg);
      pushCache(row);
      broadcast({ type: "row", row });
      return;
    }

    // Otherwise treat as "create/new token"
    const row = normCreate(msg);

    // Optional filter: only subscribe trades for tokens above some deploy SOL
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
    } catch (e) {}
    upstream = null;
    setTimeout(connectUpstream, RECONNECT_MS);
  });

  upstream.on("error", (err) => {
    console.log("[UPSTREAM] Error:", err?.message || err);
    upstreamConnected = false;
    // Let "close" handle reconnect; some errors don’t trigger close immediately.
  });
}

// ====== DOWNSTREAM WS SERVER ======
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

wss.on("connection", (ws) => {
  downstreamClients.add(ws);

  // Send initial snapshot
  try {
    ws.send(
      JSON.stringify({
        type: "batch",
        rows: cachedRows.slice(-CACHE_LIMIT),
      })
    );
  } catch (e) {}

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
    tradeSubLimit: TRADE_SUB_LIMIT,
    trackingMints: subscribedTradeMints.size,
  });
});

// ====== START ======
server.listen(PORT, () => {
  console.log(`[HTTP] Listening on :${PORT}`);
  connectUpstream();
});
