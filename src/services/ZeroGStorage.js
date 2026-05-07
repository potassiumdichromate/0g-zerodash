/**
 * ZeroGStorage — upload/download binary player saves to 0G Storage.
 *
 * Uses dynamic import() because @0gfoundation/0g-storage-ts-sdk is ESM-only.
 * Write buffer to a tmp file first, then ZgFile.fromFilePath() + indexer.upload().
 * Downloads use withProof: true for Merkle verification.
 * Signing uses ethers-v6 alias (never ethers v5).
 */

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const ZG_RPC_URL   = process.env.ZG_RPC_URL    || "https://evmrpc.0g.ai";
const ZG_INDEXER   = process.env.ZG_INDEXER_RPC || "https://indexer-storage-turbo.0g.ai";
const ZG_CHAIN_ID  = parseInt(process.env.ZG_CHAIN_ID || "16600");

let _indexer = null;

async function getIndexer() {
  if (_indexer) return _indexer;

  const { ethers } = await import("ethers-v6");
  const sdk = await import("@0gfoundation/0g-storage-ts-sdk");

  const provider = new ethers.JsonRpcProvider(ZG_RPC_URL, {
    chainId: ZG_CHAIN_ID,
    name: "0g-newton"
  });
  const signer = new ethers.Wallet(process.env.ZG_PRIVATE_KEY, provider);

  // SDK exposes either `getIndexer` factory or `Indexer` class depending on version
  if (typeof sdk.getIndexer === "function") {
    _indexer = await sdk.getIndexer(ZG_INDEXER, signer);
  } else {
    _indexer = new sdk.Indexer(ZG_INDEXER, signer);
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
  const tmp = tmpPath();

  try {
    fs.writeFileSync(tmp, buffer);

    const sdk = await import("@0gfoundation/0g-storage-ts-sdk");
    const indexer = await getIndexer();

    const file = await sdk.ZgFile.fromFilePath(tmp);
    const [tree, treeErr] = await file.merkleTree();
    if (treeErr) throw new Error(`Merkle tree error: ${treeErr}`);

    const rootHash = tree.rootHash();
    const checksum = crypto.createHash("sha256").update(buffer).digest("hex");

    const [txHash, uploadErr] = await indexer.upload(file);
    if (uploadErr) throw new Error(`Upload error: ${uploadErr}`);

    return { rootHash, txHash, size: buffer.length, checksum };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

/**
 * Download a file from 0G Storage by rootHash.
 * Uses withProof: true for Merkle verification.
 * Returns the raw Buffer.
 */
async function downloadToBuffer(rootHash) {
  const tmp = tmpPath();

  try {
    const indexer = await getIndexer();

    // third arg = withProof (Merkle verification)
    const [, dlErr] = await indexer.download(rootHash, tmp, true);
    if (dlErr) throw new Error(`Download error: ${dlErr}`);

    return fs.readFileSync(tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

module.exports = { uploadBuffer, downloadToBuffer };
