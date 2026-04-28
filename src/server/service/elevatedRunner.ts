// Node-side counterpart to launcher/src/elevated_runner.rs.
//
// When the user clicks "yes install service" in the welcome modal, the
// Node server can't call servy-cli directly because Servy needs admin
// and Velopack installs us per-user without elevation. Instead we
// re-launch our own launcher binary with `--elevate-and-run` argv,
// using PowerShell's `Start-Process -Verb RunAs -Wait` to fire the UAC
// prompt and block until the elevated child exits. The Rust launcher's
// elevate-and-run handler does the actual servy-cli + reg.exe + tray-
// spawn work, then writes a structured result JSON we read back here.
//
// Why this design instead of an embedded UAC manifest on the launcher:
//   - Manifest-elevation prompts UAC EVERY launch, even for users who
//     never enable service mode. This approach only prompts when service
//     mode is actually being installed/uninstalled.
//   - Keeps Velopack's per-user install model intact. No need to switch
//     to ProgramFiles + machine-wide install.
//   - The "what flags to pass servy-cli" knowledge lives in Rust (in
//     elevated_runner.rs) — Node only knows the abstract operation
//     (install / uninstall) and the params. Single source of truth for
//     servy-cli argv shape per the v0.1.5 + v0.1.6 fixes.
//
// Failure modes the caller needs to handle:
//   - User clicks "No" / "Cancel" on the UAC prompt → PowerShell exits
//     non-zero, no result file gets written. We surface this as
//     `{ ok: false, errorMessage: 'user declined elevation' }`.
//   - Launcher crashes mid-execution → result file may be missing or
//     partial. We surface as `{ ok: false, errorMessage: '...' }`.
//   - servy-cli succeeds but post-actions fail → result.ok is true,
//     errorMessage is null, but combined stderr may have warnings.

// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import { execFile } from 'child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'util';
import { Logger } from '../Logger';

const execFileAsync = promisify(execFile);

const log = Logger.for('ElevatedRunner');

/**
 * Result shape mirrors `ElevatedResult` in launcher/src/elevated_runner.rs.
 * Field names use camelCase here (idiomatic TS) and snake_case in Rust;
 * the Rust side serializes with `#[serde(rename_all = "camelCase")]` —
 * wait, it doesn't. Rust serializes as snake_case by default. Update if
 * the Rust struct adds rename_all later. For now we read both keys.
 */
export interface ElevatedResult {
    ok: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
    errorMessage?: string;
}

/**
 * Args shape for `install-service`. Mirrors `InstallServiceArgs` in
 * launcher/src/elevated_runner.rs (snake_case on the wire because that's
 * Rust's default serde format). Caller passes camelCase; we translate.
 */
export interface InstallServiceArgs {
    servyPath: string;
    name: string;
    displayName: string;
    description: string;
    binPath: string;
    startupDir: string;
    startupType: string;
    maxRestartAttempts: number;
    /** Pre-formatted as `KEY=VAL;KEY2=VAL2` per Servy's --envVars syntax. */
    envVars: string;
    logPath: string;
    /** Optional tray helper exe; null/undefined when not present. */
    trayHelperPath?: string;
}

export interface UninstallServiceArgs {
    servyPath: string;
    name: string;
}

/**
 * Resolve the absolute path of the launcher binary that should be
 * elevated. In a Velopack install this is `<install>/ws-scrcpy-web-launcher.exe`.
 * In dev runs we don't have a packaged launcher; callers should check
 * with `launcherIsAvailable()` first before invoking `runElevated`.
 */
export function resolveLauncherPath(): string {
    const exeName = process.platform === 'win32' ? 'ws-scrcpy-web-launcher.exe' : 'ws-scrcpy-web-launcher';
    return path.join(process.cwd(), exeName);
}

export function launcherIsAvailable(): boolean {
    return fs.existsSync(resolveLauncherPath());
}

/**
 * Run an elevate-and-run command via the launcher binary. Returns the
 * structured result the launcher emits; throws only for harness-level
 * failures (PowerShell missing, temp dir not writable, etc.). Operation
 * failures are encoded as `{ ok: false, errorMessage: ... }` in the
 * returned result so callers can render UAC-denied vs servy-failure
 * differently.
 */
