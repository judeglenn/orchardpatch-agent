/**
 * OrchardPatch Agent — Central Server Check-in
 * Reports inventory to the OrchardPatch central server periodically.
 * Non-blocking — agent works fine if server is unreachable.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_PATH = process.getuid && process.getuid() === 0
  ? "/etc/orchardpatch/config.json"
  : path.join(os.homedir(), ".orchardpatch", "config.json");

const AGENT_VERSION = "0.1.0";

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    }
  } catch { /* ignore */ }
  return {};
}

/**
 * Report inventory to the central OrchardPatch server.
 * Config must have: server.url and server.token
 */
async function checkinToServer(inventory) {
  const config = loadConfig();
  const serverUrl = config.server?.url || process.env.ORCHARDPATCH_SERVER_URL;
  const serverToken = config.server?.token || process.env.ORCHARDPATCH_SERVER_TOKEN;

  if (!serverUrl || !serverToken) {
    // Not configured — silently skip
    return;
  }

  const payload = {
    device: inventory.device,
    apps: inventory.apps,
    agentVersion: AGENT_VERSION,
    collectedAt: inventory.collectedAt || new Date().toISOString(),
  };

  const res = await fetch(`${serverUrl}/checkin`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-orchardpatch-token": serverToken,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Server returned ${res.status}: ${text}`);
  }

  const data = await res.json();
  console.log(`[CheckIn] Reported to server — deviceId: ${data.deviceId}`);
  return data;
}

/**
 * Report a completed patch job to the central server.
 */
async function reportPatchJob(job) {
  const config = loadConfig();
  const serverUrl = config.server?.url || process.env.ORCHARDPATCH_SERVER_URL;
  const serverToken = config.server?.token || process.env.ORCHARDPATCH_SERVER_TOKEN;

  if (!serverUrl || !serverToken) return;

  await fetch(`${serverUrl}/patch-jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-orchardpatch-token": serverToken,
    },
    body: JSON.stringify({
      jobId: job.id,
      deviceId: `device-${os.hostname()}`,
      bundleId: job.bundleId,
      appName: job.appName,
      label: job.label,
      mode: job.mode,
      status: job.status,
      exitCode: job.exitCode,
      error: job.error,
      log: job.log,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    }),
    signal: AbortSignal.timeout(10000),
  });
}

module.exports = { checkinToServer, reportPatchJob };
