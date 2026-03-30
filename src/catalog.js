/**
 * OrchardPatch Agent — Installomator Catalog Sync
 * 
 * Scrapes all fragment files from the Installomator GitHub repo,
 * extracts app name → label mappings, and stores them locally.
 * 
 * This lets us auto-match installed apps to Installomator labels
 * without maintaining a manual bundle ID map.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const CATALOG_DIR = process.getuid && process.getuid() === 0
  ? "/etc/orchardpatch"
  : path.join(os.homedir(), ".orchardpatch");

const CATALOG_FILE = path.join(CATALOG_DIR, "installomator-catalog.json");
const CATALOG_TTL = 7 * 24 * 60 * 60 * 1000; // refresh weekly

const FRAGMENTS_API = "https://api.github.com/repos/Installomator/Installomator/contents/fragments/labels";
const RAW_BASE = "https://raw.githubusercontent.com/Installomator/Installomator/main/fragments/labels";

// In-memory catalog: { name (lowercase) → label, bundleId → label }
let catalog = {
  byName: {},      // "firefox" → "firefoxpkg"
  byBundleId: {},  // "org.mozilla.firefox" → "firefoxpkg"
  labelList: [],   // all known labels
  syncedAt: null,
};

// ─── Load / Save ─────────────────────────────────────────────────────────────

function loadCatalog() {
  try {
    if (fs.existsSync(CATALOG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"));
      catalog = { ...catalog, ...data };
      console.log(`[Catalog] Loaded ${Object.keys(catalog.byName).length} app names, ${Object.keys(catalog.byBundleId).length} bundle IDs`);
      return true;
    }
  } catch (err) {
    console.warn(`[Catalog] Could not load catalog: ${err.message}`);
  }
  return false;
}

function saveCatalog() {
  try {
    if (!fs.existsSync(CATALOG_DIR)) fs.mkdirSync(CATALOG_DIR, { recursive: true });
    fs.writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 2));
  } catch (err) {
    console.warn(`[Catalog] Could not save catalog: ${err.message}`);
  }
}

function getCatalogAge() {
  try {
    if (fs.existsSync(CATALOG_FILE)) {
      return Date.now() - fs.statSync(CATALOG_FILE).mtimeMs;
    }
  } catch { /* ignore */ }
  return Infinity;
}

// ─── Sync ────────────────────────────────────────────────────────────────────

async function fetchWithTimeout(url, timeoutMs = 10000) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "User-Agent": "OrchardPatch-Agent/0.1" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res;
}

async function parseFragment(label, content) {
  const result = { label, names: [], bundleIds: [] };

  // Extract app name(s)
  const nameMatches = content.matchAll(/^\s*name\s*=\s*"([^"]+)"/gm);
  for (const m of nameMatches) {
    const name = m[1].trim();
    if (name) result.names.push(name);
  }

  // Extract bundle ID(s)
  const bidMatches = content.matchAll(/bundleID\s*=\s*"([^"]+)"/gm);
  for (const m of bidMatches) {
    const bid = m[1].trim();
    if (bid && bid !== "REPLACE_ME") result.bundleIds.push(bid);
  }

  // Also try appName= (some fragments use this)
  const appNameMatches = content.matchAll(/^\s*appName\s*=\s*"([^"]+)"/gm);
  for (const m of appNameMatches) {
    const name = m[1].replace(/\.app$/, "").trim();
    if (name && !result.names.includes(name)) result.names.push(name);
  }

  return result;
}

