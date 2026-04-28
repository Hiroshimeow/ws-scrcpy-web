import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoist-safe mocks so each test can read/reset the captured calls.
const execFileSyncMock = vi.fn();
const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
    spawn: (...args: unknown[]) => spawnMock(...args),
}));

const existsSyncMock = vi.fn();
vi.mock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    return {
        ...actual,
        existsSync: (...args: unknown[]) => existsSyncMock(...args),
        default: {
            ...actual,
            existsSync: (...args: unknown[]) => existsSyncMock(...args),
        },
    };
});

import { isServyNotInstalledError, parseServyStatus, ServyClient } from '../service/ServyClient';

/** Build a minimal stand-in for the `ChildProcess` returned by `spawn`. */
function fakeChildProcess() {
    return { unref: vi.fn() };
}

describe('ServyClient', () => {
    beforeEach(() => {
        execFileSyncMock.mockReset();
        execFileSyncMock.mockReturnValue('');
        spawnMock.mockReset();
        spawnMock.mockReturnValue(fakeChildProcess());
        existsSyncMock.mockReset();
        // Default: tray helper not present anywhere — keeps existing tests
        // (which don't care about tray) from accidentally triggering reg.exe.
        existsSyncMock.mockReturnValue(false);
    });

    it('install passes the full Servy CLI argument shape', async () => {
        const client = new ServyClient('C:\\fake\\servy-cli.exe');
        await client.install({
            name: 'WsScrcpyWeb',
            displayName: 'ws-scrcpy-web',
            description: 'desc',
            binPath: 'C:\\app\\node.exe',
            startupDir: 'C:\\app',
            startType: 'Automatic',
            maxRestartAttempts: 3,
            envVars: { DEPS_PATH: 'C:\\deps', FOO: 'bar' },
            logPath: 'C:\\app\\service.log',
        });
        // Two execFileSync calls: install + auto-start.
        expect(execFileSyncMock).toHaveBeenCalledTimes(2);
        const [installCall, startCall] = execFileSyncMock.mock.calls;
        const [cmd, args] = installCall;
        expect(cmd).toBe('C:\\fake\\servy-cli.exe');
        // Servy 8.2 flag names (NOT --binPath / --account / --startType /
        // --logPath — those were the v0.1.4 bug). No --user flag = service
        // runs as Local System. --startupDir + --recoveryAction added in
        // v0.1.6 to fix "service runs but app unreachable" — without
        // startupDir Servy fell back to the dir of the binary path; without
        // recoveryAction the service's recovery defaulted to None.
        expect(args).toEqual([
            'install',
            '--name', 'WsScrcpyWeb',
            '--displayName', 'ws-scrcpy-web',
            '--description', 'desc',
            '--path', 'C:\\app\\node.exe',
            '--startupDir', 'C:\\app',
            '--startupType', 'Automatic',
            '--recoveryAction', 'RestartProcess',
            '--maxRestartAttempts', '3',
            '--envVars', 'DEPS_PATH=C:\\deps;FOO=bar',
            '--stdout', 'C:\\app\\service.log',
            '--stderr', 'C:\\app\\service.log',
        ]);
        // Regression guard: none of the v0.1.4-broken flag names should be
        // present in argv.
        expect(args).not.toContain('--binPath');
        expect(args).not.toContain('--account');
        expect(args).not.toContain('--startType');
        expect(args).not.toContain('--logPath');
        expect(args).not.toContain('--user');
        // Auto-start (v0.1.6 fix): Servy install does not start the
        // service. Without an explicit start, the user has to reboot or
        // manually start via services.msc.
        expect(startCall[0]).toBe('C:\\fake\\servy-cli.exe');
        expect(startCall[1]).toEqual(['start', '--name', 'WsScrcpyWeb']);
    });

    it('uninstall calls servy-cli uninstall --name', async () => {
        const client = new ServyClient('servy.exe');
        await client.uninstall('WsScrcpyWeb');
        const [, args] = execFileSyncMock.mock.calls[0];
        expect(args).toEqual(['uninstall', '--name', 'WsScrcpyWeb']);
    });

    it('stop calls servy-cli stop --name', async () => {
        const client = new ServyClient('servy.exe');
        await client.stop('WsScrcpyWeb');
        const [, args] = execFileSyncMock.mock.calls[0];
        expect(args).toEqual(['stop', '--name', 'WsScrcpyWeb']);
    });

    it('restart calls servy-cli restart --name', async () => {
        const client = new ServyClient('servy.exe');
        await client.restart('WsScrcpyWeb');
        const [, args] = execFileSyncMock.mock.calls[0];
        expect(args).toEqual(['restart', '--name', 'WsScrcpyWeb']);
    });

    it('status calls `servy-cli status --name X` and parses Running', async () => {
        execFileSyncMock.mockReturnValue("Service status for 'WsScrcpyWeb': Running\n");
        const client = new ServyClient('servy.exe');
        const status = await client.status('WsScrcpyWeb');
        expect(status).toBe('running');
        const [, args] = execFileSyncMock.mock.calls[0];
        expect(args).toEqual(['status', '--name', 'WsScrcpyWeb']);
    });

    it('status returns not-installed when servy-cli reports the service does not exist', async () => {
        // v0.1.6: Servy returns non-zero with "service not found" stderr
        // when the named service is absent. We translate that one specific
        // case to 'not-installed' instead of bubbling as a generic error.
        execFileSyncMock.mockImplementation(() => {
            const err = new Error('non-zero') as NodeJS.ErrnoException & { stderr: string };
            err.stderr = "Service 'WsScrcpyWeb' not found";
            throw err;
        });
        const client = new ServyClient('servy.exe');
        const status = await client.status('WsScrcpyWeb');
        expect(status).toBe('not-installed');
    });

    it('status rethrows non-not-installed servy errors (so genuine failures surface)', async () => {
        execFileSyncMock.mockImplementation(() => {
            const err = new Error('non-zero') as NodeJS.ErrnoException & { stderr: string };
            err.stderr = 'Access is denied';
            throw err;
        });
        const client = new ServyClient('servy.exe');
        await expect(client.status('WsScrcpyWeb')).rejects.toThrow(/Access is denied/);
    });

    it('install also registers tray Run-key and spawns the helper when present', async () => {
        // First existsSync call resolves the installed-layout tray helper.
        existsSyncMock.mockReturnValueOnce(true);
        const client = new ServyClient('C:\\fake\\servy-cli.exe');
        await client.install({
            name: 'WsScrcpyWeb',
            displayName: 'ws-scrcpy-web',
            description: 'desc',
            binPath: 'C:\\app\\node.exe',
            startupDir: 'C:\\app',
            startType: 'Automatic',
            maxRestartAttempts: 3,
            envVars: {},
            logPath: 'C:\\app\\service.log',
        });

        // Three execFileSync calls: servy install + servy start (v0.1.6
        // auto-start) + reg.exe add for tray Run-key.
        expect(execFileSyncMock).toHaveBeenCalledTimes(3);
        const [servyInstallCall, servyStartCall, regCall] = execFileSyncMock.mock.calls;
        expect(servyInstallCall[0]).toBe('C:\\fake\\servy-cli.exe');
        expect(servyStartCall[0]).toBe('C:\\fake\\servy-cli.exe');
        expect(servyStartCall[1]).toEqual(['start', '--name', 'WsScrcpyWeb']);
        expect(regCall[0]).toBe('reg.exe');
        const regArgs = regCall[1] as string[];
        expect(regArgs[0]).toBe('add');
        expect(regArgs[1]).toBe('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run');
        expect(regArgs).toContain('/v');
        expect(regArgs[regArgs.indexOf('/v') + 1]).toBe('WsScrcpyWebTray');
        expect(regArgs).toContain('/t');
        expect(regArgs[regArgs.indexOf('/t') + 1]).toBe('REG_SZ');
        expect(regArgs).toContain('/d');
        // The /d value should be the path that existsSync reported true for —
        // i.e. the installed-layout candidate (cwd/ws-scrcpy-web-tray.exe).
        expect(regArgs[regArgs.indexOf('/d') + 1]).toMatch(/ws-scrcpy-web-tray\.exe$/);
        expect(regArgs).toContain('/f');

        // spawn should fire once with detached + ignore stdio + .unref() called.
        expect(spawnMock).toHaveBeenCalledTimes(1);
        const [spawnCmd, spawnArgs, spawnOpts] = spawnMock.mock.calls[0];
        expect(spawnCmd).toMatch(/ws-scrcpy-web-tray\.exe$/);
        expect(spawnArgs).toEqual([]);
        expect(spawnOpts).toEqual({ detached: true, stdio: 'ignore' });
        const child = spawnMock.mock.results[0].value as { unref: ReturnType<typeof vi.fn> };
        expect(child.unref).toHaveBeenCalledTimes(1);
    });

    it('install logs warning but succeeds when tray helper is absent', async () => {
        // existsSync returns false for both candidate paths -> resolveTrayHelperPath throws.
        existsSyncMock.mockReturnValue(false);
        const client = new ServyClient('C:\\fake\\servy-cli.exe');
        await expect(
            client.install({
                name: 'WsScrcpyWeb',
                displayName: 'ws-scrcpy-web',
                description: 'desc',
                binPath: 'C:\\app\\node.exe',
                startupDir: 'C:\\app',
                startType: 'Automatic',
                maxRestartAttempts: 3,
                envVars: {},
                logPath: 'C:\\app\\service.log',
            }),
        ).resolves.toBeUndefined();

        // Servy install + Servy start ran; reg.exe and spawn did NOT (tray absent).
        expect(execFileSyncMock).toHaveBeenCalledTimes(2);
        expect(execFileSyncMock.mock.calls[0][0]).toBe('C:\\fake\\servy-cli.exe');
        expect(execFileSyncMock.mock.calls[1][0]).toBe('C:\\fake\\servy-cli.exe');
        expect(execFileSyncMock.mock.calls[1][1]).toEqual(['start', '--name', 'WsScrcpyWeb']);
        expect(spawnMock).not.toHaveBeenCalled();
    });

    it('install succeeds even when servy-cli start fails (auto-start is best-effort)', async () => {
        // First execFileSync (install) succeeds, second (start) throws. The
        // service is installed correctly; the user can manually start later.
        execFileSyncMock
            .mockImplementationOnce(() => '')
            .mockImplementationOnce(() => {
                const err = new Error('non-zero exit') as NodeJS.ErrnoException & {
                    stderr: string;
                };
                err.stderr = 'Could not start service';
                throw err;
            });
        const client = new ServyClient('C:\\fake\\servy-cli.exe');
        await expect(
            client.install({
                name: 'WsScrcpyWeb',
                displayName: 'ws-scrcpy-web',
                description: 'desc',
                binPath: 'C:\\app\\node.exe',
                startupDir: 'C:\\app',
                startType: 'Automatic',
                maxRestartAttempts: 3,
                envVars: {},
                logPath: 'C:\\app\\service.log',
            }),
        ).resolves.toBeUndefined();
        // Both calls were attempted.
        expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    });

    it('uninstall calls reg.exe delete with correct argv', async () => {
        const client = new ServyClient('servy.exe');
        await client.uninstall('WsScrcpyWeb');

        // Two execFileSync calls: servy uninstall + reg.exe delete.
        expect(execFileSyncMock).toHaveBeenCalledTimes(2);
        const [, regCall] = execFileSyncMock.mock.calls;
        expect(regCall[0]).toBe('reg.exe');
        expect(regCall[1]).toEqual([
            'delete',
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
            '/v', 'WsScrcpyWebTray',
            '/f',
        ]);
    });

    it('uninstall tolerates "cannot find" error from reg.exe delete', async () => {
        // First call (servy uninstall) succeeds; second call (reg delete) throws "cannot find".
        execFileSyncMock
            .mockImplementationOnce(() => '')
            .mockImplementationOnce(() => {
                const err = new Error('reg.exe failed') as NodeJS.ErrnoException & {
                    stderr: string;
                };
                err.stderr = 'ERROR: The system was unable to find the specified registry key or value.';
                throw err;
            });
        const client = new ServyClient('servy.exe');
        await expect(client.uninstall('WsScrcpyWeb')).resolves.toBeUndefined();
        expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    });

    it('uninstall logs warning but succeeds when reg.exe delete throws a non-tolerable error', async () => {
        execFileSyncMock
            .mockImplementationOnce(() => '')
            .mockImplementationOnce(() => {
                const err = new Error('reg.exe failed') as NodeJS.ErrnoException & {
                    stderr: string;
                };
                err.stderr = 'ERROR: Access is denied.';
                throw err;
            });
        const client = new ServyClient('servy.exe');
        // Should NOT reject — uninstall swallows non-tolerable Run-key errors and logs.
        await expect(client.uninstall('WsScrcpyWeb')).resolves.toBeUndefined();
        expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    });

    it('install surfaces stderr when execFileSync throws', async () => {
        execFileSyncMock.mockImplementation(() => {
            const err = new Error('non-zero exit') as NodeJS.ErrnoException & {
                stderr: string;
            };
            err.stderr = 'Service already exists';
            throw err;
        });
        const client = new ServyClient('servy.exe');
        await expect(
            client.install({
                name: 'X',
                displayName: 'X',
                description: 'd',
                binPath: 'b',
                startupDir: 'd',
                startType: 'Automatic',
                maxRestartAttempts: 1,
                envVars: {},
                logPath: 'l',
            }),
        ).rejects.toThrow(/Service already exists/);
    });
});

