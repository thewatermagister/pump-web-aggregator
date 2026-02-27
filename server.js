// server.js
// Pump Web Aggregator: 1 upstream WS → many downstream website clients
// Adds:
//  - Trending Top 10 (rolling 10m from trade flow)
//  - Community Ranked Top 10 (upvotes with 10m TTL) via downstream WS messages

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

// Trending/voting windows
const TREND_WINDOW_MS = Number(process.env.TREND_WINDOW_MS || 10 * 60 * 1000); // 10 minutes
const VOTE_TTL_MS = Number(process.env.VOTE_TTL_MS || 10 * 60 * 1000); // 10 minutes

// How often we broadcast trending/ranked updates (ms)
const TREND_BROADCAST_MIN_MS = Number(process.env.TREND_BROADCAST_MIN_MS || 2000);
const RANK_BROADCAST_MIN_MS = Number(process.env.RANK_BROADCAST_MIN_MS || 1000);

// Cleanup tick
const CLEANUP_TICK_MS = Number(process.env.CLEANUP_TICK_MS || 5000);

// ====== STATE ======
let upstream = null;
let upstreamConnected = false;

const downstreamClients = new Set();

// Rolling cache of normalized rows
const cachedRows = [];

// Keep track of which mints we already subscribed to for trades
const subscribedTradeMints = new Set();
const subscribedTradeQueue = [];

// In-memory metadata cache for token name/symbol
const mintMetadata = new Map();

// TRENDING: mint -> array of { t, sol, trader, side }
const tradeEventsByMint = new Map();

// VOTING: mint -> { count, expiresAt, lastVoteAt, name, symbol }
const votesByMint = new Map();

let lastTrendingBroadcast = 0;
let lastRankedBroadcast = 0;

// ====== HELPERS ======
function now() {
  return Date.now();
}

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
    t: now(),
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
    t: now(),
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
        upstream.send(
          JSON.stringify({ method: "unsubscribeTokenTrade", keys: [oldest] })
        );
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

// ====== TRENDING HELPERS ======
function recordTradeForTrending(row) {
  if (!row?.mint) return;
  let arr = tradeEventsByMint.get(row.mint);
  if (!arr) {
    arr = [];
    tradeEventsByMint.set(row.mint, arr);
  }
  arr.push({
    t: row.t,
    sol: Number(row.sol || 0),
    trader: row.trader || "",
    side: row.side || "",
  });
}

function pruneTrending() {
  const cutoff = now() - TREND_WINDOW_MS;
  for (const [mint, arr] of tradeEventsByMint.entries()) {
    while (arr.length && arr[0].t < cutoff) arr.shift();
    if (!arr.length) tradeEventsByMint.delete(mint);
  }
}

function computeTrendingTop10() {
  pruneTrending();

  const scored = [];
  for (const [mint, arr] of tradeEventsByMint.entries()) {
    let vol = 0;
    let buys = 0;
    let sells = 0;
    const traders = new Set();

    for (const e of arr) {
      vol += Number(e.sol || 0);
      if (e.trader) traders.add(e.trader);
      if (e.side === "buy") buys++;
      if (e.side === "sell") sells++;
    }

    // Simple tuneable score:
    // - SOL volume dominates
    // - unique traders adds weight
    // - buys adds a small weight
    const score = vol + traders.size * 0.25 + buys * 0.05;

    const meta = mintMetadata.get(mint) || {};
    scored.push({
      mint,
      name: meta.name || "",
      symbol: meta.symbol || "",
      // If you later add DexScreener enrichment, fill this in:
      mc: null,
      info: `Vol10m: ${vol.toFixed(2)} SOL • Traders: ${traders.size} • Buys: ${buys} • Sells: ${sells}`,
      score,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 10);
}

function broadcastTrending(force = false) {
  const t = now();
  if (!force && t - lastTrendingBroadcast < TREND_BROADCAST_MIN_MS) return;
  lastTrendingBroadcast = t;
  broadcast({ type: "trending", rows: computeTrendingTop10() });
}

// ====== VOTING HELPERS ======
function pruneVotes() {
  const t = now();
  for (const [mint, v] of votesByMint.entries()) {
    if (!v || v.expiresAt <= t) votesByMint.delete(mint);
  }
}

function computeRankedTop10() {
  pruneVotes();

  const rows = Array.from(votesByMint.entries()).map(([mint, v]) => {
    const meta = mintMetadata.get(mint) || {};
    const name = v.name || meta.name || "";
    const symbol = v.symbol || meta.symbol || "";
    const secondsLeft = Math.max(0, Math.floor((v.expiresAt - now()) / 1000));

    return {
      mint,
      name,
      symbol,
      mc: null,
      votes: v.count,
      expiresAt: v.expiresAt,
      info: `Upvotes: ${v.count} • Expires in ${secondsLeft}s`,
    };
  });

  rows.sort((a, b) => (b.votes - a.votes) || (b.expiresAt - a.expiresAt));
  return rows.slice(0, 10);
}

function broadcastRanked(force = false) {
  const t = now();
  if (!force && t - lastRankedBroadcast < RANK_BROADCAST_MIN_MS) return;
  lastRankedBroadcast = t;
  broadcast({ type: "ranked", rows: computeRankedTop10() });
}

// ====== UPSTREAM ======
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
          upstream.send(
            JSON.stringify({ method: "subscribeTokenTrade", keys: chunk })
          );
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
      recordTradeForTrending(row);

      pushCache(row);
      broadcast({ type: "row", row });

      // update trending periodically
      broadcastTrending(false);
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

    // Send the two new panels immediately
    ws.send(JSON.stringify({ type: "trending", rows: computeTrendingTop10() }));
    ws.send(JSON.stringify({ type: "ranked", rows: computeRankedTop10() }));
  } catch (e) {}

  // Accept downstream messages (votes, optional ping)
  ws.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch (e) {
      return;
    }

    // Optional ping from UI
    if (msg?.type === "ping") {
      // You can reply if you want:
      // try { ws.send(JSON.stringify({ type: "pong", t: now() })); } catch {}
      return;
    }

    // Vote message: { type:"vote", mint:"..." }
    if (msg?.type === "vote" && typeof msg.mint === "string") {
      const mint = msg.mint;
      if (!mint) return;

      const meta = mintMetadata.get(mint) || {};
      const t = now();
      const existing = votesByMint.get(mint);

      const next = existing
        ? {
            ...existing,
            count: existing.count + 1,
            expiresAt: t + VOTE_TTL_MS, // refresh TTL on each vote
            lastVoteAt: t,
          }
        : {
            count: 1,
            expiresAt: t + VOTE_TTL_MS,
            lastVoteAt: t,
            name: meta.name || "",
            symbol: meta.symbol || "",
          };

      votesByMint.set(mint, next);
      broadcastRanked(true);
      return;
    }
  });

  ws.on("close", () => downstreamClients.delete(ws));
  ws.on("error", () => downstreamClients.delete(ws));
});

// ====== ROUTES ======
app.get("/", (_req, res) => res.send("FoxScan aggregator OK"));

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    upstreamConnected,
    cached: cachedRows.length,
    trendingMints: tradeEventsByMint.size,
    votedMints: votesByMint.size,
  })
);

// ====== START ======
server.listen(PORT, () => {
  console.log(`[SERVER] Listening on :${PORT}`);
  connectUpstream();
});

// Cleanup + keep panels fresh
setInterval(() => {
  pruneTrending();
  pruneVotes();
  broadcastTrending(false);
  broadcastRanked(false);
}, CLEANUP_TICK_MS);