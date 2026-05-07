/**
 * authController — wallet signature-based authentication.
 *
 * Flow:
 *   1. Client calls GET /auth/nonce?wallet=0x... — gets a one-time nonce + the exact
 *      message string to sign.
 *   2. Client signs the message with their wallet (ethers.signMessage, MetaMask, etc.)
 *   3. Client calls POST /auth/login { wallet, signature, nonce } — server recovers
 *      the signing address from the signature and verifies it matches the claimed wallet.
 *   4. Server issues a short-lived JWT. Client uses it as a Bearer token from here on.
 *
 * Nonces are stored in MongoDB with a 5-minute TTL index and deleted immediately on use.
 * A raw wallet address passed as a Bearer token is explicitly rejected with a helpful error.
 */

const crypto  = require("crypto");
const { ethers } = require("ethers");
const jwt     = require("jsonwebtoken");
const AuthNonce = require("../models/AuthNonce");

function jwtSecret() {
  const s = process.env.BROWSER_JWT_SECRET;
  if (!s || s === "dev-secret-change-me") {
    console.warn("[auth] WARNING: BROWSER_JWT_SECRET is not set or is the default. Set a real secret in production.");
  }
  return s || "dev-secret-change-me";
}

/**
 * The exact message the client must sign.
 * Changing this format invalidates all existing signatures — version it if needed.
 */
function buildLoginMessage(wallet, nonce, issuedAt) {
  return [
    "Sign in to ZeroDash",
    "",
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    "",
    "Signing this message grants access to ZeroDash only.",
    "It will not trigger a blockchain transaction or cost gas fees."
  ].join("\n");
}

// GET /auth/nonce?wallet=0x...
exports.getNonce = async (req, res) => {
  const wallet = req.query.wallet?.toLowerCase().trim();

  if (!wallet || !/^0x[0-9a-f]{40}$/i.test(wallet)) {
    return res.status(400).json({ error: "Invalid wallet address" });
  }

  // One nonce per wallet at a time — delete any existing before issuing a new one
  await AuthNonce.deleteMany({ wallet });

  const nonce    = crypto.randomBytes(16).toString("hex");
  // Use createdAt from the saved doc so login can reconstruct the exact same message
  const nonceDoc = await AuthNonce.create({ wallet, nonce });
  const issuedAt = nonceDoc.createdAt.toISOString();

  const message = buildLoginMessage(wallet, nonce, issuedAt);

  return res.json({
    wallet,
    nonce,
    issuedAt,
    message,      // client signs this exact string
    expiresIn: 300
  });
};

// POST /auth/login  { wallet, signature, nonce }
exports.login = async (req, res) => {
  const { wallet, signature, nonce } = req.body || {};

  if (!wallet || !signature || !nonce) {
    return res.status(400).json({ error: "wallet, signature, and nonce are all required" });
  }

  const normalizedWallet = wallet.toLowerCase().trim();

  if (!/^0x[0-9a-f]{40}$/i.test(normalizedWallet)) {
    return res.status(400).json({ error: "Invalid wallet address format" });
  }

  // Look up and immediately delete the nonce — single use
  const nonceDoc = await AuthNonce.findOneAndDelete({ wallet: normalizedWallet, nonce });

  if (!nonceDoc) {
    return res.status(401).json({
      error: "Invalid or expired nonce.",
      hint:  "Request a fresh nonce via GET /auth/nonce?wallet=<address>"
    });
  }

  // Recover the signer from the signature
  const issuedAt = nonceDoc.createdAt.toISOString();
  const message  = buildLoginMessage(normalizedWallet, nonce, issuedAt);

  let recovered;
  try {
    recovered = ethers.verifyMessage(message, signature).toLowerCase();
  } catch {
    return res.status(401).json({ error: "Malformed signature" });
  }

  if (recovered !== normalizedWallet) {
    return res.status(401).json({
      error: "Signature verification failed — signing address does not match wallet"
    });
  }

  // Issue JWT
  const token = jwt.sign(
    { walletAddress: normalizedWallet, sub: normalizedWallet },
    jwtSecret(),
    { expiresIn: "7d", algorithm: "HS256" }
  );

  return res.json({
    token,
    wallet:    normalizedWallet,
    expiresIn: 7 * 24 * 60 * 60,
    tokenType: "Bearer"
  });
};
