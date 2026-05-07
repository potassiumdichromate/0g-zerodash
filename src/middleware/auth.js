/**
 * auth middleware — verifies wallet identity from a signed JWT.
 *
 * Accepts two token formats:
 *   1. Browser JWT in request body: { jwt: "<token>", source: "browser" }
 *      Used by the existing game client. Verified with BROWSER_JWT_SECRET.
 *
 *   2. JWT Bearer in Authorization header: "Authorization: Bearer <token>"
 *      Issued by POST /auth/login after the client proves wallet ownership
 *      via a signed message (see authController.js).
 *
 * Raw wallet addresses passed as Bearer tokens are explicitly rejected.
 * "Authorization: Bearer 0x1234abcd" has zero security — anyone can claim
 * any wallet without proving they hold the private key.
 *
 * Sets req.walletAddress (lowercase) for downstream use.
 */

const jwt = require("jsonwebtoken");

function jwtSecret() {
  return process.env.BROWSER_JWT_SECRET || "dev-secret-change-me";
}

function verifyToken(token) {
  return jwt.verify(token, jwtSecret(), { algorithms: ["HS256"] });
}

function extractWallet(payload) {
  const candidates = [
    payload?.walletAddress,
    payload?.address,
    payload?.wallet,
    payload?.sub
  ];
  const w = candidates.find(v => typeof v === "string" && v.trim().length > 0);
  return w ? w.trim() : null;
}

module.exports = (req, res, next) => {
  // ── Option 1: Browser JWT in body (existing game client flow) ─────────────
  const { jwt: bodyJwt, source } = req.body || {};
  if (bodyJwt && source === "browser") {
    try {
      const payload = verifyToken(bodyJwt);
      const wallet  = extractWallet(payload);
      if (!wallet) return res.status(401).json({ error: "Missing wallet in token payload" });
      req.walletAddress = wallet.toLowerCase();
      return next();
    } catch {
      return res.status(401).json({ error: "Invalid or expired browser JWT" });
    }
  }

  // ── Option 2: JWT Bearer in Authorization header ───────────────────────────
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error:  "Authentication required.",
      detail: "Send a signed JWT from POST /auth/login as: Authorization: Bearer <token>",
      hint:   "GET /auth/nonce?wallet=<address> → sign message → POST /auth/login"
    });
  }

  const token = authHeader.slice(7).trim();

  // Reject raw Ethereum addresses — 0x followed by exactly 40 hex chars.
  // This was the original security hole: anyone could send another wallet's
  // address and gain full access to their account without signing anything.
  if (/^0x[0-9a-fA-F]{40}$/.test(token)) {
    return res.status(401).json({
      error:  "Raw wallet address is not a valid auth token.",
      detail: "A wallet address proves nothing without a signature.",
      step1:  "GET /auth/nonce?wallet=<address>",
      step2:  "Sign the returned message with your wallet",
      step3:  "POST /auth/login  →  receive JWT",
      step4:  "Authorization: Bearer <JWT>"
    });
  }

  try {
    const payload = verifyToken(token);
    const wallet  = extractWallet(payload);
    if (!wallet) return res.status(401).json({ error: "Missing wallet in token payload" });
    req.walletAddress = wallet.toLowerCase();
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};
