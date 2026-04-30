import { spawn } from 'node:child_process';

export type ActiveSessionResult =
    | { ok: true; sessionId: number }
    | { ok: false; errorMessage: string };

/**
 * Resolve the user's interactive console session ID by invoking
 * `<launcherPath> --print-active-session` and parsing stdout.
 *
 * Used by the service-Node (LocalSystem) to discover the user's session
 * before writing a control marker. Returns `ok: false` on any failure
 * (missing exe, non-numeric output, non-zero exit) — the caller should
 * fall back to writing the marker without a session filter.
 */
export async function resolveActiveSessionId(launcherPath: string): Promise<ActiveSessionResult> {
    // Fix 1: reject paths containing shell metacharacters before spawning.
    if (/["\n\r&|^<>%!]/.test(launcherPath)) {
        return { ok: false, errorMessage: 'launcher path contains unsafe shell metacharacters' };
    }

    return new Promise((resolve) => {
        let resolved = false;
        const done = (result: ActiveSessionResult) => {
            if (!resolved) {
                resolved = true;
                resolve(result);
            }
        };

        // Quote the path to handle spaces, then append the fixed flag as a
        // single command string.  shell:true is required on Windows so that
        // both *.exe and *.cmd stubs are handled uniformly; passing the full
        // command as one string (instead of an args array) avoids Node's
        // DEP0190 shell-quoting deprecation warning.
        const cmd = `"${launcherPath}" --print-active-session`;
        const child = spawn(cmd, {
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
            shell: true,
        });

        // Fix 2: 5-second timeout — kill the child and resolve ok:false.
        const timer = setTimeout(() => {
            child.kill();
            done({ ok: false, errorMessage: 'launcher --print-active-session timed out after 5s' });
        }, 5000);

        let stdout = '';
        child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
        child.on('error', (e) => {
            clearTimeout(timer);
            done({ ok: false, errorMessage: e.message });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                done({ ok: false, errorMessage: `launcher exited ${code}` });
                return;
            }
            const trimmed = stdout.trim();
            const parsed = Number.parseInt(trimmed, 10);
            if (!Number.isFinite(parsed) || String(parsed) !== trimmed) {
                done({ ok: false, errorMessage: `non-numeric stdout: ${JSON.stringify(stdout)}` });
                return;
            }
            done({ ok: true, sessionId: parsed });
        });
    });
}
