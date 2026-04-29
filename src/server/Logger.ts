import * as fs from 'fs';
import * as path from 'path';

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * Compute the log file path. Per Local-Dependencies-Only architecture
 * (CLAUDE.md), runtime mutable state including logs lives in dataRoot,
 * not in the install image — a Velopack swap of `current/` should not
 * wipe accumulated logs.
 *
 * Resolution order:
 *   1. <dataRoot>/ws-scrcpy-web.log  — the production target. dataRoot is
 *      derived from DEPS_PATH (which the launcher always sets to
 *      <dataRoot>/dependencies/), so dataRoot = path.dirname(DEPS_PATH).
 *   2. <__dirname>/../ws-scrcpy-web.log  — dev fallback when DEPS_PATH
 *      isn't set (npm start without launcher, vitest, etc.).
 *
 * Pre-v0.1.23-beta.25 the log lived at the dev-fallback path
 * unconditionally — for production that resolved to
 * <installRoot>/current/ws-scrcpy-web.log, inside the swappable image,
 * so the log was lost on every in-app update. Fixing it now.
 */
function resolveLogFilePath(): string {
    const depsPath = process.env['DEPS_PATH'];
    if (depsPath) {
        return path.join(path.dirname(depsPath), 'ws-scrcpy-web.log');
    }
    // After webpack build, __dirname = dist/. One level up = project root.
    return path.resolve(__dirname, '..', 'ws-scrcpy-web.log');
}

const LOG_FILE = resolveLogFilePath();
const BACKUP_FILE = `${LOG_FILE}.1`;

let rotationChecked = false;

function rotateIfNeeded(): void {
    if (rotationChecked) return;
    rotationChecked = true;
    // Ensure the log directory exists. dataRoot itself is created by the
    // install hook on Windows, but on first launch / fresh dev checkouts
    // there's a possible window where the directory hasn't been touched
    // yet. mkdir is idempotent so this is cheap.
    try {
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    } catch {
        // If we can't even create the directory, the appendFileSync below
        // will fail and writeToFile will silently swallow — same behavior
        // as before this defense was added.
    }
    try {
        const stats = fs.statSync(LOG_FILE);
        if (stats.size >= MAX_LOG_SIZE) {
            fs.renameSync(LOG_FILE, BACKUP_FILE);
        }
    } catch {
        // File doesn't exist yet — nothing to rotate
    }
}

function timestamp(): string {
    return new Date().toISOString();
}

function writeToFile(line: string): void {
    rotateIfNeeded();
    try {
        fs.appendFileSync(LOG_FILE, line + '\n');
    } catch {
        // If we can't write to the log file, don't crash the server
    }
}

export class Logger {
    private readonly tag: string;

    private constructor(tag: string) {
        this.tag = `[${tag}]`;
    }

    static for(tag: string): Logger {
        return new Logger(tag);
    }

    info(...args: unknown[]): void {
        const ts = timestamp();
        const message = args.map(String).join(' ');
        const line = `${ts} ${this.tag} ${message}`;
        // v0.1.17: prefix console output too so server.log (launcher-
        // redirected stdout/stderr from the Node child) shows timestamps,
        // matching launcher.log. Pre-v0.1.17 only ws-scrcpy-web.log got
        // timestamps; server.log was bare [tag] message.
        console.log(`${ts} ${this.tag}`, ...args);
        writeToFile(line);
    }

    warn(...args: unknown[]): void {
        const ts = timestamp();
        const message = args.map(String).join(' ');
        const line = `${ts} ${this.tag} WARN ${message}`;
        console.warn(`${ts} ${this.tag} WARN`, ...args);
        writeToFile(line);
    }

    error(...args: unknown[]): void {
        const ts = timestamp();
        const message = args.map(String).join(' ');
        const line = `${ts} ${this.tag} ERROR ${message}`;
        console.error(`${ts} ${this.tag} ERROR`, ...args);
        writeToFile(line);
    }
}
