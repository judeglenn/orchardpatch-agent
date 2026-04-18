# OrchardPatch Agent

The lightweight macOS agent for [OrchardPatch](https://orchardpatch.vercel.app) — fleet-wide patch management powered by [Installomator](https://github.com/Installomator/Installomator).

Install it on any Mac and it shows up in your OrchardPatch dashboard automatically.

---

## What it does

- Collects a full app inventory every 15 minutes and reports to your fleet server
- Matches installed apps to Installomator labels (1,083+ apps supported)
- Polls for patch jobs queued from the dashboard and executes them via Installomator
- Runs version checks every ~2.5 hours (every 10 check-ins), pushing latest version data to the fleet server
- After a successful patch: immediately ingests the confirmed installed version and triggers a fresh inventory check-in
- Runs silently as a LaunchDaemon — no user interaction required, no sudo needed

## Requirements

- macOS 12 (Monterey) or later
- Intel or Apple Silicon
- Node.js (installed automatically if using Homebrew)
- Installomator (downloaded automatically on first install)

---

## Installation

### Quick install

```bash
sudo installer -pkg OrchardPatch-Agent.pkg -target /
```

The agent starts automatically and your Mac appears in the fleet within 60 seconds.

### Deploy via Jamf Pro

1. Upload `OrchardPatch-Agent.pkg` to Jamf Pro
2. Upload `pkg/jamf/orchardpatch-enroll.sh` as a script
3. Create a Policy with both the PKG and script
4. Set script parameters:
   - **Parameter 4:** Your org enrollment token
   - **Parameter 5:** Your fleet server URL (optional, defaults to OrchardPatch cloud)
5. Scope to your fleet and deploy

### Manual install

```bash
# Install the PKG
sudo installer -pkg OrchardPatch-Agent.pkg -target /

# Write your org config
sudo bash -c 'cat > /etc/orchardpatch/config.json << EOF
{
  "server": {
    "url": "https://your-fleet-server.railway.app",
    "token": "your-org-token"
  }
}
EOF'

# Restart the agent
sudo launchctl unload /Library/LaunchDaemons/com.orchardpatch.agent.plist
sudo launchctl load /Library/LaunchDaemons/com.orchardpatch.agent.plist
```

---

## Verify it's running

```bash
curl http://127.0.0.1:47652/health
```

Expected response:
```json
{"status":"ok","agent":"orchardpatch","version":"0.1.0","hostname":"your-mac.local"}
```

---

## How patching works

OrchardPatch uses [Installomator](https://github.com/Installomator/Installomator) under the hood — a trusted, community-maintained patching tool used by Mac admins worldwide.

When you trigger a patch from the dashboard:
1. The agent runs Installomator with the app's label
2. Installomator downloads the latest version directly from the vendor
3. The app is updated silently with no user disruption
4. Results are logged and reported back to your fleet server

---

## Uninstall

```bash
sudo /usr/local/orchardpatch/agent/pkg/scripts/uninstall.sh
```

---

## Logs

```
/var/log/orchardpatch/agent.log
/var/log/orchardpatch/agent.error.log
```

---

## Building from source

```bash
git clone https://github.com/judeglenn/orchardpatch-agent
cd orchardpatch-agent
npm install
npm run dev
```

To build the PKG:
```bash
bash build-pkg.sh
```

---

## License

MIT
