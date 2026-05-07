/**
 * ZeroGStorage — upload/download binary player saves to 0G Storage.
 *
 * Uses dynamic import() because @0gfoundation/0g-storage-ts-sdk is ESM-only.
 * Uploads write to a tmp file first, then ZgFile.fromFilePath() + indexer.upload().
 * Downloads use withProof: true for Merkle verification.
 * Signing uses the ethers-v6 alias.
 *
 * Resilience design:
 *   - _indexer singleton is reset to null on any error so the next call re-initialises.
 *   - uploadBuffer and downloadToBuffer both retry up to 3 times with exponential backoff.
 *   - Tmp files are always cleaned up in a finally block.
 */

const os     = require("os");
const path   = require("path");
const fs     = require("fs");
const crypto = require("crypto");
const { withRetry } = require("../utils/retry");

// Storage runs on 0G Mainnet (chainId 16661)
const ZG_RPC_URL  = process.env.OG_MAINNET_RPC      || "https://evmrpc.0g.ai";
const ZG_INDEXER  = process.env.ZG_INDEXER_RPC       || "https://indexer-storage-turbo-v2.0g.ai";
const ZG_CHAIN_ID = parseInt(process.env.OG_MAINNET_CHAIN_ID || "16661");

let _indexer = null;

async function buildIndexer() {
  const { ethers } = await import("ethers-v6");
  const sdk = await import("@0gfoundation/0g-storage-ts-sdk");

  const provider = new ethers.JsonRpcProvider(ZG_RPC_URL, {
    chainId: ZG_CHAIN_ID,
    name:    "0g-mainnet"
  });
  const signer = new ethers.Wallet(process.env.ZG_PRIVATE_KEY, provider);

  if (typeof sdk.getIndexer === "function") {
    return sdk.getIndexer(ZG_INDEXER, signer);
  }
  return new sdk.Indexer(ZG_INDEXER, signer);
}

/**
 * Returns the cached indexer, creating it on first call.
 * On error, the caller resets _indexer to null so the next
 * invocation starts fresh rather than returning a broken instance.
 */
async function getIndexer() {
  if (!_indexer) {
    _indexer = await buildIndexer();
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
 * Retries up to 3 times; resets the indexer singleton on failure
 * so the next retry re-establishes the connection.
 */
async function uploadBuffer(buffer) {
  return withRetry(async () => {
    const tmp = tmpPath();
    try {
      fs.writeFileSync(tmp, buffer);

      const sdk     = await import("@0gfoundation/0g-storage-ts-sdk");
      const indexer = await getIndexer();

      const file = await sdk.ZgFile.fromFilePath(tmp);
      const [tree, treeErr] = await file.merkleTree();
      if (treeErr) throw new Error(`Merkle tree error: ${treeErr}`);

      const rootHash = tree.rootHash();
      const checksum = crypto.createHash("sha256").update(buffer).digest("hex");

      const [txHash, uploadErr] = await indexer.upload(file);
      if (uploadErr) throw new Error(`Upload error: ${uploadErr}`);

      return { rootHash, txHash, size: buffer.length, checksum };
    } catch (err) {
      _indexer = null; // force re-init on next attempt
      throw err;
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }, { maxAttempts: 3, baseDelayMs: 4000, label: "ZeroGStorage.upload" });
}

/**
 * Download a file from 0G Storage by rootHash.
 * withProof: true — nodes return a Merkle inclusion proof so we can
 * verify the file content matches the rootHash before trusting it.
 * Retries up to 3 times; resets the indexer singleton on failure.
 */
async function downloadToBuffer(rootHash) {
  return withRetry(async () => {
    const tmp = tmpPath();
    try {
      const indexer = await getIndexer();
      const [, dlErr] = await indexer.download(rootHash, tmp, true);
      if (dlErr) throw new Error(`Download error: ${dlErr}`);
      return fs.readFileSync(tmp);
    } catch (err) {
      _indexer = null; // force re-init on next attempt
      throw err;
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }, { maxAttempts: 3, baseDelayMs: 4000, label: "ZeroGStorage.download" });
}

module.exports = { uploadBuffer, downloadToBuffer };
