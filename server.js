// server.js
import express from "express";
import cors from "cors";
import WebSocket, { WebSocketServer } from "ws";
import http from "http";

const PORT = process.env.PORT || 8080;

// >>> IMPORTANT: set this to whatever upstream pump websocket you’re using now.
// If you already had a working upstream in your stable version, put that exact URL here.
// Example placeholders:
// const UPSTREAM_WS = "wss://pumpportal.fun/api/data";
const UPSTREAM_WS = process.env.UPSTREAM_WS || "wss://pumpportal.fun/api/data";

const app = express();
app.use(cors());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// --- In-memory cache ---
const MAX_CACHE = parseInt(process.env.MAX_CACHE || "5000", 10);
const ROW_BOOTSTRAP = parseInt(process.env.ROW_BOOTSTRAP || "200", 10);

let cachedRows = [];                 // ring buffer of latest rows
const mintMeta = new Map();          // mint -> { name, symbol, updatedAt }

let pumpWS = null;
let pumpConnected = false;

function pushRow(row) {
  cachedRows.push(row);
  if (cachedRows.length > MAX_CACHE) cachedRows.shift();
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

function shortAddr(a) {
  if (!a || typeof a !== "string") return "-";
  return a.length > 10 ? `${a.slice(0, 5)}…${a.slice(-4)}` : a;
}

function nowTs() {
  return Date.now();
}

function fmtTime(ms) {
  try {
    const d = new Date(ms);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

// --- Upstream connect/reconnect ---
function connectUpstream() {
  if (pumpWS && (pumpWS.readyState === WebSocket.OPEN || pumpWS.readyState === WebSocket.CONNECTING)) {
    return;
  }

  pumpWS = new WebSocket(UPSTREAM_WS);

  pumpWS.on("open", () => {
    pumpConnected = true;
    console.log("[UPSTREAM] connected");

    // If your upstream requires subscription messages, keep them HERE.
    // Because your current deploy already shows pumpConnected:true,
    // you likely already have a correct subscribe block in your stable server.
    //
    // Example patterns (ONLY enable the one your upstream uses):
    //
    // pumpWS.send(JSON.stringify({ method: "subscribeNewToken" }));
    // pumpWS.send(JSON.stringify({ method: "subscribeTokenTrade" }));
    //
    // If your stable server had a specific subscribe payload, paste it here.
  });

  pumpWS.on("close", () => {
    pumpConnected = false;
    console.log("[UPSTREAM] disconnected - retrying in 2s");
    setTimeout(connectUpstream, 2000);
  });

  pumpWS.on("error", (err) => {
    pumpConnected = false;
    console.log("[UPSTREAM] error", err?.message || err);
    try { pumpWS.close(); } catch {}
  });

  pumpWS.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }

    // -----------------------------
    // Normalize upstream payloads
    // -----------------------------
    // We handle two categories:
    // 1) CREATE (new token) => typeLabel: "Dev"
    // 2) TRADE (buy/sell)   => typeLabel: "Buy" | "Sell"
    //
    // Since upstream formats differ, we look for common fields.
    //
    // If your upstream has exact field names, you can tighten this later.

    // Heuristics:
    const isCreate =
      msg?.type === "create" ||
      msg?.event === "create" ||
      msg?.kind === "create" ||
      msg?.txType === "create" ||
      (msg?.name && msg?.symbol && msg?.mint && !msg?.side && !msg?.isBuy && !msg?.isSell);

    const isTrade =
      msg?.type === "trade" ||
      msg?.event === "trade" ||
      msg?.kind === "trade" ||
      msg?.txType === "trade" ||
      msg?.side === "buy" ||
      msg?.side === "sell" ||
      typeof msg?.isBuy === "boolean" ||
      typeof msg?.isSell === "boolean";

    if (isCreate) {
      const mint = msg.mint || msg.tokenMint || msg.ca || msg.contract || msg.address;
      const name = msg.name || msg.tokenName || "-";
      const symbol = msg.symbol || msg.ticker || "-";
      const trader = msg.trader || msg.owner || msg.creator || msg.deployer || "-";
      const sol = Number(msg.sol ?? msg.amountSOL ?? msg.initialBuy ?? msg.devSol ?? 0) || 0;

      if (mint) {
        mintMeta.set(mint, { name, symbol, updatedAt: nowTs() });
      }

      const row = {
        kind: "create",                 // for logic
        typeLabel: "Dev",               // for UI display (what you want in Type column)
        side: null,                     // not used for create
        t: nowTs(),
        time: fmtTime(nowTs()),
        wallet: trader,
        walletShort: shortAddr(trader),
        mint,
        mintShort: shortAddr(mint),
        sol,
        name,
        symbol,
      };

      pushRow(row);
      broadcast({ type: "row", row });
      return;
    }

    if (isTrade) {
      const mint = msg.mint || msg.tokenMint || msg.ca || msg.contract || msg.address;
      const trader = msg.trader || msg.owner || msg.wallet || msg.buyer || msg.seller || "-";
      const sol = Number(msg.sol ?? msg.amountSOL ?? msg.amount ?? 0) || 0;

      // Determine side
      let side = msg.side;
      if (!side) {
        if (msg.isBuy === true) side = "buy";
        else if (msg.isSell === true) side = "sell";
      }
      if (side !== "buy" && side !== "sell") {
        // if unknown, mark as trade but default to buy (you can change this)
        side = "buy";
      }

      // Pull name/symbol from cache if we have it
      const meta = mint ? mintMeta.get(mint) : null;
      const name = msg.name || meta?.name || "-";
      const symbol = msg.symbol || meta?.symbol || "-";

      const row = {
        kind: "trade",                  // for logic
        typeLabel: side === "buy" ? "Buy" : "Sell", // UI display label
        side,                           // for filtering if needed
        t: nowTs(),
        time: fmtTime(nowTs()),
        wallet: trader,
        walletShort: shortAddr(trader),
        mint,
        mintShort: shortAddr(mint),
        sol,
        name,
        symbol,
      };

      pushRow(row);
      broadcast({ type: "row", row });
      return;
    }

    // Ignore unknown upstream messages
  });
}

// --- Health endpoint ---
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    pumpConnected,
    clients: wss.clients.size,
    cachedRows: cachedRows.length,
    cachedMints: mintMeta.size,
  });
});

// --- WS downstream for your Framer page ---
wss.on("connection", (ws) => {
  // Send last N rows immediately (bootstrap)
  const rows = cachedRows.slice(-ROW_BOOTSTRAP);
  ws.send(JSON.stringify({ type: "batch", rows }));

  ws.on("error", () => {});
});

server.listen(PORT, () => {
  console.log(`[SERVER] listening on :${PORT}`);
  connectUpstream();
});
