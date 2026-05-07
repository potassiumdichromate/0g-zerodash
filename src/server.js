require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const connectDB = require("./config/db");

connectDB();

const app = express();

const allowedOrigins = [
  "https://zerodashgame.xyz",
  "http://localhost:3000",
  "http://localhost:5173",
  "https://pub-c51325b05b6848599be1cf2978bc4c0e.r2.dev/v6",
  "https://pub-c51325b05b6848599be1cf2978bc4c0e.r2.dev"
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Wallet-Address",
    "X-Save-Index",
    "X-Root-Hash"
  ],
  exposedHeaders: [
    "X-Root-Hash",
    "X-Save-Index",
    "X-Da-Status",
    "X-Checksum-Sha256"
  ]
}));

// JSON limit 1 mb — binary saves use the dedicated binary endpoint (5 mb)
app.use(express.json({ limit: "1mb" }));

// ── Routes ────────────────────────────────────────────────────────────────────
// 0G routes are mounted FIRST so they take priority over legacy routes
// when both share the /player prefix.
app.use("/player", require("./routes/profileRoutes"));

// Legacy player routes — unchanged, dual-write handled inside the controller
app.use("/player", require("./routes/player.routes"));

// ── Utility endpoints ─────────────────────────────────────────────────────────
app.get("/", (_, res) => res.send("ZeroDash 0G Backend Running"));

app.get("/blockchain-info", (_, res) => {
  const sessionService     = require("./blockchain/sessionService");
  const leaderboardService = require("./blockchain/leaderboardService");

  res.json({
    status: "online",
    services: {
      sessions:    { ready: sessionService.isReady(),     contractInfo: sessionService.getContractInfo() },
      leaderboard: { ready: leaderboardService.isReady(), contractInfo: leaderboardService.getContractInfo() }
    },
    network: {
      name:    "0G Newton Testnet",
      chainId: parseInt(process.env.ZG_CHAIN_ID || "16600"),
      rpcUrl:  process.env.ZG_RPC_URL || "https://evmrpc.0g.ai",
      explorer: "https://chainscan.0g.ai"
    }
  });
});

app.get("/stats", async (_, res) => {
  try {
    const Player           = require("./models/Player");
    const PlayerSaveRecord = require("./models/PlayerSaveRecord");
    const sessionService     = require("./blockchain/sessionService");
    const leaderboardService = require("./blockchain/leaderboardService");

    const [totalSessions, totalSnapshots, totalPlayers, totalSaves] = await Promise.all([
      sessionService.getTotalSessions().catch(() => 0),
      leaderboardService.getTotalSnapshots().catch(() => 0),
      Player.countDocuments(),
      PlayerSaveRecord.countDocuments()
    ]);

    res.json({
      totalPlayers,
      totalSessions,
      totalLeaderboardSnapshots: totalSnapshots,
      totalDecentralizedSaves:   totalSaves,
      contracts: {
        sessions:         process.env.SESSION_CONTRACT_ADDRESS,
        leaderboard:      process.env.LEADERBOARD_CONTRACT_ADDRESS,
        playerSaveAnchor: process.env.ZG_ANCHOR_CONTRACT_ADDRESS
      }
    });
  } catch (err) {
    console.error("Stats error:", err);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

app.get("/contracts", (_, res) => {
  res.json({
    network: "0G Newton Testnet",
    chainId: 16600,
    explorer: "https://chainscan.0g.ai",
    contracts: {
      sessionTracker: {
        address: process.env.SESSION_CONTRACT_ADDRESS,
        purpose: "Tracks player gaming sessions (0G Mainnet chainId 16661)"
      },
      leaderboardTracker: {
        address: process.env.LEADERBOARD_CONTRACT_ADDRESS,
        purpose: "Tracks leaderboard snapshots (0G Mainnet chainId 16661)"
      },
      playerSaveAnchor: {
        address: process.env.ZG_ANCHOR_CONTRACT_ADDRESS,
        purpose: "Anchors player save root hashes (0G EVM chainId 16600)"
      }
    }
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log("╔═══════════════════════════════════════════════════════╗");
  console.log("║        🎮  ZeroDash 0G Backend Server  🎮            ║");
  console.log("╚═══════════════════════════════════════════════════════╝");
  console.log("");
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || "development"}`);
  console.log("");
  console.log("🔗 0G Infrastructure:");
  console.log(`   ⛓️  RPC URL:      ${process.env.ZG_RPC_URL          || "❌ ZG_RPC_URL not set"}`);
  console.log(`   🔢 Chain ID:     ${process.env.ZG_CHAIN_ID         || "❌ ZG_CHAIN_ID not set"}`);
  console.log(`   📦 Storage:      ${process.env.ZG_INDEXER_RPC      || "❌ ZG_INDEXER_RPC not set"}`);
  console.log(`   📡 DA Disperser: ${process.env.ZG_DA_DISPERSER     || "❌ ZG_DA_DISPERSER not set"}`);
  console.log(`   📜 Anchor:       ${process.env.ZG_ANCHOR_CONTRACT_ADDRESS || "❌ ZG_ANCHOR_CONTRACT_ADDRESS not set"}`);
  console.log(`   🔑 Operator Key: ${process.env.ZG_PRIVATE_KEY ? "✅ Set" : "❌ ZG_PRIVATE_KEY not set"}`);
  console.log(`   🧠 Compute:      ${process.env.ZG_COMPUTE_API_KEY  ? "✅ Set" : "⚠️  Skipped (ZG_COMPUTE_API_KEY not set)"}`);
  console.log(`   🚦 Enabled:      ${process.env.ZG_ENABLED !== "false" ? "✅ true" : "⚠️  false (dev mode)"}`);
  console.log("");
  console.log("📡 0G Endpoints:");
  console.log(`   POST   /player/save/binary`);
  console.log(`   GET    /player/load/binary`);
  console.log(`   GET    /player/save/metadata?wallet=0x...`);
  console.log(`   GET    /player/verify?wallet=0x...`);
  console.log(`   GET    /player/leaderboard/decentralized`);
  console.log("");
  console.log("✅ Server ready!");
  console.log("═══════════════════════════════════════════════════════");
});
