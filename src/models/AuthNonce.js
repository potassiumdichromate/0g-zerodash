const mongoose = require("mongoose");

// Single-use nonces for wallet signature auth.
// TTL index auto-deletes documents 5 minutes after creation.
const AuthNonceSchema = new mongoose.Schema({
  wallet: { type: String, required: true, index: true },
  nonce:  { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: 300 }
});

module.exports = mongoose.model("AuthNonce", AuthNonceSchema);
