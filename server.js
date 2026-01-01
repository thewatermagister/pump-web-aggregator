// server.js
// FoxScan Pump Web Aggregator: 1 upstream WS → many downstream website clients

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

// How many token metadatas to keep (mint -> {name,symbol})
const META_LIMIT = Number(process.env.META_LIMIT || 3000);

// ====== STATE ======
let upstream = null;
let upstreamConnected = false;

const downstreamClients = new Set();

// Rolling cache of normalized rows
const cachedRows = [];

// Keep track of which mints we already subscribed to for trades
const subscribedTradeMints = new Set();
const subscribedTradeQueue = [];

// Token metadata cache (mint -> {name, symbol, lastSeen})
const tokenMeta = new Map(); // insertion-ordered

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

function upsertMeta(mint, name, symbol) {
  if (!mint) return;

  const n = (name || "").trim();
  const s = (symbol || "").trim();

  // only store if we actually have something meaningful
  if (!n && !s) return;

  const existing = tokenMeta.get(mint) || {};
  const merged = {
    name: n || existing.name || "",
    symbol: s || existing.symbol || "",
    lastSeen: Date.now(),
  };

  // Refresh insertion order (for LRU-ish eviction)
  if (tokenMeta.has(mint)) tokenMeta.delete(mint);
  tokenMeta.set(mint, merged);

  // Evict oldest if over limit
  while (tokenMeta.size > META_LIMIT) {
    const oldestKey = tokenMeta.keys().next().value;
    tokenMeta.delete(oldestKey);
  }
}

function fillMeta(row) {
  if (!row?.mint) return row;

  // If row already has both, great
  const hasName = !!(row.name && row.name.trim());
  const hasSymbol = !!(row.symbol && row.symbol.trim());
  if (hasName && hasSymbol) return row;

  const meta = tokenMeta.get(row.mint);
  if (!meta) return row;

  return {
    ...row,
    name: hasName ? row.name : meta.name || row.name,
    symbol: hasSymbol ? row.symbol : meta.symbol || row.symbol,
  };
}

function maybeSubscribeTrade(mint) {
  if (!mint) return;
  if (subscribedTradeMints.has(mint)) return;

  subscribedTradeMints.add(mint);
  subscribedTradeQueue.push(mint);

  while (subscribedTradeQueue.length > TRADE_SUB_LIMIT) {
    const oldest = subscribedTradeQueue.shift();
    subscribedTradeMints.delete(oldest);
  }

  if (upstream && upstream.readyState === WebSocket.OPEN) {
    const payload = { method: "subscribeTokenTrade", keys: [mint] };
    try {
      upstream.send(JSON.stringify(payload));
    } catch (e) {}
  }
}

// classify into exact kinds your UI expects: "create" | "buy" | "sell"
function classifyKind(msg) {
  const tx = typeof msg.txType === "string" ? msg.txType.toLowerCase() : "";
  if (tx === "create" || tx === "buy" || tx === "sell") return tx;

  // fallback heuristics
  const side = (msg.side || msg.tx || "").toLowerCase();
  if (side === "buy" || side === "sell") return side;

  return "create";
}

// Normalize CREATE (new token)
function normCreate(msg) {
  return {
    kind: "create", // UI can render this as Dev
    t: Date.now(),
    mint: msg.mint || msg.tokenAddress || msg.ca || "",
    trader: msg.traderPublicKey || msg.trader || msg.owner || msg.deployer || "",
    sol: Number(msg.solAmount ?? msg.sol ?? 0),
    name: msg.name || msg.tokenName || "",
    symbol: msg.symbol || msg.ticker || "",
    raw: msg,
  };
}

// Normalize BUY/SELL trade
function normTrade(msg, kind /* "buy"|"sell" */) {
  return {
    kind, // IMPORTANT: keep as "buy" or "sell" so your Type column stays correct
    t: Date.now(),
    mint: msg.mint || msg.tokenAddress || msg.ca || "",
    trader: msg.traderPublicKey || msg.trader || msg.owner || "",
    sol: Number(msg.solAmount ?? msg.sol ?? 0),

    // many trade msgs won't have these → we will fill from cache
    name: msg.name || "",
    symbol: msg.symbol || "",
    raw: msg,
  };
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

    // Always subscribe to new token creation events
    try {
      upstream.send(JSON.stringify({ method: "subscribeNewToken" }));
    } catch (e) {}

    // Keepalive ping (protocol-level)
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

    const kind = classifyKind(msg);

    // buy/sell
    if (kind === "buy" || kind === "sell") {
      let row = normTrade(msg, kind);

      // If PumpPortal *did* include meta sometimes, store it too
      upsertMeta(row.mint, row.name, row.symbol);

      // Fill meta from cache if missing
      row = fillMeta(row);

      pushCache(row);
      broadcast({ type: "row", row });
      return;
    }

    // create
    let row = normCreate(msg);

    // store meta for this mint (this is the key fix)
    upsertMeta(row.mint, row.name, row.symbol);

    // subscribe to trades for this token if it passes threshold
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

app.get("/", (_req, res) => res.send("FoxScan aggregator OK"));
app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    upstreamConnected,
    cached: cachedRows.length,
    metaCached: tokenMeta.size,
    clients: downstreamClients.size,
  })
);

server.listen(PORT, () => {
  console.log(`[SERVER] Listening on :${PORT}`);
  connectUpstream();
});
