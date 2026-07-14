// src/app/client/NetworkDiscoveryPanel.ts

import { SCAN_WS_PATH, type ScanServerMessage } from '../../common/ScanMessage';
import { ScanNetworkModal } from './ScanNetworkModal';
import { ScanProgressChip } from './ScanProgressChip';

interface ConnectResult {
    success: boolean;
    message: string;
}

interface PairResult extends ConnectResult {
    phase: 'validation' | 'pair' | 'connect' | 'complete';
    address?: string;
}

type QrPairingMode = 'lan' | 'tailscale';

interface QrPairingStatus {
    id: string;
    state: 'waiting' | 'scanning' | 'pairing' | 'connecting' | 'complete' | 'failed' | 'expired' | 'cancelled';
    mode: QrPairingMode;
    message: string;
    expiresAt: number;
    host?: string;
    address?: string;
}

interface StartedQrPairing extends QrPairingStatus {
    qrSvg: string;
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

export class NetworkDiscoveryPanel {
    private container: HTMLElement;
    private infoBox: HTMLElement;
    private resultsContainer: HTMLElement;
    private chip?: ScanProgressChip | undefined;
    private scanWs?: WebSocket | undefined;
    private scanSessionHits = new Map<string, HTMLElement>();
    private defaultInfoText = '';
    private qrSessionId: string | undefined;
    private qrPollTimer: number | undefined;
    private qrRequestVersion = 0;
    private qrMode: QrPairingMode = 'lan';

