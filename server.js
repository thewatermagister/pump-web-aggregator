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

// Upstream PumpPortal socket
const UPSTREAM_WS = process.env.UPSTREAM_WS || "wss://pumpportal.fun/api/data";

// How many rows to keep in memory for new clients ("batch" send)
const CACHE_LIMIT = Number(process.env.CACHE_LIMIT || 200);

// How many *recent tokens* we auto-subscribe to for trades
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
const subscribedTradeQueue = [];

// NEW: In-memory metadata cache for token name/symbol
const mintMetadata = new Map();

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
      } catch (e) {}
    }
  }
}

// Normalize CREATE (new token)
function normCreate(msg) {
  const mint = msg.mint || msg.tokenAddress || msg.ca || "";
  const name = msg.name || msg.tokenName || "";
  const symbol = msg.symbol || msg.ticker || "";

  // Store metadata for future trades
  if (mint && (name || symbol)) {
    mintMetadata.set(mint, { name, symbol });
  }

  return {
    kind: "create",
    t: Date.now(),
    mint,
    trader: msg.traderPublicKey || msg.trader || msg.owner || msg.deployer || "",
    sol: Number(msg.solAmount ?? msg.sol ?? 0),
    name,
    symbol,
    raw: msg,
  };
}

// Normalize TRADE (buy/sell)
function normTrade(msg) {
  const side = (msg.txType || msg.side || "").toLowerCase(); // buy/sell
  const mint = msg.mint || msg.tokenAddress || msg.ca || "";

  let name = msg.name || "";
  let symbol = msg.symbol || "";

  // Enrich with cached metadata from create event
  const cached = mintMetadata.get(mint);
  if (cached) {
    name = cached.name || name;
    symbol = cached.symbol || symbol;
  }

  return {
    kind: "trade",
    t: Date.now(),
    mint,
    trader: msg.traderPublicKey || msg.trader || msg.owner || "",
    side,
    sol: Number(msg.solAmount ?? msg.sol ?? 0),
    name,
    symbol,
    raw: msg,
  };
}

function maybeSubscribeTrade(mint) {
  if (!mint) return;
  if (subscribedTradeMints.has(mint)) return;

  subscribedTradeMints.add(mint);
  subscribedTradeQueue.push(mint);

  // LRU eviction
  while (subscribedTradeQueue.length > TRADE_SUB_LIMIT) {
    const oldest = subscribedTradeQueue.shift();
    subscribedTradeMints.delete(oldest);

    // Optional: unsubscribe from upstream (PumpPortal supports it)
    if (upstream && upstream.readyState === WebSocket.OPEN) {
      try {
        upstream.send(JSON.stringify({ method: "unsubscribeTokenTrade", keys: [oldest] }));
      } catch (e) {}
    }
  }

  if (upstream && upstream.readyState === WebSocket.OPEN) {
    const payload = { method: "subscribeTokenTrade", keys: [mint] };
    try {
      upstream.send(JSON.stringify(payload));
    } catch (e) {}
  }
}

function classifyMsg(msg) {
  const tx = typeof msg.txType === "string" ? msg.txType.toLowerCase() : "";

  if (tx === "buy" || tx === "sell") return "trade";
  if (tx === "create") return "create";

  const side = (msg.side || "").toLowerCase();
  if (side === "buy" || side === "sell") return "trade";

  return "create";
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

    // Subscribe to new tokens
    try {
      upstream.send(JSON.stringify({ method: "subscribeNewToken" }));
    } catch (e) {}

    // Resubscribe to existing trade subscriptions after reconnect
    if (subscribedTradeMints.size > 0) {
      const mints = Array.from(subscribedTradeMints);
      const chunkSize = 50;
      for (let i = 0; i < mints.length; i += chunkSize) {
        const chunk = mints.slice(i, i + chunkSize);
        try {
          upstream.send(JSON.stringify({ method: "subscribeTokenTrade", keys: chunk }));
        } catch (e) {}
      }
    }

    // Keepalive
    if (upstream._keepAlive) clearInterval(upstream._keepAlive);
    upstream._keepAlive = setInterval(() => {
      if (upstream.readyState === WebSocket.OPEN) {
        try {
          upstream.ping();
        } catch (e) {}
      }
    }, 25000);
  });

  upstream.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return;
    }

    const type = classifyMsg(msg);

    if (type === "trade") {
      const row = normTrade(msg);
      pushCache(row);
      broadcast({ type: "row", row });
      return;
    }

    // create
    const row = normCreate(msg);

    if (row.sol >= MIN_SOL_CREATE_TO_TRACK) {
      maybeSubscribeTrade(row.mint);
    }

    pushCache(row);
    broadcast({ type: "row", row });
  });

  upstream.on("close", () => {
    console.log("[UPSTREAM] Closed");
    upstreamConnected = false;
    if (upstream._keepAlive) {
      clearInterval(upstream._keepAlive);
      upstream._keepAlive = null;
    }
    upstream = null;
    setTimeout(connectUpstream, RECONNECT_MS);
  });

  upstream.on("error", (err) => {
    console.log("[UPSTREAM] Error:", err?.message || err);
    upstreamConnected = false;
  });
}

// ====== DOWNSTREAM WS SERVER ======
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

wss.on("connection", (ws) => {
  downstreamClients.add(ws);

  // Send initial snapshot (newest first)
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

app.get("/", (_req, res) => res.send("FoxScan aggregator OK"));
app.get("/health", (_req, res) =>
  res.json({ ok: true, upstreamConnected, cached: cachedRows.length })
);

server.listen(PORT, () => {
  console.log(`[SERVER] Listening on :${PORT}`);
  connectUpstream();
});
