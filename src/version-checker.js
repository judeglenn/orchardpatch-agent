/**
 * OrchardPatch Agent — Installomator Version Checker
 *
 * Runs Installomator in DEBUG=1 mode to get latest available versions,
 * then POSTs results to the fleet server's /api/version-sync/ingest endpoint.
 *
 * This is separate from versions.js (HTTP-based checks) — this uses
 * Installomator as the source of truth, matching exactly what patching uses.
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_PATH = process.getuid && process.getuid() === 0
  ? "/etc/orchardpatch/config.json"
  : path.join(os.homedir(), ".orchardpatch", "config.json");

// Installomator paths (try pkg install location first, then homebrew)
const INSTALLOMATOR_PATHS = [
  "/usr/local/Installomator/Installomator.sh",
  "/usr/local/bin/Installomator",
  "/opt/homebrew/bin/Installomator",
];

// Concurrency cap — Installomator runs are heavyweight
const MAX_CONCURRENT = 5;

// Seed label list — used when app_catalog isn't populated yet
// A reasonable cross-section of common enterprise/prosumer macOS apps
const SEED_LABELS = [
  "googlechromepkg", "firefox", "microsoftedge",
  "zoom", "slack", "microsoftteams",
  "microsoftword", "microsoftexcel", "microsoftpowerpoint", "microsoftoutlook",
  "visualstudiocode", "docker", "1password7", "1password8",
  "notion", "figma", "dropbox", "boxdrive",
  "jamfconnect", "nomad", "privileges",
];

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    }
  } catch { /* ignore */ }
  return {};
}

function findInstallomator() {
  for (const p of INSTALLOMATOR_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Run Installomator DEBUG=1 for a single label and parse appNewVersion.
 * Returns { version: string|null, error: string|null }
 */
function checkLabelVersion(installomatorPath, label) {
  try {
    const output = execSync(
      `DEBUG=1 "${installomatorPath}" "${label}"`,
      {
        timeout: 30000,
        env: { ...process.env, DEBUG: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      }
    ).toString();

    const match = output.match(/appNewVersion\s*=\s*["']?([^\s"'\n]+)["']?/i);
    if (match) {
      return { version: match[1].trim(), error: null };
    }

    // Installomator ran but no version found — app may not have a version check
    return { version: null, error: null };
  } catch (err) {
    // execSync throws on non-zero exit — still try to parse from stderr/stdout
    const output = (err.stdout?.toString() || "") + (err.stderr?.toString() || "");
    const match = output.match(/appNewVersion\s*=\s*["']?([^\s"'\n]+)["']?/i);
    if (match) {
      return { version: match[1].trim(), error: null };
    }
    return { version: null, error: err.message.slice(0, 200) };
  }
}

/**
 * Run version checks for a batch of labels with a concurrency cap.
 * Returns { label: { version, error } } map.
 */
async function checkVersionBatch(labels) {
  const installomatorPath = findInstallomator();
  if (!installomatorPath) {
    console.warn("[VersionChecker] Installomator not found — skipping version check");
    return {};
  }

  console.log(`[VersionChecker] Checking ${labels.length} labels (concurrency: ${MAX_CONCURRENT})`);
  const results = {};

  // Run in chunks of MAX_CONCURRENT
  for (let i = 0; i < labels.length; i += MAX_CONCURRENT) {
    const chunk = labels.slice(i, i + MAX_CONCURRENT);
    await Promise.allSettled(
      chunk.map(async (label) => {
        const result = checkLabelVersion(installomatorPath, label);
        results[label] = result;
        if (result.version) {
          console.log(`[VersionChecker]   ${label}: ${result.version}`);
        } else if (result.error) {
          console.warn(`[VersionChecker]   ${label}: error — ${result.error}`);
        }
      })
    );
  }

  return results;
}

/**
 * Build the label list from installed apps via catalog lookup.
 * Falls back to SEED_LABELS if catalog has no labels yet.
 */
function buildLabelList(installedApps) {
  const { getCatalog } = require("./catalog");
  const cat = getCatalog();

  // If catalog is populated, pull labels from installed apps that have matches
  if (installedApps && installedApps.length > 0) {
    const labels = installedApps
      .map(app => app.installomatorLabel)
      .filter(Boolean);

    const unique = [...new Set(labels)];
    if (unique.length > 0) {
      console.log(`[VersionChecker] ${unique.length} labels from installed app inventory`);
      return unique;
    }
  }

  // Fallback: use seed list
  console.log(`[VersionChecker] No app inventory labels — using ${SEED_LABELS.length} seed labels`);
  return SEED_LABELS;
}

/**
 * POST version results to the fleet server's ingest endpoint.
 * Fire-and-forget — errors are logged but don't block anything.
 */
async function ingestToServer(results) {
  const config = loadConfig();
  const serverUrl = config.server?.url || process.env.ORCHARDPATCH_SERVER_URL;
  const serverToken = config.server?.token || process.env.ORCHARDPATCH_SERVER_TOKEN;

  if (!serverUrl || !serverToken) {
    console.warn("[VersionChecker] Server not configured — skipping ingest");
    return;
  }

  try {
    const res = await fetch(`${serverUrl}/api/version-sync/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-orchardpatch-token": serverToken,
      },
      body: JSON.stringify({ results, source: "agent" }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const text = await res.text();
      console.warn(`[VersionChecker] Ingest failed: ${res.status} ${text}`);
    } else {
      const data = await res.json();
      console.log(`[VersionChecker] Ingested ${data.upserted} labels to server`);
    }
  } catch (err) {
    console.warn(`[VersionChecker] Ingest error: ${err.message}`);
  }
}

/**
 * Main entry point — build label list, run checks, ingest results.
 * Designed to be called async/fire-and-forget from the scheduler.
 */
async function runVersionCheck(installedApps) {
  const labels = buildLabelList(installedApps);
  if (labels.length === 0) return;

  const results = await checkVersionBatch(labels);
  const withVersions = Object.values(results).filter(r => r.version).length;
  console.log(`[VersionChecker] Complete — ${withVersions}/${labels.length} labels have versions`);

  await ingestToServer(results);
}

module.exports = { runVersionCheck, checkVersionBatch, buildLabelList, SEED_LABELS };
