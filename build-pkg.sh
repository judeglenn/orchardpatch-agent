#!/bin/bash
# OrchardPatch Agent — pkg builder
# Produces OrchardPatch-Agent.pkg ready to install or deploy via MDM

set -e

AGENT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$AGENT_DIR/.build"
PAYLOAD_DIR="$BUILD_DIR/payload"
SCRIPTS_DIR="$AGENT_DIR/pkg/scripts"
OUTPUT_PKG="$AGENT_DIR/OrchardPatch-Agent.pkg"
INSTALL_PATH="/usr/local/orchardpatch/agent"
IDENTIFIER="com.orchardpatch.agent"
VERSION="0.1.0"

echo "╔══════════════════════════════════════════╗"
echo "║   OrchardPatch Agent — pkg builder       ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── 1. Clean build dir ────────────────────────────────────────────────────────
echo "→ Cleaning build directory..."
rm -rf "$BUILD_DIR"
mkdir -p "$PAYLOAD_DIR$INSTALL_PATH"

# ── 2. Copy agent source ──────────────────────────────────────────────────────
echo "→ Copying agent source..."
cp -r "$AGENT_DIR/src" "$PAYLOAD_DIR$INSTALL_PATH/"
cp -r "$AGENT_DIR/data" "$PAYLOAD_DIR$INSTALL_PATH/"
cp "$AGENT_DIR/package.json" "$PAYLOAD_DIR$INSTALL_PATH/"
cp "$AGENT_DIR/package-lock.json" "$PAYLOAD_DIR$INSTALL_PATH/" 2>/dev/null || true

# Copy the plist into the agent dir so postinstall can find it
mkdir -p "$PAYLOAD_DIR$INSTALL_PATH/pkg/LaunchDaemons"
cp "$AGENT_DIR/pkg/LaunchDaemons/com.orchardpatch.agent.plist" \
   "$PAYLOAD_DIR$INSTALL_PATH/pkg/LaunchDaemons/"

# ── 3. Install node_modules into payload (production only) ───────────────────
echo "→ Installing production dependencies..."
cd "$PAYLOAD_DIR$INSTALL_PATH"
npm install --omit=dev --quiet
cd "$AGENT_DIR"

# ── 4. Create run.sh ──────────────────────────────────────────────────────────
echo "→ Creating run.sh..."
cat > "$PAYLOAD_DIR$INSTALL_PATH/run.sh" << 'EOF'
#!/bin/bash
# OrchardPatch Agent — startup wrapper
cd /usr/local/orchardpatch/agent
exec /usr/local/bin/node src/server.js
EOF
chmod +x "$PAYLOAD_DIR$INSTALL_PATH/run.sh"

# ── 5. Set permissions ────────────────────────────────────────────────────────
echo "→ Setting permissions..."
chmod -R 755 "$PAYLOAD_DIR$INSTALL_PATH"

# ── 6. Build the pkg ─────────────────────────────────────────────────────────
echo "→ Building pkg..."
pkgbuild \
  --root "$PAYLOAD_DIR" \
  --identifier "$IDENTIFIER" \
  --version "$VERSION" \
  --scripts "$SCRIPTS_DIR" \
  --install-location "/" \
  "$OUTPUT_PKG"

# ── 7. Done ───────────────────────────────────────────────────────────────────
echo ""
echo "✅ Built: $OUTPUT_PKG"
echo ""
echo "To install:     sudo installer -pkg $OUTPUT_PKG -target /"
echo "To verify:      curl http://127.0.0.1:47652/health"
echo "To uninstall:   sudo $INSTALL_PATH/pkg/scripts/uninstall.sh"
echo ""
