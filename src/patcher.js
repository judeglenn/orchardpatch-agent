/**
 * OrchardPatch Agent — Patcher
 * Handles Installomator-based patching with job queue and status tracking.
 *
 * Privilege model: Installomator requires root. We use a sudoers entry scoped
 * to Installomator only:
 *   <username> ALL=(root) NOPASSWD: /usr/local/bin/Installomator.sh
 *   <username> ALL=(root) NOPASSWD: /usr/local/bin/Installomator
 *
 * The patcher checks for this and will report a clear error if not configured.
 */

const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");

// ─── Config ──────────────────────────────────────────────────────────────────

const INSTALLOMATOR_PATHS = [
  "/usr/local/bin/Installomator.sh",
  "/usr/local/bin/Installomator",
  "/usr/local/Installomator/Installomator.sh",
];

const INSTALLOMATOR_DOWNLOAD_URL =
  "https://raw.githubusercontent.com/Installomator/Installomator/main/Installomator.sh";

const INSTALLOMATOR_INSTALL_PATH = "/usr/local/bin/Installomator.sh";

// Job store — in-memory, survives process lifetime only
const jobs = new Map();
let jobCounter = 0;

// ─── Mode → Installomator flags ──────────────────────────────────────────────

const PATCH_MODE_FLAGS = {
  silent: {
    NOTIFY: "silent",
    BLOCKING_PROCESS_ACTION: "kill",
    LOGGING: "REQ",
  },
  managed: {
    NOTIFY: "success",
    BLOCKING_PROCESS_ACTION: "tell_user",
    LOGGING: "REQ",
  },
  prompted: {
    NOTIFY: "all",
    BLOCKING_PROCESS_ACTION: "prompt_user",
    LOGGING: "REQ",
  },
};

// ─── Installomator setup ──────────────────────────────────────────────────────

function findInstallomator() {
  for (const p of INSTALLOMATOR_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function downloadInstallomator() {
  return new Promise((resolve, reject) => {
    console.log("[Patcher] Downloading Installomator...");
    const tmpPath = path.join(os.tmpdir(), "Installomator.sh");
    const file = fs.createWriteStream(tmpPath);

    https.get(INSTALLOMATOR_DOWNLOAD_URL, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => {
        file.close();
        // Move to final location (requires sudo)
        try {
          execSync(`sudo mv "${tmpPath}" "${INSTALLOMATOR_INSTALL_PATH}"`);
          execSync(`sudo chmod +x "${INSTALLOMATOR_INSTALL_PATH}"`);
          console.log(`[Patcher] Installomator installed at ${INSTALLOMATOR_INSTALL_PATH}`);
          resolve(INSTALLOMATOR_INSTALL_PATH);
        } catch (err) {
          reject(new Error(`Failed to install Installomator: ${err.message}. Run: sudo mv ${tmpPath} ${INSTALLOMATOR_INSTALL_PATH} && sudo chmod +x ${INSTALLOMATOR_INSTALL_PATH}`));
        }
      });
    }).on("error", reject);
  });
}

function checkSudoAccess(installomatorPath) {
  try {
    // Check if we can sudo Installomator without password
    execSync(`sudo -n "${installomatorPath}" --version 2>/dev/null || sudo -n "${installomatorPath}" DEBUG=1 true 2>/dev/null || true`, {
      timeout: 3000,
    });
    // If we get here without being prompted, we have sudo access
    return true;
  } catch {
    // Try a dry-run check
    try {
      execSync(`sudo -n -l "${installomatorPath}" 2>/dev/null`, { timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  }
}

async function ensureInstallomator() {
  let installomatorPath = findInstallomator();

  if (!installomatorPath) {
    try {
      installomatorPath = await downloadInstallomator();
    } catch (err) {
      throw new Error(`Installomator not found and download failed: ${err.message}`);
    }
  }

  return installomatorPath;
}

// ─── Persistence ─────────────────────────────────────────────────────────────

const HISTORY_DIR = process.getuid && process.getuid() === 0
  ? "/etc/orchardpatch"
  : path.join(os.homedir(), ".orchardpatch");
const HISTORY_FILE = path.join(HISTORY_DIR, "patch-history.json");
const MAX_HISTORY = 500; // keep last 500 jobs

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
      if (Array.isArray(data)) {
        data.forEach(job => jobs.set(job.id, job));
        jobCounter = data.length;
        console.log(`[Patcher] Loaded ${data.length} jobs from history`);
      }
    }
  } catch (err) {
    console.warn(`[Patcher] Could not load history: ${err.message}`);
  }
}

function saveHistory() {
  try {
    if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
    const all = listJobs().slice(0, MAX_HISTORY);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(all, null, 2));
  } catch (err) {
    console.warn(`[Patcher] Could not save history: ${err.message}`);
  }
}

// Load history on module init
loadHistory();