    constructor() {
        this.container = document.createElement('div');
        this.container.id = 'discovery-panel';
        this.container.className = 'home-section';
        this.container.innerHTML = `
            <div class="discovery-header">
                <h2>Available Network Devices</h2>
                <div class="discovery-header-actions">
                    <button class="dep-btn discovery-quick-scan-btn" title="mDNS-only — finds modern Android devices with wireless debugging enabled">quick scan</button>
                    <button class="dep-btn discovery-scan-btn">scan network</button>
                    <button class="dep-btn discovery-qr-pair-btn">pair with QR</button>
                    <button class="dep-btn discovery-pair-btn">pair via Tailscale</button>
                    <button class="dep-btn discovery-manual-btn">manually add</button>
                </div>
            </div>
            <div class="discovery-qr-pair-form" hidden>
                <button class="discovery-qr-close" aria-label="close" title="close">×</button>
                <div class="discovery-qr-guide">
                    <div class="discovery-qr-mode" role="group" aria-label="QR pairing network">
                        <button class="dep-btn discovery-qr-mode-lan active" type="button">same Wi-Fi</button>
                        <button class="dep-btn discovery-qr-mode-tailscale" type="button">Tailscale</button>
                    </div>
                    <strong class="discovery-qr-guide-title">Pair Android over the same Wi-Fi</strong>
                    <ol>
                        <li class="discovery-qr-step-one">On Android, open Developer options → Wireless debugging.</li>
                        <li class="discovery-qr-step-two">Tap “Pair device with QR code”.</li>
                        <li class="discovery-qr-step-three">Scan this code. Pairing continues automatically.</li>
                    </ol>
                    <div class="discovery-qr-lan-note">Windows and Android must be on the same Wi-Fi/LAN for QR discovery.</div>
                    <div class="discovery-qr-tailscale-target" hidden>
                        <input type="text" class="discovery-qr-tailscale-host" placeholder="Android Tailscale IP (100.x.y.z) or full .ts.net name" autocomplete="off" />
                        <button class="dep-btn discovery-qr-generate" type="button">generate Tailscale QR</button>
                        <small>Only a Tailscale 100.64.0.0/10 address or full MagicDNS .ts.net hostname is accepted.</small>
                    </div>
                </div>
                <div class="discovery-qr-code" aria-label="ADB wireless debugging QR code"></div>
                <div class="discovery-qr-status" role="status">Generating secure QR code…</div>
            </div>
            <div class="discovery-pair-form" hidden>
                <div class="discovery-pair-help">
                    Android: open Tailscale for the 100.x address, then Developer options → Wireless debugging.
                    Use “Pair device with pairing code” for the pairing port/code, and the main Wireless debugging screen for the connection port.
                </div>
                <input type="text" class="discovery-pair-host" placeholder="Android Tailscale IP (100.x.y.z)" autocomplete="off" />
                <input type="text" class="discovery-pair-port" placeholder="pair port" inputmode="numeric" autocomplete="off" />
                <input type="password" class="discovery-pair-code" placeholder="6-digit code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" />
                <input type="text" class="discovery-connect-port" placeholder="connect port" inputmode="numeric" autocomplete="off" />
                <input type="text" class="discovery-pair-label" placeholder="optional name" />
                <button class="dep-btn discovery-connect-btn discovery-pair-connect">pair &amp; connect</button>
                <button class="discovery-pair-close" aria-label="close" title="close">×</button>
                <div class="discovery-pair-result" hidden></div>
            </div>
            <div class="discovery-manual-form" hidden>
                <input type="text" class="discovery-manual-address" placeholder="192.168.86.50" />
                <input type="text" class="discovery-manual-port" placeholder="5555" value="5555" />
                <input type="text" class="discovery-manual-label" placeholder="optional name" />
                <button class="dep-btn discovery-connect-btn discovery-manual-connect">connect</button>
                <button class="discovery-manual-close" aria-label="close" title="close">×</button>
                <div class="discovery-manual-result" hidden></div>
            </div>
            <div class="discovery-results"></div>
            <div class="empty-state-card discovery-info">Click quick scan for modern Android devices on your network, or scan network to probe a full subnet. Make sure wireless debugging is enabled on the devices you wish to connect with.</div>
        `;
        this.infoBox = this.container.querySelector('.discovery-info')!;
        this.defaultInfoText = this.infoBox.textContent ?? '';
        this.resultsContainer = this.container.querySelector('.discovery-results')!;
        this.container.querySelector('.discovery-scan-btn')!.addEventListener('click', () => this.scan());
        this.container.querySelector('.discovery-quick-scan-btn')!.addEventListener('click', () => this.quickScan());
        this.container
            .querySelector('.discovery-qr-pair-btn')!
            .addEventListener('click', () => this.toggleQrPairForm());
        this.container.querySelector('.discovery-pair-btn')!.addEventListener('click', () => this.togglePairForm());
        this.container.querySelector('.discovery-manual-btn')!.addEventListener('click', () => this.toggleManualForm());
        this.container
            .querySelector('.discovery-qr-close')!
            .addEventListener('click', () => this.toggleQrPairForm(false));
        this.container
            .querySelector('.discovery-qr-mode-lan')!
            .addEventListener('click', () => this.selectQrMode('lan'));
        this.container
            .querySelector('.discovery-qr-mode-tailscale')!
            .addEventListener('click', () => this.selectQrMode('tailscale'));
        this.container
            .querySelector('.discovery-qr-generate')!
            .addEventListener('click', () => void this.startQrPairing());
        (this.container.querySelector('.discovery-qr-tailscale-host') as HTMLInputElement).addEventListener(
            'keydown',
            (event) => {
                if ((event as KeyboardEvent).key === 'Enter') void this.startQrPairing();
            },
        );
        this.container
            .querySelector('.discovery-pair-close')!
            .addEventListener('click', () => this.togglePairForm(false));
        this.container.querySelector('.discovery-pair-connect')!.addEventListener('click', () => this.pairAndConnect());
        this.container
            .querySelector('.discovery-manual-close')!
            .addEventListener('click', () => this.toggleManualForm(false));
        this.container
            .querySelector('.discovery-manual-connect')!
            .addEventListener('click', () => this.manualConnect());
        for (const selector of [
            '.discovery-pair-host',
            '.discovery-pair-port',
            '.discovery-pair-code',
            '.discovery-connect-port',
            '.discovery-pair-label',
        ]) {
            const input = this.container.querySelector(selector) as HTMLInputElement;
            input.addEventListener('keydown', (e) => {
                if ((e as KeyboardEvent).key === 'Enter') this.pairAndConnect();
            });
        }
        for (const selector of ['.discovery-manual-address', '.discovery-manual-port', '.discovery-manual-label']) {
            const input = this.container.querySelector(selector) as HTMLInputElement;
            input.addEventListener('keydown', (e) => {
                if ((e as KeyboardEvent).key === 'Enter') this.manualConnect();
            });
        }
    }

    getElement(): HTMLElement {
        return this.container;
    }

    private setInfoText(text: string, error = false): void {
        this.infoBox.textContent = text;
        this.infoBox.style.color = error ? '#f87171' : '';
    }