export async function runElevated(
    command: 'install-service' | 'uninstall-service',
    args: InstallServiceArgs | UninstallServiceArgs,
): Promise<ElevatedResult> {
    if (process.platform !== 'win32') {
        throw new Error('runElevated is Windows-only');
    }
    const launcherPath = resolveLauncherPath();
    if (!fs.existsSync(launcherPath)) {
        throw new Error(
            `runElevated requires the packaged launcher at ${launcherPath}, ` +
                `which is not present (likely a dev/from-source run rather than a Velopack install)`,
        );
    }

    // Convert camelCase JS field names to snake_case for the Rust side.
    const wireArgs = toSnakeCase(args as unknown as Record<string, unknown>);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scrcpy-elev-'));
    const argsPath = path.join(tmpDir, 'args.json');
    const resultPath = path.join(tmpDir, 'result.json');

    try {
        fs.writeFileSync(argsPath, JSON.stringify(wireArgs, null, 2), 'utf8');

        // PowerShell's Start-Process -Verb RunAs is the standard way to
        // get a UAC prompt for an arbitrary executable. -Wait blocks
        // until the elevated child exits. -PassThru gives us the
        // process object so we can read ExitCode reliably (Start-Process
        // doesn't propagate exit codes by default; -PassThru + -Wait
        // does).
        //
        // We embed the args directly in the PS command string. Each path
        // is a temp-dir path we just generated; they are all absolute
        // and don't contain user-controlled shell metacharacters that
        // would let an attacker inject. Even so, every value goes through
        // a defensive single-quote-escape before interpolation.
        const psScript = buildPsRunAsCommand({
            launcherPath,
            command,
            argsPath,
            resultPath,
        });
        log.info(
            `runElevated(${command}) launching ${launcherPath} via Start-Process -Verb RunAs`,
        );

        let psExitCode = 0;
        try {
            await execFileAsync(
                'powershell.exe',
                [
                    '-NoProfile',
                    '-NonInteractive',
                    '-ExecutionPolicy', 'Bypass',
                    '-Command', psScript,
                ],
                { windowsHide: true, maxBuffer: 1024 * 1024 },
            );
        } catch (err) {
            // Non-zero exit from PowerShell almost always means UAC was
            // declined (Windows returns 1223 ERROR_CANCELLED, which PS
            // surfaces as a terminating error). The result file will be
            // absent in that case.
            const e = err as NodeJS.ErrnoException & { code?: string | number };
            psExitCode = typeof e.code === 'number' ? e.code : -1;
            log.warn(
                `runElevated PowerShell exit ${psExitCode}: ${(err as Error).message ?? '(no message)'}`,
            );
        }

        if (!fs.existsSync(resultPath)) {
            // No result JSON written — almost certainly UAC denied.
            return {
                ok: false,
                exitCode: psExitCode,
                stdout: '',
                stderr: '',
                errorMessage:
                    'user declined elevation. Service install requires Administrator privileges; ' +
                    'click Yes on the UAC prompt to continue.',
            };
        }

        const raw = fs.readFileSync(resultPath, 'utf8');
        return parseResult(raw);
    } finally {
        // Best-effort cleanup. Leaving temp files around isn't dangerous
        // (we use a fresh dir per call), but it's sloppy.
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    }
}

/**
 * Recursively rename camelCase keys to snake_case on a plain JSON-shaped
 * object. Doesn't try to be clever about edge cases — values that are
 * arrays or nested objects are passed through untouched (we don't have
 * any in the current schema).
 */
export function toSnakeCase(input: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
        const snake = k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
        out[snake] = v;
    }
    return out;
}

/**
 * Parse the launcher's result JSON. Tolerates both snake_case (Rust default)
 * and camelCase keys so we don't break if either side changes serialization
 * settings later.
 */
export function parseResult(raw: string): ElevatedResult {
    try {
        const obj = JSON.parse(raw) as Record<string, unknown>;
        const get = (snake: string, camel: string): unknown =>
            obj[snake] !== undefined ? obj[snake] : obj[camel];
        return {
            ok: Boolean(get('ok', 'ok')),
            exitCode: Number(get('exit_code', 'exitCode') ?? 0),
            stdout: String(get('stdout', 'stdout') ?? ''),
            stderr: String(get('stderr', 'stderr') ?? ''),
            errorMessage:
                (get('error_message', 'errorMessage') as string | null | undefined) ?? undefined,
        };
    } catch (err) {
        return {
            ok: false,
            exitCode: -1,
            stdout: '',
            stderr: raw,
            errorMessage: `could not parse elevated runner result: ${(err as Error).message}`,
        };
    }
}

interface PsRunAsParams {
    launcherPath: string;
    command: string;
    argsPath: string;
    resultPath: string;
}

/**
 * Build the PowerShell command string for `Start-Process -Verb RunAs -Wait
 * -PassThru`. Each argument value is single-quote-escaped (PowerShell
 * single-quoted strings only need `'` doubled) and passed as a member of
 * the `-ArgumentList` array so PowerShell quotes them correctly when
 * forming the Win32 lpCommandLine.
 *
 * Exported for unit-testing.
 */
export function buildPsRunAsCommand(params: PsRunAsParams): string {
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const argList = [
        '--elevate-and-run',
        params.command,
        params.argsPath,
        params.resultPath,
    ]
        .map(q)
        .join(',');
    // Start-Process exits 0 on success; on UAC denial it throws a
    // Win32Exception that PowerShell surfaces as a terminating error,
    // which makes execFile reject with non-zero exit. -PassThru +
    // .ExitCode lets us also propagate the elevated child's exit code
    // when the child ran but failed.
    return [
        '$ErrorActionPreference = "Stop";',
        `$p = Start-Process -FilePath ${q(params.launcherPath)} ` +
            `-ArgumentList ${argList} ` +
            `-Verb RunAs -Wait -PassThru -WindowStyle Hidden;`,
        'exit $p.ExitCode',
    ].join(' ');
}
