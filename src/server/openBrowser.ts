// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import { spawn } from 'child_process';
import { Logger } from './Logger';

const log = Logger.for('OpenBrowser');

/**
 * Best-effort cross-platform "open this URL in the user's default browser."
 *
 * Used by the v0.1.9 first-run UX: when the LOCAL user instance starts
 * for the very first time (firstRunComplete=false, installMode is not
 * service-mode), we invoke this so the user lands on the welcome modal
 * without having to remember to type the URL into a browser themselves.
 *
 * Detached + ignored stdio so the Node server doesn't wait on the
 * browser process. Any failure is logged at info level — opening a
 * browser is a UX nicety, not a hard requirement.
 *
 * Implementation per-platform:
 *   - Windows: `start "" "<url>"` via cmd.exe /c. The empty quoted
 *     title is required because cmd's `start` interprets the first
 *     quoted token as a window title; without it, the URL would be
 *     misparsed.
 *   - Linux:   `xdg-open <url>`. Standard freedesktop.org launcher.
 *   - macOS:   `open <url>`. (Reserved; we don't ship macOS today.)
 */
export function openBrowser(url: string): void {
    try {
        if (process.platform === 'win32') {
            // We pass arguments via array form (no shell interpolation),
            // so a malicious URL can't inject extra cmd.exe commands.
            const child = spawn('cmd.exe', ['/c', 'start', '""', url], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
            });
            child.unref();
            log.info(`opened ${url} via cmd start`);
            return;
        }
        if (process.platform === 'linux') {
            const child = spawn('xdg-open', [url], {
                detached: true,
                stdio: 'ignore',
            });
            child.unref();
            log.info(`opened ${url} via xdg-open`);
            return;
        }
        if (process.platform === 'darwin') {
            const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
            child.unref();
            log.info(`opened ${url} via open`);
            return;
        }
        log.info(`no browser-open handler for platform=${process.platform}; skipping`);
    } catch (err) {
        log.info(`browser open failed (best-effort): ${(err as Error).message}`);
    }
}
