// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import { execFileSync } from 'child_process';

/**
 * Returns true when the current process is running with Administrator
 * privileges on Windows. Returns false on any non-Windows platform (callers
 * that need cross-platform elevation checks should branch on platform first).
 *
 * Implementation: `net session` requires admin privileges to enumerate active
 * SMB sessions and exits non-zero with "Access is denied" when run unelevated.
 * It's the standard battle-tested Windows admin probe — no Win32 API or FFI
 * needed, ships in every Windows install since at least XP.
 *
 * Why this matters: Servy's CLI requires admin to register services with SCM.
 * Velopack installs ws-scrcpy-web per-user under %LocalAppData% without
 * elevation by default. If the user clicks "yes install service" in the
 * welcome modal from an unelevated process, Servy invocation may UAC-prompt
 * (blocking execFileSync) or just fail with access-denied. Either way the
 * UI sees a hung or 500-error fetch. Detecting non-admin at the API layer
 * lets us return a clear 503 with actionable guidance ("relaunch as admin")
 * instead of a confusing failure.
 */
export function isWindowsAdmin(): boolean {
    if (process.platform !== 'win32') return false;
    try {
        // -nul silences the "Are you sure" prompt; /dev/null equivalent on
        // Windows is `nul`. We don't care about output, only exit code.
        execFileSync('net.exe', ['session'], {
            stdio: ['ignore', 'ignore', 'ignore'],
            // 5s is plenty for a no-network local SMB query; protects us from
            // an unexpected network state where `net session` could hang.
            timeout: 5_000,
        });
        return true;
    } catch {
        return false;
    }
}
