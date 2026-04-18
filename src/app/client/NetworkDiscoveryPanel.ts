// src/app/client/NetworkDiscoveryPanel.ts

interface MdnsDevice {
    name: string;
    service: string;
    address: string;
    port: number;
    serial: string;
    label: string;
}

interface ConnectResult {
    success: boolean;
    message: string;
}

export class NetworkDiscoveryPanel {
    private container: HTMLElement;
    private infoBox: HTMLElement;
    private resultsContainer: HTMLElement;

    constructor() {
        this.container = document.createElement('div');
        this.container.id = 'discovery-panel';
        this.container.className = 'home-section';
        this.container.innerHTML = `
            <div class="discovery-header">
                <h2>Available Network Devices</h2>
                <div class="discovery-header-actions">
                    <button class="dep-btn discovery-scan-btn">scan network</button>
                    <button class="dep-btn discovery-manual-btn">manually add</button>
                </div>
            </div>
            <div class="discovery-manual-form" hidden>
                <input type="text" class="discovery-manual-address" placeholder="192.168.86.50" />
                <input type="text" class="discovery-manual-port" placeholder="5555" value="5555" />
                <input type="text" class="discovery-manual-label" placeholder="optional name" />
                <button class="dep-btn dep-update discovery-manual-connect">connect</button>
                <button class="discovery-manual-close" aria-label="close" title="close">×</button>
                <div class="discovery-manual-result" hidden></div>
            </div>
            <div class="discovery-results"></div>
            <div class="empty-state-card discovery-info">Click scan network to find devices. Make sure wireless debugging is enabled on the devices you wish to connect with.</div>
        `;
        this.infoBox = this.container.querySelector('.discovery-info')!;
        this.resultsContainer = this.container.querySelector('.discovery-results')!;
        this.container.querySelector('.discovery-scan-btn')!.addEventListener('click', () => this.scan());
        this.container.querySelector('.discovery-manual-btn')!.addEventListener('click', () => this.toggleManualForm());
        this.container.querySelector('.discovery-manual-close')!.addEventListener('click', () =>
            this.toggleManualForm(false),
        );
        this.container.querySelector('.discovery-manual-connect')!.addEventListener('click', () => this.manualConnect());
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

    private async scan(): Promise<void> {
        const btn = this.container.querySelector('.discovery-scan-btn') as HTMLButtonElement;
        btn.disabled = true;
        btn.textContent = 'Scanning...';
        this.setInfoText('Scanning local network for ADB devices...');
        this.resultsContainer.innerHTML = '';

        try {
            const res = await fetch('/api/devices/scan', { method: 'POST' });
            const devices: MdnsDevice[] = await res.json();
            this.renderResults(devices);
        } catch {
            this.setInfoText('Scan failed. Is ADB available?', true);
        } finally {
            btn.disabled = false;
            btn.textContent = 'scan network';
        }
    }

    private renderResults(devices: MdnsDevice[]): void {
        if (devices.length === 0) {
            this.setInfoText('No new devices found on the network. Make sure wireless debugging is enabled on your devices.');
            return;
        }

        this.setInfoText('Click scan network to find devices. Make sure wireless debugging is enabled on the devices you wish to connect with.');
        this.resultsContainer.innerHTML = '';
        const grid = document.createElement('div');
        grid.className = 'discovery-grid';

        for (const device of devices) {
            const card = document.createElement('div');
            card.className = 'discovery-card';
            const addr = `${device.address}:${device.port}`;
            card.innerHTML = `
                <div class="discovery-card-info">
                    <div class="discovery-card-name">${device.name}</div>
                    <div class="discovery-card-address">${addr}</div>
                </div>
                <div class="discovery-card-actions">
                    <input type="text" class="discovery-name-input" placeholder="Name this device..." value="${device.label || ''}" />
                    <button class="dep-btn dep-update discovery-connect-btn" data-address="${addr}" data-serial="${device.serial}">Connect</button>
                </div>
            `;
            card.querySelector('.discovery-connect-btn')!.addEventListener('click', () =>
                this.connectDevice(addr, device.serial, card),
            );
            grid.appendChild(card);
        }
        this.resultsContainer.appendChild(grid);
    }

    private toggleManualForm(show?: boolean): void {
        const form = this.container.querySelector('.discovery-manual-form') as HTMLElement;
        const shouldShow = show !== undefined ? show : form.hasAttribute('hidden');
        if (shouldShow) {
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
        } finally {
            btn.disabled = false;
            btn.textContent = 'connect';
        }
    }

    private async connectDevice(address: string, serial: string, card: HTMLElement): Promise<void> {
        const btn = card.querySelector('.discovery-connect-btn') as HTMLButtonElement;
        const nameInput = card.querySelector('.discovery-name-input') as HTMLInputElement;
        const label = nameInput.value.trim();

        btn.disabled = true;

        try {
            const res = await fetch('/api/devices/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address, serial, label: label || undefined }),
            });
            const result: ConnectResult = await res.json();
            if (result.success) {
                btn.classList.remove('dep-update');
                btn.classList.add('dep-ok-btn');
                setTimeout(() => card.remove(), 1500);
            } else {
                btn.disabled = false;
            }
        } catch {
            btn.disabled = false;
        }
    }
}