    private restoreInfoText(): void {
        // If a scan error already swapped in error text, don't overwrite it on chip dismiss.
        if (this.infoBox.style.color === 'rgb(248, 113, 113)') return;
        this.infoBox.textContent = this.defaultInfoText;
        this.infoBox.style.color = '';
    }

    private async scan(): Promise<void> {
        // Fetch detected gateway subnet first
        let gateway: { cidr: string; hostCount: number } | null = null;
        try {
            const res = await fetch('/api/devices/scan/subnet');
            const detected = await res.json();
            if (detected?.cidr) {
                gateway = { cidr: detected.cidr, hostCount: detected.hostCount };
            }
        } catch {
            gateway = null;
        }

        new ScanNetworkModal({
            gatewaySubnet: gateway,
            onStartScan: (rawSubnets: string[]) => this.startScanWs(rawSubnets),
        });
    }

    private quickScan(): void {
        this.startScanWs([], { mdnsOnly: true });
    }

    private startScanWs(rawSubnets: string[], options: { mdnsOnly?: boolean } = {}): void {
        const mdnsOnly = options.mdnsOnly === true;

        // Clear the panel before a new scan (matches existing behavior)
        this.resultsContainer.innerHTML = '';
        this.scanSessionHits.clear();
        const grid = document.createElement('div');
        grid.className = 'discovery-grid';
        this.resultsContainer.appendChild(grid);

        // Full scan mounts the progress chip into the info box; quick scan uses lightweight inline status.
        this.chip?.dismiss();
        this.chip = undefined;
        this.infoBox.textContent = '';
        this.infoBox.style.color = '';
        if (mdnsOnly) {
            this.infoBox.textContent = 'scanning over mDNS…';
        } else {
            this.chip = new ScanProgressChip({
                parent: this.infoBox,
                onCancel: () => {
                    if (this.scanWs?.readyState === WebSocket.OPEN) {
                        this.scanWs.send(JSON.stringify({ type: 'scan.cancel' }));
                    }
                },
                onDismiss: () => this.restoreInfoText(),
            });
        }

        // Open the WS
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${proto}//${location.host}${SCAN_WS_PATH}`);
        this.scanWs = ws;

        ws.addEventListener('open', () => {
            const startMsg: { type: 'scan.start'; subnets: string[]; mdnsOnly?: boolean } = {
                type: 'scan.start',
                subnets: rawSubnets,
            };
            if (mdnsOnly) startMsg.mdnsOnly = true;
            ws.send(JSON.stringify(startMsg));
        });
        let terminalReceived = false;
        ws.addEventListener('message', (ev: MessageEvent) => {
            const msg: ScanServerMessage = JSON.parse(ev.data);
            if (msg.type === 'scan.complete' || msg.type === 'scan.cancelled' || msg.type === 'scan.error') {
                terminalReceived = true;
            }
            this.handleScanMessage(msg, grid, mdnsOnly);
        });
        ws.addEventListener('close', () => {
            this.scanWs = undefined;
            if (!terminalReceived) {
                this.setInfoText('Scan connection lost before completion.', true);
                this.chip?.dismiss();
            }
        });
        ws.addEventListener('error', () => {
            this.setInfoText('Scan connection failed.', true);
            this.chip?.dismiss();
        });
    }

    private handleScanMessage(msg: ScanServerMessage, grid: HTMLElement, mdnsOnly = false): void {
        switch (msg.type) {
            case 'scan.started':
                this.chip?.setScanning(0, msg.totalHosts, 0);
                break;
            case 'scan.progress':
                this.chip?.setScanning(msg.checked, msg.total, msg.foundSoFar);
                break;
            case 'scan.hit':
                this.renderHit(msg, grid);
                break;
            case 'scan.draining':
                this.chip?.setDraining();
                break;
            case 'scan.complete':
                if (mdnsOnly) {
                    if (msg.found === 0) {
                        this.setInfoText('No devices advertising over mDNS. Try scan network for a full subnet probe.');
                    } else {
                        this.restoreInfoText();
                    }
                } else {
                    this.chip?.setComplete(msg.found);
                }
                break;
            case 'scan.cancelled':
                this.chip?.setCancelled(msg.found);
                break;
            case 'scan.error':
                this.setInfoText(`Scan error: ${msg.reason}`, true);
                this.chip?.dismiss();
                break;
        }
    }

