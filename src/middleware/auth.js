const jwt = require("jsonwebtoken");

const verifyBrowserJwt = (token) => {
  const secret = process.env.BROWSER_JWT_SECRET || "dev-secret-change-me";
  return jwt.verify(token, secret, { algorithms: ["HS256"] });
};

const extractWalletAddress = (payload) => {
  const candidates = [
    payload && payload.walletAddress,
    payload && payload.address,
    payload && payload.wallet,
    payload && payload.sub,
  ];
  const wallet = candidates.find(
    (value) => typeof value === "string" && value.trim().length > 0
  );
  return wallet ? wallet.trim() : null;
};

module.exports = (req, res, next) => {
  const { jwt: bodyJwt, source } = req.body || {};

  if (bodyJwt && source === "browser") {
    try {
      const payload = verifyBrowserJwt(bodyJwt);
      const wallet = extractWalletAddress(payload);
      if (!wallet) {
        return res.status(401).json({ error: "Missing wallet in token" });
      }
      req.walletAddress = wallet.toLowerCase();
      return next();
    } catch (err) {
      console.error("Browser JWT auth error:", err.message || err);
      return res.status(401).json({ error: "Invalid browser token" });
    }
  }

  const auth = req.headers.authorization;

  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing wallet bearer token" });
  }

  const wallet = auth.replace("Bearer ", "").trim();

  if (!wallet) {
    return res.status(401).json({ error: "Invalid wallet" });
  }

  req.walletAddress = wallet.toLowerCase();
  next();
};
