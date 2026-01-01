// server.js
// Pump Web Aggregator: 1 upstream WS → many downstream website clients
// Sends BOTH create + trade rows, with trade.side = "buy" | "sell" so UI can filter Buys/Sells/All.

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

// Cache last N rows for new clients
const CACHE_LIMIT = Number(process.env.CACHE_LIMIT || 200);

// How many recent mints we will subscribe to for trades
const TRADE_SUB_LIMIT = Number(process.env.TRADE_SUB_LIMIT || 150);

// Optional: only subscribe to trades after a create >= this SOL
const MIN_SOL_CREATE_TO_TRACK = Number(process.env.MIN_SOL_CREATE_TO_TRACK || 0);

// Reconnect timing
const RECONNECT_MS = Number(process.env.RECONNECT_MS || 2000);

// ====== STATE ======
let upstream = null;
let upstreamConnected = false;

const downstreamClients = new Set();
const cachedRows = [];

// Track trade subscriptions (best-effort; upstream may not support unsubscribe)
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
      } catch (_) {}
    }
  }
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pick(obj, keys, fallback = "") {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== "") return obj[k];
  }
  return fallback;
}

function normCreate(msg) {
  return {
    kind: "create",
    t: Date.now(),
    mint: pick(msg, ["mint", "tokenAddress", "ca", "address"], ""),
    trader: pick(msg, ["trader", "owner", "deployer", "wallet"], ""),
    sol: safeNum(pick(msg, ["solAmount", "sol", "amountSol"], 0), 0),
    name: pick(msg, ["name", "tokenName"], ""),
    symbol: pick(msg, ["symbol", "ticker"], ""),
    raw: msg,
  };
}

function normTrade(msg) {
  const sideRaw = String(pick(msg, ["txType", "side", "tradeType", "direction"], "")).toLowerCase();
  const side = sideRaw.includes("buy") ? "buy" : sideRaw.includes("sell") ? "sell" : "";

  return {
    kind: "trade",
    t: Date.now(),
    mint: pick(msg, ["mint", "tokenAddress", "ca", "address"], ""),
    trader: pick(msg, ["trader", "owner", "wallet"], ""),
    side, // "buy" | "sell" | ""
    sol: safeNum(pick(msg, ["solAmount", "sol", "amountSol"], 0), 0),
    name: pick(msg, ["name", "tokenName"], ""),
    symbol: pick(msg, ["symbol", "ticker"], ""),
    raw: msg,
  };
}

function sendUpstream(payload) {
  if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
  try {
    upstream.send(JSON.stringify(payload));
  } catch (_) {}
}

function maybeSubscribeTrade(mint) {
  if (!mint) return;
  if (subscribedTradeMints.has(mint)) return;

  subscribedTradeMints.add(mint);
  subscribedTradeQueue.push(mint);

  // enforce cap
  while (subscribedTradeQueue.length > TRADE_SUB_LIMIT) {
    const oldest = subscribedTradeQueue.shift();
    subscribedTradeMints.delete(oldest);

    // If PumpPortal ever supports unsub:
    // sendUpstream({ method: "unsubscribeTokenTrade", keys: [oldest] });
    // For now, we just stop tracking it locally.
  }

  sendUpstream({ method: "subscribeTokenTrade", keys: [mint] });
}

// Detect message type from PumpPortal
function isTradeMessage(msg) {
  // Common patterns: txType exists, or explicit type:"trade"
  if (!msg || typeof msg !== "object") return false;
  if (typeof msg.txType === "string") return true;
  if (String(msg.type || "").toLowerCase() === "trade") return true;
  // Some payloads might include "side" or "direction"
  if (typeof msg.side === "string" || typeof msg.direction === "string") return true;
  return false;
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

    // Subscribe to creates
    sendUpstream({ method: "subscribeNewToken" });

    // Re-subscribe trades for what we're tracking (helps after reconnect)
    // (This is safe even if duplicates; we de-dupe locally)
    const mints = Array.from(subscribedTradeMints);
    for (let i = 0; i < mints.length; i += 50) {
      sendUpstream({ method: "subscribeTokenTrade", keys: mints.slice(i, i + 50) });
    }

    // Keepalive ping (some proxies/timeouts)
    if (!upstream._keepAlive) {
      upstream._keepAlive = setInterval(() => {
        try {
          if (upstream && upstream.readyState === WebSocket.OPEN) upstream.ping();
        } catch (_) {}
      }, 25000);
    }
  });

  upstream.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (_) {
      return;
    }

    // If PumpPortal returns an error about methods, surface it
    // Example: { error: "...", message: "Invalid message. 'method' must be ..." }
    if (msg && (msg.error || (typeof msg.message === "string" && msg.message.toLowerCase().includes("invalid message")))) {
      console.log("[UPSTREAM] Error payload:", msg);
      return;
    }

    if (isTradeMessage(msg)) {
      const row = normTrade(msg);

      // If we somehow got a trade for a mint we aren't tracking, optionally start tracking it
      // (usually not needed; trades should only arrive after subscribeTokenTrade)
      if (row.mint && !subscribedTradeMints.has(row.mint)) {
        // don't auto-add here; could be spammy. leave commented unless you want it.
        // maybeSubscribeTrade(row.mint);
      }

      pushCache(row);
      broadcast({ type: "row", row });
      return;
    }

    // Otherwise treat as create/new token
    const row = normCreate(msg);

    // Subscribe to trades for this mint (optional create SOL gate)
    if (row.mint && row.sol >= MIN_SOL_CREATE_TO_TRACK) {
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
    } catch (_) {}
    upstream = null;
    setTimeout(connectUpstream, RECONNECT_MS);
  });

  upstream.on("error", (err) => {
    console.log("[UPSTREAM] Error:", err?.message || err);
    upstreamConnected = false;
    // close handler will reconnect if it closes; if it doesn't, we still keep trying on next close.
  });
}

// ====== DOWNSTREAM WS SERVER ======
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

wss.on("connection", (ws) => {
  downstreamClients.add(ws);

  // Send initial snapshot
  try {
    ws.send(JSON.stringify({ type: "batch", rows: cachedRows.slice(-CACHE_LIMIT) }));
  } catch (_) {}

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
    minSolCreateToTrack: MIN_SOL_CREATE_TO_TRACK,
  });
});

// ====== START ======
server.listen(PORT, () => {
  console.log(`[HTTP] Listening on :${PORT}`);
  connectUpstream();
});