    private renderHit(hit: { address: string; serial: string; name: string; label: string }, grid: HTMLElement): void {
        if (this.scanSessionHits.has(hit.address)) return;
        const card = document.createElement('div');
        card.className = 'discovery-card';
        // Top line shows hit.name (adb-SERIAL for mDNS, model for TCP).
        // Empty name hides the top line via CSS .discovery-card-name:empty.
        const displayName = hit.name || '';
        card.innerHTML = `
            <div class="discovery-card-info">
                <div class="discovery-card-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</div>
                <div class="discovery-card-address" title="${escapeHtml(hit.address)}">${escapeHtml(hit.address)}</div>
            </div>
            <div class="discovery-card-actions">
                <input type="text" class="discovery-name-input" placeholder="Name this device..." value="${escapeHtml(hit.label || '')}" />
                <button class="dep-btn discovery-connect-btn" data-address="${escapeHtml(hit.address)}" data-serial="${escapeHtml(hit.serial)}">connect</button>
                <button class="dep-btn discovery-dismiss-btn" aria-label="dismiss" title="dismiss">close</button>
            </div>
            <div class="discovery-card-result" hidden></div>
        `;
        card.querySelector('.discovery-connect-btn')!.addEventListener('click', () =>
            this.connectDevice(hit.address, hit.serial, card),
        );
        card.querySelector('.discovery-dismiss-btn')!.addEventListener('click', () => {
            this.scanSessionHits.delete(hit.address);
            card.remove();
        });
        grid.appendChild(card);
        this.scanSessionHits.set(hit.address, card);
    }

    private toggleQrPairForm(show?: boolean): void {
        const form = this.container.querySelector('.discovery-qr-pair-form') as HTMLElement;
        const shouldShow = show !== undefined ? show : form.hasAttribute('hidden');
        if (shouldShow) {
            this.togglePairForm(false);
            this.toggleManualForm(false);
            form.removeAttribute('hidden');
            this.applyQrModeUi();
            if (this.qrMode === 'lan') {
                void this.startQrPairing();
            } else {
                this.showQrStatus('Enter the Android Tailscale IP, then generate a QR code.');
                (this.container.querySelector('.discovery-qr-tailscale-host') as HTMLInputElement).focus();
            }
        } else {
            form.setAttribute('hidden', '');
            this.stopQrPairing(true);
            (this.container.querySelector('.discovery-qr-code') as HTMLElement).innerHTML = '';
            this.showQrStatus('Generating secure QR code…');
        }
    }

    private selectQrMode(mode: QrPairingMode): void {
        if (this.qrMode === mode) return;
        this.qrMode = mode;
        this.stopQrPairing(true);
        (this.container.querySelector('.discovery-qr-code') as HTMLElement).innerHTML = '';
        this.applyQrModeUi();

        const form = this.container.querySelector('.discovery-qr-pair-form') as HTMLElement;
        if (form.hasAttribute('hidden')) return;
        if (mode === 'lan') {
            void this.startQrPairing();
        } else {
            this.showQrStatus('Enter the Android Tailscale IP, then generate a QR code.');
            (this.container.querySelector('.discovery-qr-tailscale-host') as HTMLInputElement).focus();
        }
    }

    private applyQrModeUi(): void {
        const tailscale = this.qrMode === 'tailscale';
        const lanBtn = this.container.querySelector('.discovery-qr-mode-lan') as HTMLButtonElement;
        const tailscaleBtn = this.container.querySelector('.discovery-qr-mode-tailscale') as HTMLButtonElement;
        lanBtn.classList.toggle('active', !tailscale);
        tailscaleBtn.classList.toggle('active', tailscale);
        lanBtn.setAttribute('aria-pressed', String(!tailscale));
        tailscaleBtn.setAttribute('aria-pressed', String(tailscale));

        const target = this.container.querySelector('.discovery-qr-tailscale-target') as HTMLElement;
        target.toggleAttribute('hidden', !tailscale);
        (this.container.querySelector('.discovery-qr-guide-title') as HTMLElement).textContent = tailscale
            ? 'Pair Android over Tailscale'
            : 'Pair Android over the same Wi-Fi';
        (this.container.querySelector('.discovery-qr-step-one') as HTMLElement).textContent = tailscale
            ? 'Keep Tailscale connected on both Windows and Android.'
            : 'On Android, open Developer options → Wireless debugging.';
        (this.container.querySelector('.discovery-qr-step-two') as HTMLElement).textContent = tailscale
            ? 'On Android, open Wireless debugging → Pair device with QR code.'
            : 'Tap “Pair device with QR code”.';
        (this.container.querySelector('.discovery-qr-step-three') as HTMLElement).textContent = tailscale
            ? 'Scan this code. Windows discovers the temporary ADB ports through the tailnet.'
            : 'Scan this code. Pairing continues automatically.';
        (this.container.querySelector('.discovery-qr-lan-note') as HTMLElement).textContent = tailscale
            ? 'No port or 6-digit code is needed. The phone must expose Wireless debugging on its Tailscale interface.'
            : 'Windows and Android must be on the same Wi-Fi/LAN for QR discovery.';
    }

