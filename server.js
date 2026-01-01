// server.js
// Pump Web Aggregator: 1 upstream WS → many downstream website clients
// Fix: cache mint -> (name,symbol) from create events so trade rows can show name/symbol too.

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
// Also keep insertion order so we can drop oldest
const subscribedTradeQueue = [];

// ✅ Mint metadata cache: mint -> { name, symbol }
const mintMeta = new Map();

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

function pickMint(msg) {
  return msg.mint || msg.tokenAddress || msg.ca || msg.address || "";
}

function pickTrader(msg) {
  // PumpPortal varies field names across events
  return (
    msg.trader ||
    msg.traderPublicKey ||
    msg.owner ||
    msg.user ||
    msg.deployer ||
    msg.from ||
    ""
  );
}

function pickSol(msg) {
  const v = msg.solAmount ?? msg.sol ?? msg.amountSol ?? msg.amount ?? 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function pickName(msg) {
  return msg.name || msg.tokenName || msg.meta?.name || "";
}

function pickSymbol(msg) {
  return msg.symbol || msg.ticker || msg.meta?.symbol || "";
}

function rememberMeta(mint, name, symbol) {
  if (!mint) return;

  const prev = mintMeta.get(mint) || { name: "", symbol: "" };
  const next = {
    name: (name && String(name).trim()) || prev.name || "",
    symbol: (symbol && String(symbol).trim()) || prev.symbol || "",
  };

  // Only store if we have something useful
  if (next.name || next.symbol) mintMeta.set(mint, next);
}

function getMeta(mint) {
  return mintMeta.get(mint) || { name: "", symbol: "" };
}

function normCreate(msg) {
  const mint = pickMint(msg);
  const name = pickName(msg);
  const symbol = pickSymbol(msg);

  // ✅ Store meta so trades can display name/symbol later
  rememberMeta(mint, name, symbol);

  return {
    kind: "create",
    t: Date.now(),
    mint,
    trader: pickTrader(msg),
    sol: pickSol(msg),
    name,
    symbol,
    raw: msg,
  };
}

function normTrade(msg) {
  const mint = pickMint(msg);
  const side = (msg.txType || msg.side || msg.tradeType || "").toLowerCase(); // buy/sell

  // ✅ Many trade msgs don't have name/symbol — fill from cache
  const meta = getMeta(mint);
  const name = pickName(msg) || meta.name || "";
  const symbol = pickSymbol(msg) || meta.symbol || "";

  // If trade contains name/symbol (rare), update cache too
  rememberMeta(mint, name, symbol);

  return {
    kind: "trade",
    t: Date.now(),
    mint,
    trader: pickTrader(msg),
    side,
    sol: pickSol(msg),
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

  while (subscribedTradeQueue.length > TRADE_SUB_LIMIT) {
    const oldest = subscribedTradeQueue.shift();
    subscribedTradeMints.delete(oldest);
    // Note: PumpPortal may or may not support "unsubscribe".
    // We simply stop tracking old mints locally.
  }

  if (upstream && upstream.readyState === WebSocket.OPEN) {
    const payload = { method: "subscribeTokenTrade", keys: [mint] };
    try {
      upstream.send(JSON.stringify(payload));
    } catch (e) {}
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

    // 1) Always subscribe to new token creation events
    try {
      upstream.send(JSON.stringify({ method: "subscribeNewToken" }));
    } catch (e) {}

    // Keepalive ping
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

    // Detect trade:
    const isTrade =
      typeof msg.txType === "string" ||
      msg.type === "trade" ||
      msg.event === "trade";

    if (isTrade) {
      const row = normTrade(msg);
      pushCache(row);
      broadcast({ type: "row", row });
      return;
    }

    // Otherwise treat as create/new token
    const row = normCreate(msg);

    // Optional: only subscribe trades for tokens above some deploy SOL
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

// ====== HTTP ROUTES ======
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    pumpConnected: upstreamConnected,
    clients: downstreamClients.size,
    cachedRows: cachedRows.length,
    tradeSubLimit: TRADE_SUB_LIMIT,
    trackingMints: subscribedTradeMints.size,
    metaMints: mintMeta.size,
  });
});

// ====== START ======
server.listen(PORT, () => {
  console.log(`[HTTP] Listening on :${PORT}`);
  connectUpstream();
});
