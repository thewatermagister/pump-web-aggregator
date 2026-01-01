// server.js
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(require("cors")());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ---- CONFIG ----
const PUMP_URI = "wss://pumpportal.fun/api/data";
const MAX_ROWS = 250;              // how many rows we keep in memory
const BROADCAST_EVERY_MS = 150;    // batch updates to clients (prevents UI spam)
// ----------------

let pumpWS = null;
let pumpConnected = false;

let rows = [];               // newest first
let pendingBatch = [];       // rows waiting to broadcast
let subscribers = new Set(); // downstream clients

function safeSend(ws, obj) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch {}
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of subscribers) {
    try {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    } catch {}
  }
}

// Health endpoint (handy for debugging / deployment)
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    pumpConnected,
    clients: subscribers.size,
    cachedRows: rows.length,
  });
});

// Serve initial cache
app.get("/snapshot", (req, res) => {
  res.json({ rows });
});

// Downstream WS for website clients
wss.on("connection", (client) => {
  subscribers.add(client);

  // Immediately send current status + snapshot
  safeSend(client, { type: "status", pumpConnected, clients: subscribers.size });
  safeSend(client, { type: "snapshot", rows });

  client.on("close", () => {
    subscribers.delete(client);
    broadcast({ type: "status", pumpConnected, clients: subscribers.size });
  });
});

// Batch broadcaster (prevents blasting clients on high-volume tokens)
setInterval(() => {
  if (pendingBatch.length > 0) {
    const batch = pendingBatch.splice(0, pendingBatch.length);
    broadcast({ type: "batch", rows: batch });
  }
}, BROADCAST_EVERY_MS);

// ---- PumpPortal upstream connection (ONE connection) ----
function connectPump() {
  pumpWS = new WebSocket(PUMP_URI);

  pumpWS.on("open", () => {
    pumpConnected = true;
    console.log("[PUMP] connected");

    // Subscribe to new token creations
    pumpWS.send(JSON.stringify({ method: "subscribeNewToken" }));

    broadcast({ type: "status", pumpConnected, clients: subscribers.size });
  });

  pumpWS.on("message", (buf) => {
    let data;
    try {
      data = JSON.parse(buf.toString());
    } catch {
      return;
    }

    // PumpPortal sometimes returns an error wrapper
    if (data?.errors) {
      console.log("[PUMP] error:", data.errors);
      return;
    }

    const txType = data?.txType || "N/A";

    // Keep it simple for test page:
    // - show creates
    // - show buys/sells *only if we subscribed to those mints* (optional later)
    if (txType === "create") {
      const row = {
        kind: "create",
        t: Date.now(),
        trader: data.traderPublicKey || "N/A",
        mint: data.mint || "N/A",
        sol: Number(data.solAmount || 0),
        name: data.name || "N/A",
        symbol: data.symbol || "N/A",
      };

      // cache
      rows.unshift(row);
      if (rows.length > MAX_ROWS) rows.pop();

      // queue broadcast
      pendingBatch.unshift(row);
    }

    if (txType === "buy" || txType === "sell") {
      const row = {
        kind: txType,
        t: Date.now(),
        trader: data.traderPublicKey || "N/A",
        mint: data.mint || "N/A",
        sol: Number(data.solAmount || 0),
        name: data.name || "N/A",
        symbol: data.symbol || "N/A",
      };

      rows.unshift(row);
      if (rows.length > MAX_ROWS) rows.pop();

      pendingBatch.unshift(row);
    }
  });

  pumpWS.on("close", () => {
    pumpConnected = false;
    console.log("[PUMP] disconnected. reconnecting in 2s...");
    broadcast({ type: "status", pumpConnected, clients: subscribers.size });
    setTimeout(connectPump, 2000);
  });

  pumpWS.on("error", (err) => {
    pumpConnected = false;
    console.log("[PUMP] ws error:", err.message);
    try { pumpWS.close(); } catch {}
  });
}

connectPump();

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