    private async startQrPairing(): Promise<void> {
        const mode = this.qrMode;
        const hostInput = this.container.querySelector('.discovery-qr-tailscale-host') as HTMLInputElement;
        const host = hostInput.value.trim();
        if (mode === 'tailscale' && !host) {
            this.showQrStatus('Android Tailscale IP or full .ts.net hostname is required.', 'error');
            hostInput.focus();
            return;
        }

        this.stopQrPairing(true);
        const version = ++this.qrRequestVersion;
        const qrEl = this.container.querySelector('.discovery-qr-code') as HTMLElement;
        qrEl.innerHTML = '';
        this.showQrStatus(mode === 'tailscale' ? 'Generating Tailscale QR code…' : 'Generating secure QR code…');

        try {
            const requestBody = mode === 'tailscale' ? { mode, host } : { mode };
            const res = await fetch('/api/devices/pair/qr', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
            });
            const result = (await res.json()) as StartedQrPairing & { error?: string };
            if (version !== this.qrRequestVersion) {
                if (result.id) {
                    void fetch(`/api/devices/pair/qr?id=${encodeURIComponent(result.id)}`, { method: 'DELETE' });
                }
                return;
            }
            if (!res.ok || !result.id || !result.qrSvg) {
                this.showQrStatus(result.error || 'Could not create a QR pairing session.', 'error');
                return;
            }

            this.qrSessionId = result.id;
            qrEl.innerHTML = result.qrSvg;
            this.showQrStatus(result.message);
            this.scheduleQrPoll();
        } catch (err: any) {
            if (version === this.qrRequestVersion) {
                this.showQrStatus(err?.message || 'Could not create a QR pairing session.', 'error');
            }
        }
    }

    private scheduleQrPoll(): void {
        if (!this.qrSessionId) return;
        if (this.qrPollTimer !== undefined) window.clearTimeout(this.qrPollTimer);
        this.qrPollTimer = window.setTimeout(() => void this.pollQrPairing(), 1_000);
    }