async function syncCatalog(force = false) {
  const age = getCatalogAge();
  if (!force && age < CATALOG_TTL) {
    console.log(`[Catalog] Up to date (${Math.round(age / 3600000)}h old)`);
    return catalog;
  }

  console.log("[Catalog] Syncing Installomator catalog from GitHub...");

  try {
    // Get list of all fragment files
    const listRes = await fetchWithTimeout(FRAGMENTS_API);
    const files = await listRes.json();

    if (!Array.isArray(files)) throw new Error("Unexpected response from GitHub API");

    const labels = files
      .filter(f => f.name.endsWith(".sh"))
      .map(f => f.name.replace(".sh", ""));

    console.log(`[Catalog] Found ${labels.length} labels — fetching fragments...`);

    const byName = {};
    const byBundleId = {};

    // Fetch fragments in batches of 20 to avoid rate limiting
    const BATCH_SIZE = 20;
    let processed = 0;

    for (let i = 0; i < labels.length; i += BATCH_SIZE) {
      const batch = labels.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(
        batch.map(async (label) => {
          try {
            const res = await fetchWithTimeout(`${RAW_BASE}/${label}.sh`, 8000);
            const content = await res.text();
            const parsed = await parseFragment(label, content);

            // Register by name (multiple normalizations for fuzzy matching)
            for (const name of parsed.names) {
              byName[name.toLowerCase()] = label;                          // "zoom.us"
              byName[name.toLowerCase().replace(/\s+/g, "")] = label;     // "zoom.us"→"zoom.us"
              byName[name.toLowerCase().replace(/[\s.]+/g, "")] = label;  // "zoom.us"→"zoomus"
              byName[name.toLowerCase().replace(/\./g, "")] = label;      // "zoom.us"→"zoomus"
            }

            // Register by bundle ID
            for (const bid of parsed.bundleIds) {
              byBundleId[bid] = label;
            }
          } catch {
            // Skip failed fragments silently
          }
        })
      );

      processed += batch.length;
      if (processed % 100 === 0) {
        console.log(`[Catalog] Processed ${processed}/${labels.length} fragments...`);
      }

      // Small delay between batches to be polite to GitHub
      if (i + BATCH_SIZE < labels.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    catalog = {
      byName,
      byBundleId,
      labelList: labels,
      syncedAt: new Date().toISOString(),
    };

    saveCatalog();
    console.log(`[Catalog] Sync complete — ${Object.keys(byName).length} app names, ${Object.keys(byBundleId).length} bundle IDs, ${labels.length} labels`);

    return catalog;
  } catch (err) {
    console.error(`[Catalog] Sync failed: ${err.message}`);
    return catalog; // return whatever we have
  }
}

// ─── Lookup ──────────────────────────────────────────────────────────────────

/**
 * Look up the best Installomator label for an installed app.
 * Priority: bundleId match > exact name match > fuzzy name match
 */
function lookupLabel(appName, bundleId) {
  // 1. Bundle ID exact match (most reliable)
  if (bundleId && catalog.byBundleId[bundleId]) {
    return catalog.byBundleId[bundleId];
  }

  // 2. App name exact match (normalized)
  if (appName) {
    const normalized = appName.toLowerCase().replace(/[\s.]+/g, "");
    if (catalog.byName[normalized]) return catalog.byName[normalized];

    // 3. App name with spaces preserved, dots removed
    const withSpaces = appName.toLowerCase().replace(/\./g, "");
    if (catalog.byName[withSpaces]) return catalog.byName[withSpaces];

    // 4. Original lowercase
    if (catalog.byName[appName.toLowerCase()]) return catalog.byName[appName.toLowerCase()];

    // 5. Partial match — app name starts with label or vice versa
    const nameKey = Object.keys(catalog.byName).find(k =>
      k.startsWith(normalized) || normalized.startsWith(k)
    );
    if (nameKey) return catalog.byName[nameKey];
  }

  return null;
}

/**
 * Enrich an array of installed apps with their Installomator labels
 */
function enrichAppsWithLabels(apps) {
  return apps.map(app => ({
    ...app,
    installomatorLabel: lookupLabel(app.name, app.bundleId) || null,
    patchable: !!lookupLabel(app.name, app.bundleId),
  }));
}

// Load catalog on module init
loadCatalog();

// Kick off background sync if stale (don't await — non-blocking)
if (getCatalogAge() > CATALOG_TTL) {
  syncCatalog().catch(err => console.warn("[Catalog] Background sync failed:", err.message));
}

module.exports = {
  syncCatalog,
  lookupLabel,
  enrichAppsWithLabels,
  getCatalog: () => catalog,
  getCatalogAge,
};
