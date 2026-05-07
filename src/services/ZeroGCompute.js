/**
 * ZeroGCompute — TEE anti-cheat via 0G Compute AI router.
 *
 * OpenAI-compatible API at https://router-api.0g.ai/v1/chat/completions
 * with verify_tee: true for TEE attestation.
 *
 * System prompt checks:
 *   - Coin delta vs time elapsed (max ~5000 coins / 30 min)
 *   - saveIndex strictly increasing
 *
 * Binding check: model must echo rootHash back.
 * Comparing parsed.rootHash === rootHash prevents replay attacks.
 *
 * Only triggers when coinDelta > 100 OR saveIndexDelta > 1.
 * Skip entirely when ZG_COMPUTE_API_KEY is not set.
 */

const COMPUTE_URL = "https://router-api.0g.ai/v1/chat/completions";

const SYSTEM_PROMPT = `You are an anti-cheat validator for a coin-collecting mobile game.

Rules:
- Maximum legitimate coin gain: ~5000 coins per 30 minutes (~2.8 coins/second).
- saveIndex must always be strictly greater than the previous saveIndex.
- Any jump larger than 1 in saveIndex is suspicious without a matching time gap.

Respond ONLY with a single JSON object — no markdown, no explanation:
{
  "valid": boolean,
  "confidence": number (0.0–1.0),
  "flags": string[],
  "verdict": "CLEAN" | "SUSPICIOUS" | "CHEATING",
  "rootHash": "<echo the rootHash field from the user message exactly>"
}`;

/**
 * Return true when compute anti-cheat should fire.
 * Skips automatically when ZG_COMPUTE_API_KEY is absent.
 */
function shouldTriggerCompute(meta) {
  if (!process.env.ZG_COMPUTE_API_KEY) return false;
  return meta.coinDelta > 100 || meta.saveIndexDelta > 1;
}

/**
 * Run TEE-verified anti-cheat validation.
 * Returns a verdict object, or { skipped: true } when the API key is absent.
 *
 * Throws on rootHash binding mismatch to prevent replay attacks.
 */
async function validateSave(saveInput, rootHash) {
  if (!process.env.ZG_COMPUTE_API_KEY) {
    return { skipped: true, reason: "ZG_COMPUTE_API_KEY not set" };
  }

  const userMessage = JSON.stringify({
    coinDelta:    saveInput.coinDelta,
    timeElapsed:  saveInput.timeElapsed,
    saveIndex:    saveInput.saveIndex,
    prevSaveIndex: saveInput.prevSaveIndex,
    rootHash
  });

  const response = await fetch(COMPUTE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.ZG_COMPUTE_API_KEY}`
    },
    body: JSON.stringify({
      model: "deepseek/deepseek-chat-v3-0324",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: userMessage }
      ],
      verify_tee: true,
      temperature: 0
    })
  });

  if (!response.ok) {
    throw new Error(`Compute API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Failed to parse compute response as JSON");
  }

  // Binding check — model must echo rootHash verbatim to prove it processed THIS save
  if (parsed.rootHash !== rootHash) {
    throw new Error(
      `Compute rootHash binding check failed (got ${parsed.rootHash}, expected ${rootHash}) — possible replay attack`
    );
  }

  return {
    valid:           parsed.valid,
    confidence:      parsed.confidence,
    flags:           parsed.flags || [],
    verdict:         parsed.verdict,
    rootHash:        parsed.rootHash,
    teeVerified:     data.tee_verified     || false,
    providerAddress: data.provider_address || null,
    chatId:          data.id               || null,
    requestId:       data.request_id       || null,
    billingCost:     data.billing_cost     || null,
    validatedAt:     new Date()
  };
}

module.exports = { validateSave, shouldTriggerCompute };
