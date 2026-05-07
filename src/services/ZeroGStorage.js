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
const ZG_INDEXER  = process.env.ZG_INDEXER_RPC        || "https://indexer-storage-turbo.0g.ai";
const ZG_CHAIN_ID = parseInt(process.env.OG_MAINNET_CHAIN_ID || "16661");

let _indexer = null;
let _signer  = null;

function getSigner() {
  if (!_signer) {
    const provider = new ethers.JsonRpcProvider(ZG_RPC_URL, {
      chainId: ZG_CHAIN_ID,
      name:    "0g-mainnet"
    });
    _signer = new ethers.Wallet(process.env.ZG_PRIVATE_KEY, provider);
  }
  return _signer;
}

function getIndexer() {
  if (!_indexer) {
    _indexer = new Indexer(ZG_INDEXER);
  }
  return _indexer;
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
      _indexer = null; // force re-init on next attempt
      _signer  = null;
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
      _indexer = null;
      throw err;
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }, { maxAttempts: 3, baseDelayMs: 4000, label: "ZeroGStorage.download" });
}

module.exports = { uploadBuffer, downloadToBuffer };
