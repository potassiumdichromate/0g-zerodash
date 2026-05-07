/**
 * ZeroGDA — publish save commitments to 0G DA for BLS-signed finality.
 *
 * gRPC client using @grpc/grpc-js + @grpc/proto-loader.
 * Proto: protos/disperser.proto (DisperseBlob + GetBlobStatus).
 * Polls GetBlobStatus every 5 s until status=3 (FINALIZED). Timeout: 120 s.
 * Endpoint: disperser-testnet.0g.ai:51001
 */

const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");
const path = require("path");

const PROTO_PATH   = path.join(__dirname, "../../protos/disperser.proto");
const DA_ENDPOINT  = process.env.ZG_DA_DISPERSER || "disperser-testnet.0g.ai:51001";
const POLL_INTERVAL_MS = 5_000;
const TIMEOUT_MS       = 120_000;

let _client = null;

function getClient() {
  if (_client) return _client;

  const packageDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true
  });

  const proto = grpc.loadPackageDefinition(packageDef);
  _client = new proto.disperser.Disperser(
    DA_ENDPOINT,
    grpc.credentials.createInsecure()
  );
  return _client;
}

function disperseBlob(data) {
  return new Promise((resolve, reject) => {
    getClient().DisperseBlob({ data }, (err, res) => {
      if (err) return reject(err);
      resolve(res);
    });
  });
}

function getBlobStatus(requestId) {
  return new Promise((resolve, reject) => {
    getClient().GetBlobStatus({ request_id: requestId }, (err, res) => {
      if (err) return reject(err);
      resolve(res);
    });
  });
}

async function pollUntilFinalized(requestId) {
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    const status = await getBlobStatus(requestId);

    // 3 = FINALIZED
    if (status.status === 3 || status.status === "FINALIZED") {
      return status.info?.blob_verification_proof ?? status;
    }

    // 4 = FAILED
    if (status.status === 4 || status.status === "FAILED") {
      throw new Error("DA blob finalization failed");
    }
  }

  throw new Error("DA finalization timeout after 120 s");
}

/**
 * Publish a payload as a DA blob and wait for BLS-signed finality.
 * Returns BlobVerificationProof.
 */
async function publishCommitment(payload) {
  const data = Buffer.from(JSON.stringify(payload));
  const reply = await disperseBlob(data);

  if (!reply.request_id) {
    throw new Error("DA DisperseBlob returned no request_id");
  }

  return pollUntilFinalized(reply.request_id);
}

/**
 * Re-check finality for a stored commitment.
 */
async function verifyCommitment(commitment) {
  try {
    const requestId = Buffer.from(commitment.requestId || "", "hex");
    const status = await getBlobStatus(requestId);
    return status.status === 3 || status.status === "FINALIZED";
  } catch {
    return false;
  }
}

module.exports = { publishCommitment, verifyCommitment };
