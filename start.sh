#!/bin/bash
# ws-scrcpy-web launcher for Linux
# Runs Node.js from dependencies folder, handles restart on update

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE="$SCRIPT_DIR/dependencies/node/node"
ENTRY="$SCRIPT_DIR/dist/index.js"
export DEPS_PATH="$SCRIPT_DIR/dependencies"
RESTART_MARKER="$DEPS_PATH/.restart"

# Ensure node binary exists
if [ ! -x "$NODE" ]; then
    echo "ERROR: Node.js not found at $NODE"
    echo "Run the initial setup or place the node binary in dependencies/node/"
    exit 1
fi

# Clean up stale restart marker
rm -f "$RESTART_MARKER"

while true; do
    echo "Starting ws-scrcpy-web..."
    "$NODE" "$ENTRY"
    EXIT_CODE=$?

    # Check if restart was requested — marker file OR exit code 75
    if [ -f "$RESTART_MARKER" ]; then
        rm -f "$RESTART_MARKER"
        echo "Restarting (marker)..."
        sleep 2
        continue
    fi
    if [ "$EXIT_CODE" -eq 75 ]; then
        echo "Restarting (exit 75)..."
        sleep 2
        continue
    fi

    # Process exited without restart request — stop
    echo "ws-scrcpy-web exited with code $EXIT_CODE"
    exit $EXIT_CODE
done
