// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import type { IncomingMessage, ServerResponse } from 'http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { InstallMode } from '../../common/ConfigEvents';
import {
    WS_SCRCPY_SERVICE_DESCRIPTION,
    WS_SCRCPY_SERVICE_DISPLAY_NAME,
    WS_SCRCPY_SERVICE_NAME,
    type ServiceActionFailure,
    type ServiceActionSuccess,
    type ServiceInstallRequest,
    type ServiceStatusResponse,
} from '../../common/ServiceEvents';
import { Config } from '../Config';
import { detectInstallScope } from '../InstallScope';
import { Logger } from '../Logger';
import { ServiceInstallError } from '../service/ServyClient';
import {
    getServiceClient,
    type ServiceClientFactoryResult,
} from '../service';
import { readJsonBody } from './utils';

const log = Logger.for('ServiceApi');

/**
 * HTTP API for SP3 P3 service-mode operations.
 *
 *   GET  /api/service/status     -> ServiceStatusResponse (always 200)
 *   POST /api/service/install    -> ServiceActionSuccess | 501/500 ServiceActionFailure
 *   POST /api/service/uninstall  -> ServiceActionSuccess | 501/500 ServiceActionFailure
 *
 * All non-error responses use HTTP 200; "service mode unsupported on this
 * platform" is communicated through the body's `supported`/`ok` flag, not the
 * status code, because it's a normal first-class state for non-Windows hosts.
 *
 * `ServiceApi` is wired as an `addApiHandler` consumer in src/server/index.ts
 * alongside the P2 ConfigApi.
 */
export class ServiceApi {
    /**
     * Optional override of the factory and install-scope detector — wired in
     * for unit tests so we don't need to vi.mock the entire service module.
     * Production callers omit both args and the API uses the real factory +
     * `detectInstallScope()`.
     */
    constructor(
        private readonly factory: () => ServiceClientFactoryResult = () => getServiceClient(),
        private readonly scope: () => 'user' | 'system' = () => detectInstallScope(),
        private readonly existsCheck: (p: string) => boolean = (p: string) => fs.existsSync(p),
    ) {}

    public async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const url = req.url || '';
        if (!url.startsWith('/api/service/')) return false;

        res.setHeader('Content-Type', 'application/json');

