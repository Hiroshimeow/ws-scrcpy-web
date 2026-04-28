import '../style/app.css';
import '../style/dependencies.css';
import '../style/first-run-banner.css';
import '../style/home.css';
import { DependencyPanel } from './client/DependencyPanel';
import { FirstRunBanner } from './client/FirstRunBanner';
import { HostTracker } from './client/HostTracker';
import { NetworkDiscoveryPanel } from './client/NetworkDiscoveryPanel';
import { createSettingsHeader } from './client/SettingsHeader';
import { createThemeToggle, initTheme } from './client/ThemeToggle';
import { createUpdateButton } from './client/UpdateButton';
import type { Tool } from './client/Tool';
import { WelcomeModal } from './client/WelcomeModal';
import type { AppConfigEnvelope } from '../common/ConfigEvents';
import { StreamClientScrcpy } from './googDevice/client/StreamClientScrcpy';

function maybeResumeUninstall(): void {
    const params = new URLSearchParams(location.search);
    if (params.get('resume') !== 'uninstall-service') return;
    const token = params.get('token') ?? '';
    if (!token) return;

    // Strip the resume params from the URL bar so a refresh doesn't
    // re-fire the action (the server-side token is single-use, but
    // the visual URL would still be confusing).
    const cleanUrl = `${location.origin}${location.pathname}${location.hash}`;
    history.replaceState(null, '', cleanUrl);

    // Show a status overlay while the uninstall runs.
    const overlay = document.createElement('div');
    overlay.style.cssText =
        'position:fixed;inset:0;background:rgba(0,0,0,0.85);color:#fff;' +
        'display:flex;align-items:center;justify-content:center;z-index:99999;' +
        'font-family:system-ui,sans-serif;font-size:1.1rem;padding:2rem;text-align:center;';
    overlay.textContent = 'finishing service uninstall…';
    document.body.appendChild(overlay);

    fetch('/api/service/uninstall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Resume-Token': token },
    })
        .then(async (r) => {
            const data = (await r.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
            if (!r.ok || !data?.ok) {
                overlay.textContent = `uninstall failed: ${data?.error ?? `HTTP ${r.status}`}`;
                setTimeout(() => overlay.remove(), 4000);
                return;
            }
            overlay.textContent = 'service uninstalled. you can now use ws-scrcpy-web in user mode.';
            setTimeout(() => overlay.remove(), 2000);
        })
        .catch((err) => {
            overlay.textContent = `uninstall failed: ${(err as Error).message}`;
            setTimeout(() => overlay.remove(), 4000);
        });
}

function maybeShowWelcomeModal(): void {
    fetch('/api/config')
        .then((r) => (r.ok ? (r.json() as Promise<Partial<AppConfigEnvelope>>) : null))
        .then((data) => {
            const runtime = data?.runtime;
            if (!runtime || runtime.firstRunComplete !== false) return;
            new WelcomeModal({
                webPort: runtime.webPort,
                portWasAutoShifted: runtime.portWasAutoShifted,
                onDecision: () => {
                    // WelcomeModal owns persistence (install or PATCH) for P3+.
                    // Caller may use this to refresh UI state if needed.
                },
            });
        })
        .catch(() => {
            // /api/config absent (e.g., dev server without P2 wiring) — silently bail.
        });
}

// Initialize theme immediately to prevent flash of wrong colors
initTheme();

window.onload = async (): Promise<void> => {
    const hash = location.hash.replace(/^#!/, '');
    const parsedQuery = new URLSearchParams(hash);
    const action = parsedQuery.get('action');

    // WebCodecs player must be registered so ConnectModal can find it
    const { WebCodecsPlayer } = await import('./player/WebCodecsPlayer');
    StreamClientScrcpy.registerPlayer(WebCodecsPlayer);

    const tools: Tool[] = [];

    const { ShellClient } = await import('./googDevice/client/ShellClient');
    if (action === ShellClient.ACTION && typeof parsedQuery.get('udid') === 'string') {
        ShellClient.start(ShellClient.parseParameters(parsedQuery));
        return;
    }
    tools.push(ShellClient);

    const { FileListingClient } = await import('./googDevice/client/FileListingClient');
    if (action === FileListingClient.ACTION) {
        FileListingClient.start(FileListingClient.parseParameters(parsedQuery));
        return;
    }
    tools.push(FileListingClient);

    if (tools.length) {
        const { DeviceTracker } = await import('./googDevice/client/DeviceTracker');
        tools.forEach((tool) => {
            DeviceTracker.registerTool(tool);
        });
    }

    document.body.appendChild(createSettingsHeader());
    document.body.appendChild(createThemeToggle());
    document.body.appendChild(createUpdateButton());

    const pageContainer = document.createElement('div');
    pageContainer.className = 'page-container';
    document.body.appendChild(pageContainer);

    FirstRunBanner.create().then((banner) => {
        pageContainer.insertBefore(banner.getElement(), pageContainer.firstChild);
    });

    maybeShowWelcomeModal();

    // v0.1.8 uninstall handoff: if we arrived with
    // ?resume=uninstall-service&token=..., the previous (service)
    // instance is asking us to auto-fire the uninstall. Validate the
    // token server-side via the existing uninstall endpoint
    // (server consumes the token; the API call only succeeds if it
    // matches a recently-issued one). On success, the user is
    // dropped on a clean home page.
    maybeResumeUninstall();

    const devicesDiv = document.createElement('div');
    devicesDiv.id = 'devices';
    devicesDiv.className = 'table-wrapper';
    pageContainer.appendChild(devicesDiv);

    const discoveryPanel = new NetworkDiscoveryPanel();
    pageContainer.appendChild(discoveryPanel.getElement());

    DependencyPanel.create().then((depPanel) => {
        pageContainer.appendChild(depPanel.getElement());
    });

    HostTracker.start();
};
