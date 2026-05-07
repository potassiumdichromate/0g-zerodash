/**
 * zgController — 0G decentralized save/load endpoints.
 *
 * Identity: req.walletAddress is set by the JWT verifyUser middleware.
 * Never trust X-Wallet-Address header directly.
 *
 * POST /save/binary    — upload binary save → 201 immediately, pipeline in background
 * GET  /load/binary    — download latest binary save
 * GET  /save/metadata  — full save metadata + on-chain anchor info
 * GET  /verify         — 4-layer integrity check
 * GET  /leaderboard/decentralized — aggregate by wallet, sort by coinSnapshot
 */

const crypto = require("crypto");
const { encode } = require("@msgpack/msgpack");

const PlayerSaveRecord = require("../models/PlayerSaveRecord");
const Player           = require("../models/Player");
const ZeroGStorage     = require("../services/ZeroGStorage");
const ZeroGDA          = require("../services/ZeroGDA");
const ZeroGChain       = require("../services/ZeroGChain");
const ZeroGCompute     = require("../services/ZeroGCompute");
const { withRetry }    = require("../utils/retry");

const ZG_ENABLED = process.env.ZG_ENABLED !== "false";

// ─────────────────────────────────────────────────────────────────────────────
// Internal: runs AFTER the HTTP response has been sent
// ─────────────────────────────────────────────────────────────────────────────
async function runBackgroundPipeline(record, walletAddress, rootHash, saveInput) {
  // Step 1 — Anchor root hash on-chain (3 attempts: 5 s, 10 s, 20 s backoff)
  try {
    const anchorTxHash = await withRetry(
      () => ZeroGChain.anchorSaveHash(walletAddress, rootHash, record.saveIndex),
      { maxAttempts: 3, baseDelayMs: 5000, label: `anchor save ${record.saveIndex}` }
    );
    await PlayerSaveRecord.findByIdAndUpdate(record._id, { anchorTxHash });
    console.log(`[0G] Anchored save ${record.saveIndex} → ${anchorTxHash}`);
  } catch (err) {
    console.error("[0G] Anchor failed after retries:", err.message);
  }

  // Step 2 — Publish commitment to 0G DA (DA client has its own 120 s internal timeout)
  try {
    const proof = await withRetry(
      () => ZeroGDA.publishCommitment({
        walletAddress,
        rootHash,
        saveIndex:    record.saveIndex,
        coinSnapshot: record.coinSnapshot,
        timestamp:    Date.now()
      }),
      { maxAttempts: 2, baseDelayMs: 10000, label: `DA publish save ${record.saveIndex}` }
    );

    await PlayerSaveRecord.findByIdAndUpdate(record._id, {
      daStatus: "finalized",
      daCommitment: {
        requestId:            proof.request_id   || proof.requestId    || "",
        batchId:              String(proof.batch_id || proof.batchId   || ""),
        blobIndex:            proof.blob_index   || proof.blobIndex    || 0,
        batchHeaderHash:      proof.batch_metadata?.batch_header_hash  || "",
        referenceBlockNumber: proof.batch_metadata?.batch_header?.reference_block_number || 0,
        finalizedAt:          new Date()
      }
    });

    console.log(`[0G] DA finalized save ${record.saveIndex}`);
  } catch (err) {
    console.error("[0G] DA failed:", err.message);
    await PlayerSaveRecord.findByIdAndUpdate(record._id, { daStatus: "failed" });
  }

  // Step 3 — TEE compute anti-cheat (only when thresholds exceeded)
  const meta = {
    coinDelta:      saveInput.coinDelta      || 0,
    saveIndexDelta: saveInput.saveIndexDelta || 1
  };

  if (ZeroGCompute.shouldTriggerCompute(meta)) {
    try {
      await PlayerSaveRecord.findByIdAndUpdate(record._id, { computeStatus: "pending" });

      const verdict = await ZeroGCompute.validateSave(saveInput, rootHash);

      if (verdict.skipped) {
        await PlayerSaveRecord.findByIdAndUpdate(record._id, { computeStatus: "skipped" });
      } else {
        await PlayerSaveRecord.findByIdAndUpdate(record._id, {
          computeStatus:     verdict.valid ? "validated" : "rejected",
          computeValidation: verdict
        });
        console.log(`[0G] Compute verdict for save ${record.saveIndex}: ${verdict.verdict}`);
      }
    } catch (err) {
      console.error("[0G] Compute failed:", err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /save/binary
// ─────────────────────────────────────────────────────────────────────────────
exports.saveBinary = async (req, res) => {
  const walletAddress = req.walletAddress;
  const buffer = req.body;

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return res.status(400).json({ error: "Empty or invalid binary payload" });
  }

  try {
    // Anti-rollback: latest saveIndex from DB
    const latest       = await PlayerSaveRecord.findOne({ walletAddress })
      .sort({ saveIndex: -1 }).lean();
    const prevSaveIndex = latest?.saveIndex ?? -1;
    const newSaveIndex  = prevSaveIndex + 1;

    // Optional client-side index verification
    const clientIdx = req.headers["x-save-index"];
    if (clientIdx !== undefined) {
      const parsed = parseInt(clientIdx, 10);
      if (parsed <= prevSaveIndex) {
        return res.status(409).json({
          error: "Anti-rollback: saveIndex must be strictly greater than current",
          currentSaveIndex: prevSaveIndex,
          rejectedSaveIndex: parsed
        });
      }
    }

    // Upload to 0G Storage
    let storageResult;
    if (ZG_ENABLED) {
      storageResult = await ZeroGStorage.uploadBuffer(buffer);
    } else {
      const checksum = crypto.createHash("sha256").update(buffer).digest("hex");
      storageResult = {
        rootHash: `dev-${checksum.slice(0, 16)}`,
        txHash:   `dev-tx-${Date.now()}`,
        size:     buffer.length,
        checksum
      };
    }

    const player      = await Player.findOne({ walletAddress }).lean();
    const coinSnapshot = player?.coins ?? 0;
    const coinDelta    = coinSnapshot - (latest?.coinSnapshot ?? 0);

    const record = await PlayerSaveRecord.create({
      walletAddress,
      rootHash:      storageResult.rootHash,
      txHash:        storageResult.txHash,
      fileSize:      storageResult.size,
      checksum:      storageResult.checksum,
      saveIndex:     newSaveIndex,
      coinSnapshot,
      daStatus:      "pending",
      computeStatus: "skipped",
      source:        "game_save"
    });

    // 201 immediately — pipeline never blocks the response
    res.status(201).json({
      success:   true,
      rootHash:  storageResult.rootHash,
      saveIndex: newSaveIndex,
      txHash:    storageResult.txHash,
      checksum:  storageResult.checksum,
      fileSize:  storageResult.size
    });

    setImmediate(() => {
      if (!ZG_ENABLED) return;
      runBackgroundPipeline(record, walletAddress, storageResult.rootHash, {
        coinDelta,
        saveIndex:      newSaveIndex,
        prevSaveIndex,
        saveIndexDelta: newSaveIndex - prevSaveIndex,
        timeElapsed:    latest?.createdAt
          ? Date.now() - new Date(latest.createdAt).getTime()
          : 0
      }).catch(err => console.error("[0G] Background pipeline error:", err.message));
    });

  } catch (err) {
    console.error("[0G] saveBinary error:", err);
    return res.status(500).json({ error: "Failed to save binary data", detail: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /load/binary
// ─────────────────────────────────────────────────────────────────────────────
exports.loadBinary = async (req, res) => {
  const walletAddress = req.walletAddress;

  try {
    const record = await PlayerSaveRecord.findOne({ walletAddress })
      .sort({ saveIndex: -1 }).lean();

    if (!record) {
      return res.status(404).json({ error: "No save found for this wallet" });
    }

    let buffer;
    if (ZG_ENABLED) {
      buffer = await ZeroGStorage.downloadToBuffer(record.rootHash);
    } else {
      buffer = Buffer.from("dev-mode-stub");
    }

    res.set({
      "Content-Type":       "application/octet-stream",
      "X-Root-Hash":        record.rootHash,
      "X-Save-Index":       String(record.saveIndex),
      "X-Da-Status":        record.daStatus,
      "X-Checksum-Sha256":  record.checksum || ""
    });

    return res.send(buffer);
  } catch (err) {
    console.error("[0G] loadBinary error:", err);
    return res.status(500).json({ error: "Failed to load binary data" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /save/metadata?wallet=0x...
// ─────────────────────────────────────────────────────────────────────────────
exports.getSaveMetadata = async (req, res) => {
  const wallet = req.query.wallet;

  if (!wallet) {
    return res.status(400).json({ error: "wallet query param required" });
  }

  try {
    const records = await PlayerSaveRecord.find({ walletAddress: wallet.toLowerCase() })
      .sort({ saveIndex: -1 })
      .limit(10)
      .lean();

    let onChain = null;
    if (ZG_ENABLED && process.env.ZG_ANCHOR_CONTRACT_ADDRESS) {
      try {
        onChain = await ZeroGChain.getOnChainSave(wallet);
      } catch (err) {
        console.error("[0G] getOnChainSave failed:", err.message);
      }
    }

    return res.json({ wallet, saves: records, onChain });
  } catch (err) {
    console.error("[0G] getSaveMetadata error:", err);
    return res.status(500).json({ error: "Failed to fetch metadata" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /verify?wallet=0x...   — 4-layer integrity check
// ─────────────────────────────────────────────────────────────────────────────
exports.verifySave = async (req, res) => {
  const wallet = req.query.wallet;

  if (!wallet) {
    return res.status(400).json({ error: "wallet query param required" });
  }

  const layers = {
    dbRecord:         false,
    daFinalized:      false,
    checksumMatch:    false,
    computeValidated: false
  };

  try {
    const record = await PlayerSaveRecord.findOne({ walletAddress: wallet.toLowerCase() })
      .sort({ saveIndex: -1 }).lean();

    // Layer 1
    layers.dbRecord = !!record;
    if (!record) return res.json({ wallet, layers, allPassed: false });

    // Layer 2
    layers.daFinalized = record.daStatus === "finalized";

    // Layer 3 — re-download and checksum
    if (ZG_ENABLED) {
      try {
        const buf      = await ZeroGStorage.downloadToBuffer(record.rootHash);
        const checksum = crypto.createHash("sha256").update(buf).digest("hex");
        layers.checksumMatch = checksum === record.checksum;
      } catch {
        layers.checksumMatch = false;
      }
    } else {
      layers.checksumMatch = true;
    }

    // Layer 4
    layers.computeValidated = record.computeStatus === "validated";

    const allPassed = Object.values(layers).every(Boolean);

    return res.json({
      wallet,
      layers,
      allPassed,
      saveIndex: record.saveIndex
    });
  } catch (err) {
    console.error("[0G] verifySave error:", err);
    return res.status(500).json({ error: "Verification failed" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /leaderboard/decentralized
// ─────────────────────────────────────────────────────────────────────────────
exports.getDecentralizedLeaderboard = async (req, res) => {
  try {
    const leaderboard = await PlayerSaveRecord.aggregate([
      { $sort: { saveIndex: -1 } },
      {
        $group: {
          _id:         "$walletAddress",
          coinSnapshot: { $first: "$coinSnapshot" },
          saveIndex:    { $first: "$saveIndex" },
          rootHash:     { $first: "$rootHash" },
          daStatus:     { $first: "$daStatus" }
        }
      },
      { $sort: { coinSnapshot: -1 } },
      { $limit: 100 }
    ]);

    // Deterministic name: Warrior_<first-6-hex-chars-after-0x>
    // Never Math.random() — leaderboard names must be stable across requests
    const result = leaderboard.map((entry, index) => {
      const wallet = entry._id;
      return {
        rank:          index + 1,
        walletAddress: wallet,
        displayName:   `Warrior_${wallet.slice(2, 8)}`,
        coinSnapshot:  entry.coinSnapshot,
        saveIndex:     entry.saveIndex,
        daStatus:      entry.daStatus
      };
    });

    return res.json({ leaderboard: result, total: result.length });
  } catch (err) {
    console.error("[0G] getDecentralizedLeaderboard error:", err);
    return res.status(500).json({ error: "Failed to fetch leaderboard" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Exported utility — called via setImmediate from existing JSON save endpoints
// ─────────────────────────────────────────────────────────────────────────────
exports.persistProfileTo0G = async (walletAddress, profileData, source = "game_save") => {
  if (!ZG_ENABLED) return;

  try {
    const buffer = Buffer.from(encode(profileData));

    const latest       = await PlayerSaveRecord.findOne({ walletAddress })
      .sort({ saveIndex: -1 }).lean();
    const prevSaveIndex = latest?.saveIndex ?? -1;
    const newSaveIndex  = prevSaveIndex + 1;

    let storageResult;
    try {
      storageResult = await ZeroGStorage.uploadBuffer(buffer);
    } catch (err) {
      console.error("[0G] persistProfileTo0G upload failed:", err.message);
      return;
    }

    const coinSnapshot = profileData.coins ?? 0;
    const coinDelta    = coinSnapshot - (latest?.coinSnapshot ?? 0);

    const record = await PlayerSaveRecord.create({
      walletAddress,
      rootHash:      storageResult.rootHash,
      txHash:        storageResult.txHash,
      fileSize:      storageResult.size,
      checksum:      storageResult.checksum,
      saveIndex:     newSaveIndex,
      coinSnapshot,
      daStatus:      "pending",
      computeStatus: "skipped",
      source
    });

    setImmediate(() => {
      runBackgroundPipeline(record, walletAddress, storageResult.rootHash, {
        coinDelta,
        saveIndex:      newSaveIndex,
        prevSaveIndex,
        saveIndexDelta: 1,
        timeElapsed:    0
      }).catch(err => console.error("[0G] Background pipeline error:", err.message));
    });
  } catch (err) {
    console.error("[0G] persistProfileTo0G error:", err.message);
  }
};