// ─── Job management ──────────────────────────────────────────────────────────

function createJob(label, appName, mode, deviceId) {
  const id = `job-${Date.now()}-${++jobCounter}`;
  const job = {
    id,
    label,
    appName,
    mode,
    deviceId: deviceId || "local",
    status: "queued", // queued | running | success | failed
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    log: [],
    exitCode: null,
    error: null,
  };
  jobs.set(id, job);
  saveHistory();
  return job;
}

function getJob(id) {
  return jobs.get(id) || null;
}

function listJobs() {
  return Array.from(jobs.values()).sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
}

// ─── Patch execution ─────────────────────────────────────────────────────────

/**
 * Run a patch job asynchronously.
 * Returns the job immediately (status: queued), then updates it as it runs.
 */
async function runPatchJob(label, appName, mode, deviceId) {
  const job = createJob(label, appName, mode, deviceId);
  const modeFlags = PATCH_MODE_FLAGS[mode] || PATCH_MODE_FLAGS.managed;

  // Run async — don't await
  _executePatch(job, modeFlags).catch((err) => {
    job.status = "failed";
    job.error = err.message;
    job.completedAt = new Date().toISOString();
    console.error(`[Patcher] Job ${job.id} failed:`, err.message);
  });

  return job;
}

function loadServerConfig() {
  const CONFIG_PATH = process.getuid && process.getuid() === 0
    ? "/etc/orchardpatch/config.json"
    : require("path").join(require("os").homedir(), ".orchardpatch", "config.json");
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch { return {}; }
}

/**
 * POST the completed job record to the fleet server's /patch-jobs endpoint.
 * This is what populates Patch History and success rate stats in the dashboard.
 */
async function reportJobToServer(job) {
  const config = loadServerConfig();
  const serverUrl = config.server?.url || process.env.ORCHARDPATCH_SERVER_URL;
  const serverToken = config.server?.token || process.env.ORCHARDPATCH_SERVER_TOKEN;
  if (!serverUrl || !serverToken) return;

  const res = await fetch(`${serverUrl}/patch-jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-orchardpatch-token": serverToken },
    body: JSON.stringify({
      jobId: job.id,
      deviceId: job.deviceId,
      bundleId: job.bundleId || null,
      appName: job.appName,
      label: job.label,
      mode: job.mode,
      status: job.status,
      exitCode: job.exitCode,
      error: job.error || null,
      log: job.log.join("\n"),
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (res.ok) {
    console.log(`[Patcher] Reported job ${job.id} (${job.status}) to fleet server`);
  } else {
    throw new Error(`Server returned ${res.status}`);
  }
}

/**
 * POST a confirmed installed version to the fleet server's version-sync ingest.
 * Called after a successful Installomator run to keep latest_versions accurate.
 */
async function ingestConfirmedVersion(label, version) {
  const config = loadServerConfig();
  const serverUrl = config.server?.url || process.env.ORCHARDPATCH_SERVER_URL;
  const serverToken = config.server?.token || process.env.ORCHARDPATCH_SERVER_TOKEN;
  if (!serverUrl || !serverToken) return;

  const res = await fetch(`${serverUrl}/api/version-sync/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-orchardpatch-token": serverToken },
    body: JSON.stringify({ results: { [label]: { version, error: null } }, source: "post-patch" }),
    signal: AbortSignal.timeout(10000),
  });

  if (res.ok) {
    console.log(`[Patcher] Ingested confirmed version ${label}@${version} to fleet server`);
  } else {
    throw new Error(`Ingest returned ${res.status}`);
  }
}

