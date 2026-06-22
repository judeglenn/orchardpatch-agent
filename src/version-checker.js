/**
 * OrchardPatch Agent — Installomator Version Checker
 *
 * Runs Installomator in DEBUG=1 mode to get latest available versions,
 * then POSTs results to the fleet server's /api/version-sync/ingest endpoint.
 *
 * This is separate from versions.js (HTTP-based checks) — this uses
 * Installomator as the source of truth, matching exactly what patching uses.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_PATH = process.getuid && process.getuid() === 0
  ? "/etc/orchardpatch/config.json"
  : path.join(os.homedir(), ".orchardpatch", "config.json");

// Installomator paths (try pkg install location first, then homebrew)
const INSTALLOMATOR_PATHS = [
  "/usr/local/Installomator/Installomator.sh",
  "/usr/local/bin/Installomator.sh",
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
 * Kills the process as soon as appNewVersion is found — avoids full package download.
 * Returns Promise<{ version: string|null, error: string|null }>
 */
function checkLabelVersion(installomatorPath, label) {
  return new Promise((resolve) => {
    const VERSION_RE = /appNewVersion\s*=\s*["']?([^\s"'\n]+)["']?/i;
    // 12s timeout — enough for API/HEAD version checks, not enough for full downloads
    const TIMEOUT_MS = 12000;
    let resolved = false;
    let stdoutBuf = "";
    let stderrBuf = "";

    const args = [label, "NOTIFY=silent", "DEBUG=1"];
    if (process.env.GITHUB_TOKEN) {
      args.push("GITHUB_TOKEN=" + process.env.GITHUB_TOKEN);
    }
    const child = spawn(installomatorPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    function done(version, error) {
      if (resolved) return;
      resolved = true;
      try { child.kill("SIGTERM"); } catch (_) {}
      if (version) {
        const looksLikeVersion = /^\d+\.\d/.test(version);
        if (!looksLikeVersion) {
          return resolve({ version: null, error: `Rejected non-version string: ${version.slice(0, 80)}` });
        }
        return resolve({ version, error: null });
      }
      return resolve({ version: null, error: error || null });
    }

    // Scan each chunk of stdout/stderr for appNewVersion — kill immediately on match
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString();
      const match = stdoutBuf.match(VERSION_RE);
      if (match) done(match[1].trim(), null);
    });

    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
      const match = stderrBuf.match(VERSION_RE);
      if (match) done(match[1].trim(), null);
    });

    child.on("close", (code, signal) => {
      if (resolved) return;
      // Process ended without a version match
      const combined = stdoutBuf + stderrBuf;
      const match = combined.match(VERSION_RE);
      if (match) return done(match[1].trim(), null);
      if (code !== 0 && signal !== "SIGTERM") {
        return done(null, `Command failed (exit ${code})`);
      }
      done(null, null);
    });

    child.on("error", (err) => done(null, err.message.slice(0, 200)));

    // Hard timeout — if we haven't found a version in TIMEOUT_MS, give up
    const timer = setTimeout(() => done(null, `Timeout after ${TIMEOUT_MS}ms`), TIMEOUT_MS);
    // Don't let the timer keep the process alive
    if (timer.unref) timer.unref();
  });
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
        const result = await checkLabelVersion(installomatorPath, label);
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
 * Build the label list from installed apps, then union in fleet-known labels
 * from the server. Fleet labels cover apps installed on other devices that
 * this device hasn't seen yet — ensures the full label space is checked.
 * Falls back to SEED_LABELS if local inventory is empty.
 */
async function buildLabelList(installedApps) {
  // Step 1: build local list from this device's inventory
  let localLabels = [];
  if (installedApps && installedApps.length > 0) {
    const labels = installedApps
      .map(app => app.installomatorLabel)
      .filter(Boolean);
    localLabels = [...new Set(labels)];
  }

  // Seed fallback if local inventory has no labels
  if (localLabels.length === 0) {
    console.log(`[VersionChecker] No app inventory labels — using ${SEED_LABELS.length} seed labels`);
    localLabels = SEED_LABELS;
  }

  // Step 2: fetch fleet-wide labels from server
  let fleetLabels = [];
  try {
    const config = loadConfig();
    const serverUrl = config.server?.url || process.env.ORCHARDPATCH_SERVER_URL;
    const serverToken = config.server?.token || process.env.ORCHARDPATCH_SERVER_TOKEN;

    if (serverUrl && serverToken) {
      const res = await fetch(`${serverUrl}/api/version-sync`, {
        headers: { "x-orchardpatch-token": serverToken },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const data = await res.json();
        fleetLabels = (data.versions || []).map(v => v.label).filter(Boolean);
      } else {
        console.warn(`[VersionChecker] Fleet label fetch failed: ${res.status} — using local labels only`);
      }
    }
  } catch (err) {
    console.warn(`[VersionChecker] Fleet label fetch error: ${err.message} — using local labels only`);
  }

  // Step 3: union — always additive, never drop a local label
  const combined = [...new Set([...localLabels, ...fleetLabels])];
  const fleetOnly = combined.length - localLabels.length;
  console.log(`[VersionChecker] Labels: ${localLabels.length} local + ${fleetOnly} fleet-only = ${combined.length} total`);

  return combined;
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
  const labels = await buildLabelList(installedApps);
  if (labels.length === 0) return;

  const results = await checkVersionBatch(labels);
  const withVersions = Object.values(results).filter(r => r.version).length;
  console.log(`[VersionChecker] Complete — ${withVersions}/${labels.length} labels have versions`);

  await ingestToServer(results);
}

module.exports = { runVersionCheck, checkVersionBatch, buildLabelList, SEED_LABELS };
