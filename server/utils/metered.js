// server/utils/metered.js
//
// WebRTC infrastructure helper — wraps Metered.ca REST API for room
// lifecycle (get-or-create). Extracted from server/index.js so the
// orchestrator stays readable and the helper is unit-testable.

const axios = require('axios');

// Prefer canonical METERED_DOMAIN, fall back to the legacy METERED_APP_NAME /
// METERED_APP_DOMAIN aliases for backward compatibility with older deploys.
const METERED_SECRET_KEY =
  process.env.METERED_SECRET_KEY;
// Resolve to the bare subdomain prefix (e.g. 'zapchat-server') so we can
// always build `${prefix}.metered.live` deterministically — avoids the
// double-suffix bug when METERED_DOMAIN is already a full domain like
// 'zapchat-server.metered.live'.
function resolveAppPrefix() {
  const raw =
    process.env.METERED_DOMAIN ||
    process.env.METERED_APP_NAME ||
    process.env.METERED_APP_DOMAIN ||
    'zapchat-server.metered.live';
  return raw.replace(/\.metered\.live$/i, '');
}
const METERED_APP_NAME = resolveAppPrefix();

/**
 * Creates a metered room or returns an existing one with clean iceServers
 * configuration. Idempotent — safe to call on every call setup.
 *
 * @param {string} roomName  URL-safe identifier (lowercase, dashes, <=60 chars)
 * @returns {Promise<object>} Metered room payload
 */
async function getOrCreateCallRoom(roomName) {
  if (!METERED_SECRET_KEY) {
    throw new Error("Missing METERED_SECRET_KEY environment variable");
  }
  if (!METERED_APP_NAME) {
    throw new Error("Missing METERED_DOMAIN / METERED_APP_NAME environment variable");
  }
  if (!roomName || typeof roomName !== 'string') {
    throw new Error("roomName must be a non-empty string");
  }

  const base = `https://${METERED_APP_NAME}.metered.live/api/v1`;

  try {
    // Try fetching the room first to verify if it exists.
    const url = `${base}/room/${encodeURIComponent(roomName)}?secretKey=${encodeURIComponent(METERED_SECRET_KEY)}`;
    try {
      const response = await axios.get(url);
      return response.data;
    } catch (error) {
      // 404 → room doesn't exist, create it.
      if (error.response && error.response.status === 404) {
        const createUrl = `${base}/room?secretKey=${encodeURIComponent(METERED_SECRET_KEY)}`;
        const createResponse = await axios.post(createUrl, {
          roomName,
          privacy: "private",
          e2ee: true,
        });
        return createResponse.data;
      }
      throw error;
    }
  } catch (err) {
    console.error("Error syncing with Metered.ca service:", err.response?.data || err.message);
    throw err;
  }
}

module.exports = { getOrCreateCallRoom, METERED_APP_NAME };