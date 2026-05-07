/**
 * ZeroGStorage — upload/download binary player saves to 0G Storage.
 *
 * SDK v1.2.9 has a proper CommonJS build so require() works directly.
 *
 * v1.2.9 API differences from earlier versions:
 *   - new Indexer(indRpc)           — signer NOT in constructor
 *   - indexer.upload(file, evmRpc, signer)  — signer passed per-call
 *   - indexer.download(rootHash, path, withProof) — returns err directly
 *   - file.close() must be called after merkleTree() / upload()
 *
 * Runs on 0G Mainnet (chainId 16661).
 * Resilience: singleton Indexer reset on error, retry with exponential backoff.
 */

const os     = require("os");
const path   = require("path");
const fs     = require("fs");
const crypto = require("crypto");
const { ethers }              = require("ethers-v6");
const { Indexer, ZgFile }     = require("@0gfoundation/0g-storage-ts-sdk");
const { withRetry }           = require("../utils/retry");

// 0G Mainnet
const ZG_RPC_URL  = process.env.OG_MAINNET_RPC       || "https://evmrpc.0g.ai";
const ZG_CHAIN_ID = parseInt(process.env.OG_MAINNET_CHAIN_ID || "16661");

// Ordered list of indexer endpoints — tried in sequence on failure
const ZG_INDEXER_URLS = [
  process.env.ZG_INDEXER_RPC,
  "https://indexer-storage-turbo.0g.ai",
  "https://indexer-storage-turbo-standard.0g.ai",
  "https://storage-indexer-v2.0g.ai",
].filter(Boolean);

let _indexer     = null;
let _indexerUrl  = null;
let _signer      = null;

function getSigner() {
  const key = process.env.ZG_PRIVATE_KEY;
  if (!key || key.startsWith("0xyour") || key === "your_private_key_here") {
    throw new Error("ZG_PRIVATE_KEY is not configured. Set it in Render environment variables.");
  }
  if (!_signer) {
    const provider = new ethers.JsonRpcProvider(ZG_RPC_URL, {
      chainId: ZG_CHAIN_ID,
      name:    "0g-mainnet"
    });
    _signer = new ethers.Wallet(key, provider);
  }
  return _signer;
}

function getIndexer() {
  if (!_indexer) {
    const url = _indexerUrl || ZG_INDEXER_URLS[0];
    _indexer    = new Indexer(url);
    _indexerUrl = url;
    console.log(`[0G] Using indexer: ${url}`);
  }
  return _indexer;
}

// Try next indexer URL in the list on repeated failure
function rotateIndexer() {
  const current = _indexerUrl || ZG_INDEXER_URLS[0];
  const idx     = ZG_INDEXER_URLS.indexOf(current);
  const next    = ZG_INDEXER_URLS[idx + 1];
  if (next) {
    console.warn(`[0G] Indexer ${current} failed — trying ${next}`);
    _indexerUrl = next;
  }
  _indexer = null;
  _signer  = null;
}

function tmpPath() {
  return path.join(
    os.tmpdir(),
    `zg-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.bin`
  );
}

/**
 * Upload a buffer to 0G Storage.
 * Returns { rootHash, txHash, size, checksum }.
 */
async function uploadBuffer(buffer) {
  return withRetry(async () => {
    const tmp = tmpPath();
    let zgFile = null;
    try {
      fs.writeFileSync(tmp, buffer);

      zgFile = await ZgFile.fromFilePath(tmp);
      const [tree, treeErr] = await zgFile.merkleTree();
      if (treeErr) throw new Error(`Merkle tree error: ${treeErr}`);

      const rootHash = tree.rootHash();
      const checksum = crypto.createHash("sha256").update(buffer).digest("hex");

      const indexer = getIndexer();
      const signer  = getSigner();

      const [txHash, uploadErr] = await indexer.upload(zgFile, ZG_RPC_URL, signer);
      if (uploadErr) throw new Error(`Upload error: ${uploadErr}`);

      return { rootHash, txHash, size: buffer.length, checksum };
    } catch (err) {
      rotateIndexer();
      throw err;
    } finally {
      if (zgFile) { try { await zgFile.close(); } catch {} }
      try { fs.unlinkSync(tmp); } catch {}
    }
  }, { maxAttempts: 3, baseDelayMs: 4000, label: "ZeroGStorage.upload" });
}

/**
 * Download a file from 0G Storage by rootHash.
 * withProof: true verifies Merkle inclusion during download.
 */
async function downloadToBuffer(rootHash) {
  return withRetry(async () => {
    const tmp = tmpPath();
    try {
      const indexer = getIndexer();
      const err = await indexer.download(rootHash, tmp, true);
      if (err) throw new Error(`Download error: ${err}`);
      return fs.readFileSync(tmp);
    } catch (err) {
      rotateIndexer();
      throw err;
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }, { maxAttempts: 3, baseDelayMs: 4000, label: "ZeroGStorage.download" });
}

module.exports = { uploadBuffer, downloadToBuffer };