async function _executePatch(job, modeFlags) {
  job.status = "running";
  job.startedAt = new Date().toISOString();
  job.log.push(`[${job.startedAt}] Starting patch: ${job.appName} (${job.label}) mode=${job.mode}`);

  let installomatorPath;
  try {
    installomatorPath = await ensureInstallomator();
  } catch (err) {
    job.status = "failed";
    job.error = err.message;
    job.completedAt = new Date().toISOString();
    job.log.push(`[ERROR] ${err.message}`);
    return;
  }

  job.log.push(`[INFO] Using Installomator at: ${installomatorPath}`);

  // Check if running as root (LaunchDaemon) or fall back to sudo (dev mode)
  const isRoot = process.getuid && process.getuid() === 0;
  const cmd = isRoot ? installomatorPath : "sudo";
  const args = isRoot
    ? [
        job.label,
        `NOTIFY=${modeFlags.NOTIFY}`,
        `BLOCKING_PROCESS_ACTION=${modeFlags.BLOCKING_PROCESS_ACTION}`,
        `LOGGING=${modeFlags.LOGGING}`,
        "DEBUG=0",
      ]
    : [
        installomatorPath,
        job.label,
        `NOTIFY=${modeFlags.NOTIFY}`,
        `BLOCKING_PROCESS_ACTION=${modeFlags.BLOCKING_PROCESS_ACTION}`,
        `LOGGING=${modeFlags.LOGGING}`,
        "DEBUG=0",
      ];

  job.log.push(`[INFO] Running${isRoot ? " (root)" : " (sudo)"}: ${cmd} ${args.join(" ")}`);

  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      env: { ...process.env, PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" },
    });

    const logLine = (line) => {
      const ts = new Date().toISOString().substring(11, 19);
      const entry = `[${ts}] ${line.trim()}`;
      job.log.push(entry);
      console.log(`[Patcher:${job.id}] ${line.trim()}`);
    };

    proc.stdout.on("data", (data) => {
      data.toString().split("\n").filter(Boolean).forEach(logLine);
    });

    proc.stderr.on("data", (data) => {
      data.toString().split("\n").filter(Boolean).forEach((line) => logLine(`STDERR: ${line}`));
    });

    proc.on("close", async (code) => {
      job.exitCode = code;
      job.completedAt = new Date().toISOString();

      if (code === 0) {
        job.status = "success";
        job.log.push(`[INFO] Patch completed successfully (exit 0)`);

        // Parse the version Installomator actually installed from its log output.
        // Prefer "Downloaded version of X is <ver>" — this is the version that
        // actually landed on disk. Fall back to appNewVersion from the version
        // check phase if the download line isn't present (e.g. "No newer version").
        const allLog = job.log.join("\n");
        let confirmedVersion = null;

        const downloadedMatch = allLog.match(/Downloaded version.*?is\s+([\d][\d.]+[\d])/i);
        if (downloadedMatch) {
          confirmedVersion = downloadedMatch[1].trim();
          job.log.push(`[INFO] Installed version confirmed from Installomator: ${confirmedVersion}`);
        } else {
          // "No newer version" — the installed version IS the latest
          const noNewer = allLog.includes("No newer version");
          if (noNewer) {
            // Try to parse current appversion from log: "appversion: X.Y.Z"
            const appVerMatch = allLog.match(/appversion:\s*([\d][\d.]+[\d])/i);
            if (appVerMatch) {
              confirmedVersion = appVerMatch[1].trim();
              job.log.push(`[INFO] Already current — version from log: ${confirmedVersion}`);
            }
          }
        }

        // Ingest confirmed version into fleet server latest_versions table
        if (confirmedVersion && job.label) {
          ingestConfirmedVersion(job.label, confirmedVersion).catch(err =>
            job.log.push(`[WARN] Version ingest failed: ${err.message}`)
          );
        }

        // Trigger fresh inventory so UI reflects updated version immediately
        try {
          const { runCollection } = require("./scheduler");
          await runCollection();
          job.log.push(`[INFO] Inventory refreshed post-patch`);
          console.log("[Patcher] Post-patch inventory refresh complete");
        } catch (e) {
          job.log.push(`[WARN] Post-patch inventory refresh failed: ${e.message}`);
        }
      } else {
        job.status = "failed";
        job.error = `Installomator exited with code ${code}`;
        job.log.push(`[ERROR] Patch failed (exit ${code})`);
      }

      saveHistory();

      // Report completed job to fleet server (populates Patch History + stats)
      // Must await before resolve() — fire-and-forget gets dropped after Promise resolves
      try {
        await reportJobToServer(job);
      } catch (err) {
        const msg = `Failed to report job to server: ${err.message}`;
        console.warn(`[Patcher] ${msg}`);
        job.log.push(`[WARN] ${msg}`);
        saveHistory(); // persist the warn to disk
      }

      resolve();
    });

    proc.on("error", async (err) => {
      job.status = "failed";
      job.error = err.message;
      job.log.push(`[ERROR] Process error: ${err.message}`);
      if (err.code === "EACCES" || err.message.includes("sudo")) {
        job.log.push(
          `[HINT] Sudo access required. Add to sudoers:\n  ${os.userInfo().username} ALL=(root) NOPASSWD: ${installomatorPath}`
        );
      }
      job.completedAt = new Date().toISOString();
      saveHistory();

      try {
        await reportJobToServer(job);
      } catch (e) {
        console.warn(`[Patcher] Failed to report job to server: ${e.message}`);
      }

      resolve();
    });
  });
}

// ─── Sudoers helper ──────────────────────────────────────────────────────────

function getSudoersInstruction() {
  const username = os.userInfo().username;
  return [
    `# Add this line to /etc/sudoers via: sudo visudo`,
    `${username} ALL=(root) NOPASSWD: /usr/local/bin/Installomator.sh`,
    `${username} ALL=(root) NOPASSWD: /usr/local/bin/Installomator`,
  ].join("\n");
}

module.exports = {
  runPatchJob,
  getJob,
  listJobs,
  ensureInstallomator,
  findInstallomator,
  getSudoersInstruction,
  BUNDLE_VERSION_MAP_LABELS: null, // set from server
};
