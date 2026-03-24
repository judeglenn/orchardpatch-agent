/**
 * OrchardPatch Agent — Inventory Collection
 * Gathers app inventory from the local machine without MDM or Secure Token.
 * Runs as root via LaunchDaemon.
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

/**
 * Get hardware and OS info for this device
 */
function getDeviceInfo() {
  try {
    const hwRaw = execSync("system_profiler SPHardwareDataType -json", { timeout: 10000 }).toString();
    const hw = JSON.parse(hwRaw).SPHardwareDataType?.[0] ?? {};

    const osVersion = execSync("sw_vers -productVersion", { timeout: 5000 }).toString().trim();
    const osBuild = execSync("sw_vers -buildVersion", { timeout: 5000 }).toString().trim();
    const hostname = os.hostname();
    const serial = hw.serial_number ?? "unknown";
    const model = hw.machine_model ?? hw.machine_name ?? "Mac";
    const cpu = hw.cpu_type ?? "Apple Silicon";
    const ram = hw.physical_memory ?? "unknown";

    return {
      hostname,
      serial,
      model,
      cpu,
      ram,
      osVersion,
      osBuild,
      collectedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error("Error collecting device info:", err.message);
    return { hostname: os.hostname(), collectedAt: new Date().toISOString() };
  }
}

/**
 * Get installed apps by scanning /Applications and ~/Applications
 * Reads Info.plist from each .app bundle for name + version
 */
function getInstalledApps() {
  const searchPaths = [
    "/Applications",
    path.join(os.homedir(), "Applications"),
    "/System/Applications",
  ];

  const apps = [];
  const seen = new Set();

  for (const dir of searchPaths) {
    if (!fs.existsSync(dir)) continue;

    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".app")) continue;

      const appPath = path.join(dir, entry);
      const plistPath = path.join(appPath, "Contents", "Info.plist");

      if (!fs.existsSync(plistPath)) continue;

      try {
        // Use PlistBuddy to read key values — available on all Macs
        const getName = (key) => {
          try {
            return execSync(
              `/usr/libexec/PlistBuddy -c "Print :${key}" "${plistPath}" 2>/dev/null`,
              { timeout: 3000 }
            ).toString().trim();
          } catch {
            return null;
          }
        };

        const bundleId = getName("CFBundleIdentifier");
        const name = getName("CFBundleName") || getName("CFBundleDisplayName") || entry.replace(".app", "");
        const version = getName("CFBundleShortVersionString") || getName("CFBundleVersion") || "unknown";

        if (!bundleId || seen.has(bundleId)) continue;
        seen.add(bundleId);

        apps.push({
          name,
          bundleId,
          version,
          path: appPath,
          source: dir.startsWith("/System") ? "system" : "user",
        });
      } catch {
        // Skip apps we can't read
        continue;
      }
    }
  }

  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Full inventory snapshot
 */
function collectInventory() {
  console.log("[OrchardPatch Agent] Collecting inventory...");
  const device = getDeviceInfo();
  const apps = getInstalledApps();

  console.log(`[OrchardPatch Agent] Found ${apps.length} apps on ${device.hostname}`);

  return {
    device,
    apps,
    agentVersion: "0.1.0",
    collectedAt: new Date().toISOString(),
  };
}

module.exports = { collectInventory, getDeviceInfo, getInstalledApps };
