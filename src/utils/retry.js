/**
 * withRetry — exponential backoff retry wrapper.
 *
 * Delays: attempt 1 = baseDelayMs, attempt 2 = 2×, attempt 3 = 4×
 * All attempts exhausted → re-throws the last error.
 */
async function withRetry(fn, { maxAttempts = 3, baseDelayMs = 5000, label = "op" } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        console.warn(
          `[retry] ${label}: attempt ${attempt}/${maxAttempts} failed — ${err.message}. ` +
          `Retrying in ${delay / 1000}s`
        );
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  console.error(`[retry] ${label}: all ${maxAttempts} attempts failed — ${lastErr.message}`);
  throw lastErr;
}

module.exports = { withRetry };
