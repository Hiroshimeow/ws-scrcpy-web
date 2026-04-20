// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScanNetworkModal } from '../ScanNetworkModal';

beforeEach(() => {
    vi.restoreAllMocks();
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();
    localStorage.clear();
});

afterEach(() => {
    document.body.querySelectorAll('dialog').forEach((d) => d.remove());
    localStorage.clear();
});

async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ScanNetworkModal — gateway detection UI', () => {
    it("renders the 'couldn't detect' notice visible when gatewaySubnet is null", async () => {
        const modal = new ScanNetworkModal({
            gatewaySubnet: null,
            onStartScan: vi.fn(),
        });
        await flush();

        const notice = modal['emptyNotice'];
        expect(notice).toBeDefined();
        expect(notice.textContent).toContain("Couldn't detect your gateway subnet");
        expect(notice.style.display).not.toBe('none');

        modal.close();
    });

    it('hides the notice when a gatewaySubnet is provided', async () => {
        const modal = new ScanNetworkModal({
            gatewaySubnet: { cidr: '192.168.1.0/24', hostCount: 254 },
            onStartScan: vi.fn(),
        });
        await flush();

        const notice = modal['emptyNotice'];
        expect(notice).toBeDefined();
        expect(notice.style.display).toBe('none');

        modal.close();
    });

    it('start-scan button is disabled when gateway is null and no user subnets', async () => {
        const onStartScan = vi.fn();
        const modal = new ScanNetworkModal({
            gatewaySubnet: null,
            onStartScan,
        });
        await flush();

        const startBtn = modal['startBtn'];
        expect(startBtn).toBeDefined();
        expect(startBtn.disabled).toBe(true);
        expect(onStartScan).not.toHaveBeenCalled();

        modal.close();
    });
});