        try {
            if (req.method === 'GET' && url === '/api/service/status') {
                return await this.handleStatus(res);
            }
            if (req.method === 'POST' && url === '/api/service/install') {
                return await this.handleInstall(req, res);
            }
            if (req.method === 'POST' && url === '/api/service/uninstall') {
                return await this.handleUninstall(res);
            }

            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Not found' }));
            return true;
        } catch (err) {
            log.error(`${req.method} ${req.url} threw: ${(err as Error)?.message ?? String(err)}`);
            const body: ServiceActionFailure = { ok: false, error: (err as Error).message };
            res.writeHead(500);
            res.end(JSON.stringify(body));
            return true;
        }
    }

    private async handleStatus(res: ServerResponse): Promise<boolean> {
        const result = this.factory();
        if (!result.supported) {
            const body: ServiceStatusResponse = {
                supported: false,
                platform: result.platform,
                unsupportedReason: result.unsupportedReason,
            };
            res.writeHead(200);
            res.end(JSON.stringify(body));
            return true;
        }
        const status = await result.client.status(WS_SCRCPY_SERVICE_NAME);
        const body: ServiceStatusResponse = {
            supported: true,
            platform: result.platform,
            status,
        };
        res.writeHead(200);
        res.end(JSON.stringify(body));
        return true;
    }

    private async handleInstall(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const result = this.factory();
        if (!result.supported) {
            const body: ServiceActionFailure = {
                ok: false,
                error: result.unsupportedReason ?? 'Service mode unsupported on this platform',
            };
            res.writeHead(501);
            res.end(JSON.stringify(body));
            return true;
        }

        const cfg = Config.getInstance();

        // Scope resolution differs by platform:
        //   - Windows: ignore the request body, use the injected scope detector
        //     (auto-detects from execPath via detectInstallScope()).
        //   - Linux:   read `scope` from the request body, default to 'user'
        //     when absent. If the caller asked for system scope but we're not
        //     root, return 403 BEFORE invoking the client — SystemdClient also
        //     guards this, but doing it at the API boundary lets us return a
        //     clean HTTP error code.
        let scope: 'user' | 'system';
        if (result.platform === 'linux') {
            const body = await readJsonBody(req);
            const requested = (body as ServiceInstallRequest).scope;
            scope = requested === 'system' ? 'system' : 'user';

            if (scope === 'system' && process.getuid?.() !== 0) {
                const failure: ServiceActionFailure = {
                    ok: false,
                    error:
                        'system scope requires root. Relaunch the AppImage with sudo, ' +
                        'or pick user scope.',
                };
                res.writeHead(403);
                res.end(JSON.stringify(failure));
                return true;
            }
        } else {
            scope = this.scope();
        }

        // Windows ServyClient ignores scope and always installs as Local System
        // (no `--user` flag). Linux SystemdClient consumes scope to decide
        // user-systemd vs system-systemd unit placement.
        const newInstallMode: InstallMode = scope === 'user' ? 'user-service' : 'system-service';

        // v0.1.7: the v0.1.6 admin-elevation guard at this boundary is
        // gone. ServyClient's install() now invokes a separate elevated
        // helper process (via PowerShell Start-Process -Verb RunAs); the
        // UAC prompt happens at that elevation step, not here. This API
        // remains unelevated.
        //
        // Resolve the service binary. On Windows we point Servy at the
        // packaged launcher, NOT process.execPath. process.execPath is the
        // currently-running Node binary, which (a) in dev resolves to
        // whatever Node is on PATH (same architectural failure as the
        // v0.1.4 bare-'adb' bug), and (b) even when bundled, Servy would
        // launch Node with no script argument and Node would idle in REPL
        // mode. The launcher is a local-deps binary in the install root,
        // takes no args, and already knows how to supervise Node +
        // dist/index.js — exactly what we want SCM to invoke.
        //
        // startupDir pins the SCM-launched child's CWD to the install
        // root so the launcher's relative seed/, dependencies/, dist/
        // resolution works. Without it, Servy falls back to the dir of
        // the executable and the launcher's path resolution silently
        // breaks (root of the v0.1.5 "service runs but app unreachable"
        // bug — Servy log showed "Working directory fallback applied:
        // C:\nvm4w\nodejs").
        let binPath: string;
        let startupDir: string;
        if (result.platform === 'win32') {
            const installRoot = process.cwd();
            const launcherExe = path.join(installRoot, 'ws-scrcpy-web-launcher.exe');
            if (!this.existsCheck(launcherExe)) {
                const failure: ServiceActionFailure = {
                    ok: false,
                    error:
                        `service mode requires the packaged launcher binary at ${launcherExe}, ` +
                        `which is not present (likely a dev/from-source run rather than a Velopack install). ` +
                        `Install ws-scrcpy-web via Setup.exe and retry.`,
                };
                res.writeHead(500);
                res.end(JSON.stringify(failure));
                return true;
            }
            binPath = launcherExe;
            startupDir = installRoot;
        } else {
            // Linux: SystemdClient takes the launcher binary directly via
            // process.execPath (the AppImage entrypoint). Working directory
            // is the launcher's parent dir.
            binPath = process.execPath;
            startupDir = path.dirname(process.execPath);
        }

        const logPath = path.join(cfg.dependenciesPath, 'service.log');
        const envVars: Record<string, string> = {
            DEPS_PATH: cfg.dependenciesPath,
        };

        try {
            await result.client.install({
                name: WS_SCRCPY_SERVICE_NAME,
                displayName: WS_SCRCPY_SERVICE_DISPLAY_NAME,
                description: WS_SCRCPY_SERVICE_DESCRIPTION,
                binPath,
                startupDir,
                startType: 'Automatic',
                maxRestartAttempts: 3,
                envVars,
                logPath,
                // Linux SystemdClient consumes scope; Windows ServyClient ignores it.
                scope,
            });
        } catch (err) {
            // ServiceInstallError carries a structured result from the
            // elevated helper. UAC-declined gets its own 403 status so
            // the frontend can render a UAC-aware retry prompt; other
            // failures get 500.
            if (err instanceof ServiceInstallError && err.isUacDeclined()) {
                const body: ServiceActionFailure = { ok: false, error: err.message };
                res.writeHead(403);
                res.end(JSON.stringify(body));
                return true;
            }
            const body: ServiceActionFailure = { ok: false, error: (err as Error).message };
            res.writeHead(500);
            res.end(JSON.stringify(body));
            return true;
        }

        // Persist the new install mode so subsequent boots / UI loads agree.
        try {
            cfg.updateAppConfig({ installMode: newInstallMode });
        } catch (err) {
            log.warn(`installMode persist failed (service install succeeded): ${(err as Error).message}`);
        }

        const status = await result.client.status(WS_SCRCPY_SERVICE_NAME);
        const body: ServiceActionSuccess = {
            ok: true,
            status,
            installMode: newInstallMode,
        };
        res.writeHead(200);
        res.end(JSON.stringify(body));
        return true;
    }

    private async handleUninstall(res: ServerResponse): Promise<boolean> {
        const result = this.factory();
        if (!result.supported) {
            const body: ServiceActionFailure = {
                ok: false,
                error: result.unsupportedReason ?? 'Service mode unsupported on this platform',
            };
            res.writeHead(501);
            res.end(JSON.stringify(body));
            return true;
        }

        // v0.1.7: the elevated helper does stop+uninstall in one
        // elevated process, so we don't pre-stop here anymore. (Calling
        // ServyClient.stop separately would also throw "not yet wired
        // through the elevation helper" — the welcome modal flow goes
        // through uninstall directly.)
        try {
            await result.client.uninstall(WS_SCRCPY_SERVICE_NAME);
        } catch (err) {
            if (err instanceof ServiceInstallError && err.isUacDeclined()) {
                const body: ServiceActionFailure = { ok: false, error: err.message };
                res.writeHead(403);
                res.end(JSON.stringify(body));
                return true;
            }
            const body: ServiceActionFailure = { ok: false, error: (err as Error).message };
            res.writeHead(500);
            res.end(JSON.stringify(body));
            return true;
        }

        // Revert installMode: drop the '-service' suffix.
        const cfg = Config.getInstance();
        const current = cfg.getAppConfig().installMode;
        let newMode: InstallMode = 'user';
        if (current === 'system-service' || current === 'system') newMode = 'system';
        try {
            cfg.updateAppConfig({ installMode: newMode });
        } catch (err) {
            log.warn(`installMode revert failed (service uninstall succeeded): ${(err as Error).message}`);
        }

        const status = await result.client.status(WS_SCRCPY_SERVICE_NAME);
        const body: ServiceActionSuccess = {
            ok: true,
            status,
            installMode: newMode,
        };
        res.writeHead(200);
        res.end(JSON.stringify(body));
        return true;
    }
}
