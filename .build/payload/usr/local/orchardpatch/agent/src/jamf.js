/**
 * OrchardPatch Agent — Jamf Pro Integration (optional)
 * When configured, augments local inventory with Jamf data.
 * Falls back gracefully if Jamf is unavailable.
 */

let cachedToken = null;
let tokenExpiry = 0;

/**
 * Get a bearer token from Jamf Pro using OAuth2 client credentials
 */
async function getToken(config) {
  if (cachedToken && Date.now() < tokenExpiry - 60000) {
    return cachedToken;
  }

  const base = config.serverUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
  });

  if (!res.ok) throw new Error(`Jamf auth failed: ${res.status}`);

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in * 1000);
  return cachedToken;
}

/**
 * Fetch all computers from Jamf inventory (paginated)
 */
async function getJamfComputers(config) {
  const base = config.serverUrl.replace(/\/$/, "");
  const token = await getToken(config);
  const allComputers = [];
  let page = 0;
  const pageSize = 100;

  while (true) {
    const res = await fetch(
      `${base}/api/v1/computers-inventory?page=${page}&page-size=${pageSize}&section=GENERAL&section=APPLICATIONS`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      }
    );

    if (!res.ok) throw new Error(`Jamf inventory fetch failed: ${res.status}`);

    const data = await res.json();
    allComputers.push(...(data.results ?? []));

    if (allComputers.length >= data.totalCount) break;
    page++;
  }

  return allComputers;
}

/**
 * Get Jamf inventory — returns null if Jamf not configured or unreachable
 */
async function getJamfInventory(config) {
  if (!config?.serverUrl || !config?.clientId || !config?.clientSecret) {
    return null;
  }

  try {
    const computers = await getJamfComputers(config);
    console.log(`[OrchardPatch Agent] Jamf: found ${computers.length} computers`);
    return computers;
  } catch (err) {
    console.warn(`[OrchardPatch Agent] Jamf unavailable: ${err.message}`);
    return null;
  }
}

module.exports = { getJamfInventory };
