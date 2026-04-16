// src/app/client/NetworkDiscoveryPanel.ts

interface MdnsDevice {
    name: string;
    service: string;
    address: string;
    port: number;
}

interface ConnectResult {
    success: boolean;
    message: string;
}

export class NetworkDiscoveryPanel {
    private container: HTMLElement;
    private resultsContainer: HTMLElement;

    constructor() {
        this.container = document.createElement('div');
        this.container.id = 'discovery-panel';
        this.container.className = 'home-section';
        this.container.innerHTML = `
            <div class="discovery-header">
                <h2>Network Devices</h2>
                <button class="dep-btn discovery-scan-btn">Scan Network</button>
            </div>
            <div class="discovery-results"></div>
        `;
        this.resultsContainer = this.container.querySelector('.discovery-results')!;
        this.container.querySelector('.discovery-scan-btn')!.addEventListener('click', () => this.scan());
    }

    getElement(): HTMLElement {
        return this.container;
    }

    private async scan(): Promise<void> {
        const btn = this.container.querySelector('.discovery-scan-btn') as HTMLButtonElement;
        btn.disabled = true;
        btn.textContent = 'Scanning...';
        this.resultsContainer.innerHTML = '<div class="empty-state-card">Scanning local network for ADB devices...</div>';

        try {
            const res = await fetch('/api/devices/scan', { method: 'POST' });
            const devices: MdnsDevice[] = await res.json();
            this.renderResults(devices);
        } catch {
            this.resultsContainer.innerHTML = '<div class="empty-state-card" style="color: #f87171;">Scan failed. Is ADB available?</div>';
        } finally {
            btn.disabled = false;
            btn.textContent = 'Scan Network';
        }
    }

    private renderResults(devices: MdnsDevice[]): void {
        if (devices.length === 0) {
            this.resultsContainer.innerHTML =
                '<div class="empty-state-card">No new devices found on the network. Make sure wireless debugging is enabled on your devices.</div>';
            return;
        }

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
                <button class="dep-btn dep-update discovery-connect-btn" data-address="${addr}">Connect</button>
            `;
            card.querySelector('.discovery-connect-btn')!.addEventListener('click', () => this.connectDevice(addr, card));
            grid.appendChild(card);
        }
        this.resultsContainer.appendChild(grid);
    }

    private async connectDevice(address: string, card: HTMLElement): Promise<void> {
        const btn = card.querySelector('.discovery-connect-btn') as HTMLButtonElement;
        btn.disabled = true;
        btn.textContent = 'Connecting...';

        try {
            const res = await fetch('/api/devices/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address }),
            });
            const result: ConnectResult = await res.json();
            if (result.success) {
                btn.textContent = 'Connected';
                btn.classList.remove('dep-update');
                btn.classList.add('dep-ok-btn');
                setTimeout(() => card.remove(), 1500);
            } else {
                btn.textContent = 'Failed';
                btn.disabled = false;
                setTimeout(() => {
                    btn.textContent = 'Connect';
                }, 2000);
            }
        } catch {
            btn.textContent = 'Error';
            btn.disabled = false;
            setTimeout(() => {
                btn.textContent = 'Connect';
            }, 2000);
        }
    }
}