describe('parseServyStatus (Servy 8.2 single-service status)', () => {
    // Real Servy 8.2 output format, captured live during v0.1.5 testing:
    //   `Service status for 'WsScrcpyWeb': Running`
    it('parses Running', () => {
        expect(parseServyStatus("Service status for 'WsScrcpyWeb': Running")).toBe('running');
    });

    it('treats Stopped as stopped', () => {
        expect(parseServyStatus("Service status for 'WsScrcpyWeb': Stopped")).toBe('stopped');
    });

    it('treats StartPending as stopped (transient state collapsed for our 3-state UI)', () => {
        expect(parseServyStatus("Service status for 'WsScrcpyWeb': StartPending")).toBe('stopped');
    });

    it('treats StopPending as stopped', () => {
        expect(parseServyStatus("Service status for 'WsScrcpyWeb': StopPending")).toBe('stopped');
    });

    it('treats Paused as stopped', () => {
        expect(parseServyStatus("Service status for 'WsScrcpyWeb': Paused")).toBe('stopped');
    });

    it('handles trailing whitespace and CRLF', () => {
        expect(parseServyStatus("Service status for 'WsScrcpyWeb': Running\r\n")).toBe('running');
    });

    it('returns stopped when output does not match the expected format', () => {
        // Conservative fallback — if Servy ever changes its output format we
        // surface "stopped" rather than guessing wrong.
        expect(parseServyStatus('something completely different')).toBe('stopped');
    });
});

describe('isServyNotInstalledError', () => {
    it('matches "service not found"', () => {
        expect(isServyNotInstalledError('servy-cli status failed: Service not found')).toBe(true);
    });

    it('matches "service does not exist"', () => {
        expect(isServyNotInstalledError("Service 'WsScrcpyWeb' does not exist")).toBe(true);
    });

    it('matches "not installed"', () => {
        expect(isServyNotInstalledError('Service is not installed')).toBe(true);
    });

    it('does not match unrelated errors (so they bubble up)', () => {
        expect(isServyNotInstalledError('Access is denied')).toBe(false);
        expect(isServyNotInstalledError('servy-cli not found on PATH')).toBe(false);
        expect(isServyNotInstalledError('')).toBe(false);
    });
});