    private async pollQrPairing(): Promise<void> {
        this.qrPollTimer = undefined;
        const id = this.qrSessionId;
        if (!id) return;

        try {
            const res = await fetch(`/api/devices/pair/qr?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
            const status = (await res.json()) as QrPairingStatus & { error?: string };
            if (this.qrSessionId !== id) return;
            if (!res.ok) {
                this.showQrStatus(status.error || 'QR pairing status is unavailable.', 'error');
                this.qrSessionId = undefined;
                return;
            }

            this.showQrStatus(
                status.message,
                status.state === 'complete'
                    ? 'success'
                    : status.state === 'failed' || status.state === 'expired' || status.state === 'cancelled'
                      ? 'error'
                      : undefined,
            );

            if (status.state === 'complete') {
                this.qrSessionId = undefined;
                if (status.mode === 'tailscale') {
                    const address = status.address || status.host || 'the Tailscale device';
                    this.setInfoText(`Android connected over Tailscale at ${address}.`);
                } else {
                    this.quickScan();
                }
                return;
            }
            if (status.state === 'failed' || status.state === 'expired' || status.state === 'cancelled') {
                this.qrSessionId = undefined;
                return;
            }
            this.scheduleQrPoll();
        } catch {
            if (this.qrSessionId === id) {
                this.showQrStatus('Connection interrupted. Retrying…');
                this.scheduleQrPoll();
            }
        }
    }

    private stopQrPairing(cancelServer: boolean): void {
        this.qrRequestVersion += 1;
        if (this.qrPollTimer !== undefined) {
            window.clearTimeout(this.qrPollTimer);
            this.qrPollTimer = undefined;
        }
        const id = this.qrSessionId;
        this.qrSessionId = undefined;
        if (cancelServer && id) {
            void fetch(`/api/devices/pair/qr?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
        }
    }

    private showQrStatus(text: string, kind?: 'success' | 'error'): void {
        const status = this.container.querySelector('.discovery-qr-status') as HTMLElement;
        status.textContent = text;
        status.classList.toggle('success', kind === 'success');
        status.classList.toggle('error', kind === 'error');
    }

    private togglePairForm(show?: boolean): void {
        const form = this.container.querySelector('.discovery-pair-form') as HTMLElement;
        const shouldShow = show !== undefined ? show : form.hasAttribute('hidden');
        if (shouldShow) {
            this.toggleQrPairForm(false);
            this.toggleManualForm(false);
            form.removeAttribute('hidden');
            (this.container.querySelector('.discovery-pair-host') as HTMLInputElement).focus();
        } else {
            form.setAttribute('hidden', '');
            this.clearPairForm();
        }
    }

    private clearPairForm(): void {
        for (const selector of [
            '.discovery-pair-host',
            '.discovery-pair-port',
            '.discovery-pair-code',
            '.discovery-connect-port',
            '.discovery-pair-label',
        ]) {
            (this.container.querySelector(selector) as HTMLInputElement).value = '';
        }
        const resultEl = this.container.querySelector('.discovery-pair-result') as HTMLElement;
        resultEl.setAttribute('hidden', '');
        resultEl.textContent = '';
        resultEl.classList.remove('error', 'success');
    }

    private showPairResult(text: string, kind: 'success' | 'error'): void {
        const resultEl = this.container.querySelector('.discovery-pair-result') as HTMLElement;
        resultEl.textContent = text;
        resultEl.classList.toggle('success', kind === 'success');
        resultEl.classList.toggle('error', kind === 'error');
        resultEl.removeAttribute('hidden');
    }

    private async pairAndConnect(): Promise<void> {
        const hostInput = this.container.querySelector('.discovery-pair-host') as HTMLInputElement;
        const pairingPortInput = this.container.querySelector('.discovery-pair-port') as HTMLInputElement;
        const codeInput = this.container.querySelector('.discovery-pair-code') as HTMLInputElement;
        const connectPortInput = this.container.querySelector('.discovery-connect-port') as HTMLInputElement;
        const labelInput = this.container.querySelector('.discovery-pair-label') as HTMLInputElement;
        const btn = this.container.querySelector('.discovery-pair-connect') as HTMLButtonElement;

        const host = hostInput.value.trim();
        const pairingPort = pairingPortInput.value.trim();
        const pairingCode = codeInput.value.trim();
        const connectPort = connectPortInput.value.trim();
        const label = labelInput.value.trim();
        const validPort = (value: string): boolean =>
            /^\d{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65535;

        if (!host) {
            this.showPairResult('Android Tailscale IP is required.', 'error');
            hostInput.focus();
            return;
        }
        if (!validPort(pairingPort)) {
            this.showPairResult('Enter the pairing port shown beside the 6-digit code.', 'error');
            pairingPortInput.focus();
            return;
        }
        if (!/^\d{6}$/.test(pairingCode)) {
            this.showPairResult('Pairing code must be exactly 6 digits.', 'error');
            codeInput.focus();
            return;
        }
        if (!validPort(connectPort)) {
            this.showPairResult('Enter the connection port from the main Wireless debugging screen.', 'error');
            connectPortInput.focus();
            return;
        }

        btn.disabled = true;
        btn.textContent = 'Pairing...';
        codeInput.value = '';
        using _restoreBtn = {
            [Symbol.dispose](): void {
                btn.disabled = false;
                btn.textContent = 'pair & connect';
            },
        };

        try {
            const res = await fetch('/api/devices/pair', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    host,
                    pairingPort,
                    pairingCode,
                    connectPort,
                    label: label || undefined,
                }),
            });
            const result: PairResult = await res.json();
            if (res.ok && result.success) {
                this.showPairResult(result.message || `Connected to ${host}:${connectPort}`, 'success');
                setTimeout(() => this.togglePairForm(false), 2500);
            } else {
                this.showPairResult(result.message || `Failed during ${result.phase || 'pairing'}.`, 'error');
            }
        } catch (err: any) {
            this.showPairResult(err?.message || 'Pairing request failed.', 'error');
        }
    }

    private toggleManualForm(show?: boolean): void {
        const form = this.container.querySelector('.discovery-manual-form') as HTMLElement;
        const shouldShow = show !== undefined ? show : form.hasAttribute('hidden');
        if (shouldShow) {
            this.toggleQrPairForm(false);
            const pairForm = this.container.querySelector('.discovery-pair-form') as HTMLElement;
            pairForm.setAttribute('hidden', '');
            form.removeAttribute('hidden');
            (this.container.querySelector('.discovery-manual-address') as HTMLInputElement).focus();
        } else {
            form.setAttribute('hidden', '');
            this.clearManualForm();
        }
    }

    private clearManualForm(): void {
        (this.container.querySelector('.discovery-manual-address') as HTMLInputElement).value = '';
        (this.container.querySelector('.discovery-manual-port') as HTMLInputElement).value = '5555';
        (this.container.querySelector('.discovery-manual-label') as HTMLInputElement).value = '';
        const resultEl = this.container.querySelector('.discovery-manual-result') as HTMLElement;
        resultEl.setAttribute('hidden', '');
        resultEl.textContent = '';
        resultEl.classList.remove('error', 'success');
    }

    private showManualResult(text: string, kind: 'success' | 'error'): void {
        const resultEl = this.container.querySelector('.discovery-manual-result') as HTMLElement;
        resultEl.textContent = text;
        resultEl.classList.toggle('success', kind === 'success');
        resultEl.classList.toggle('error', kind === 'error');
        resultEl.removeAttribute('hidden');
    }

    private async manualConnect(): Promise<void> {
        const addressInput = this.container.querySelector('.discovery-manual-address') as HTMLInputElement;
        const portInput = this.container.querySelector('.discovery-manual-port') as HTMLInputElement;
        const labelInput = this.container.querySelector('.discovery-manual-label') as HTMLInputElement;
        const btn = this.container.querySelector('.discovery-manual-connect') as HTMLButtonElement;

        const ip = addressInput.value.trim();
        const port = portInput.value.trim() || '5555';
        const label = labelInput.value.trim();

        if (!ip) {
            this.showManualResult('Address is required', 'error');
            addressInput.focus();
            return;
        }

        const address = `${ip}:${port}`;
        btn.disabled = true;
        btn.textContent = 'Connecting...';
        const resultEl = this.container.querySelector('.discovery-manual-result') as HTMLElement;
        resultEl.setAttribute('hidden', '');
        resultEl.textContent = '';
        resultEl.classList.remove('error', 'success');
        // §25b — using-declaration replaces the prior try/finally restoring
        // the manual-connect button. Captures `btn`.
        using _restoreBtn = {
            [Symbol.dispose](): void {
                btn.disabled = false;
                btn.textContent = 'connect';
            },
        };

        try {
            const res = await fetch('/api/devices/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address, label: label || undefined }),
            });
            const result: ConnectResult = await res.json();
            if (result.success) {
                this.showManualResult(`Connected to ${address}`, 'success');
                setTimeout(() => this.toggleManualForm(false), 2000);
            } else {
                this.showManualResult(result.message || `Failed to connect to ${address}`, 'error');
            }
        } catch (err: any) {
            this.showManualResult(err?.message || 'Request failed', 'error');
        }
    }

    private async connectDevice(address: string, serial: string, card: HTMLElement): Promise<void> {
        const btn = card.querySelector('.discovery-connect-btn') as HTMLButtonElement;
        const nameInput = card.querySelector('.discovery-name-input') as HTMLInputElement;
        const resultEl = card.querySelector('.discovery-card-result') as HTMLElement;
        const label = nameInput.value.trim();

        btn.disabled = true;
        resultEl.setAttribute('hidden', '');
        resultEl.textContent = '';
        resultEl.classList.remove('error', 'success');

        try {
            const res = await fetch('/api/devices/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address, serial, label: label || undefined }),
            });
            const result: ConnectResult = await res.json();
            if (result.success) {
                setTimeout(() => card.remove(), 1500);
            } else {
                btn.disabled = false;
                this.showCardResult(resultEl, result.message || `Failed to connect to ${address}`, 'error');
            }
        } catch (err: any) {
            btn.disabled = false;
            this.showCardResult(resultEl, err?.message || 'Request failed', 'error');
        }
    }

    private showCardResult(resultEl: HTMLElement, text: string, kind: 'success' | 'error'): void {
        resultEl.textContent = text;
        resultEl.classList.toggle('success', kind === 'success');
        resultEl.classList.toggle('error', kind === 'error');
        resultEl.removeAttribute('hidden');
    }
}
