// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkDiscoveryPanel } from '../NetworkDiscoveryPanel';

function input(root: HTMLElement, selector: string): HTMLInputElement {
    return root.querySelector(selector) as HTMLInputElement;
}

async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

describe('NetworkDiscoveryPanel — Tailscale pairing', () => {
    it('shows a dedicated pair form with separate pairing and connection ports', () => {
        const panel = new NetworkDiscoveryPanel();
        const root = panel.getElement();
        document.body.appendChild(root);

        (root.querySelector('.discovery-pair-btn') as HTMLButtonElement).click();

        expect((root.querySelector('.discovery-pair-form') as HTMLElement).hasAttribute('hidden')).toBe(false);
        expect(root.querySelector('.discovery-pair-port')).not.toBeNull();
        expect(root.querySelector('.discovery-connect-port')).not.toBeNull();
        expect((root.querySelector('.discovery-pair-code') as HTMLInputElement).type).toBe('password');
    });

    it('validates the six-digit code without calling the server', async () => {
        const panel = new NetworkDiscoveryPanel();
        const root = panel.getElement();
        document.body.appendChild(root);
        (root.querySelector('.discovery-pair-btn') as HTMLButtonElement).click();
        input(root, '.discovery-pair-host').value = '100.64.12.34';
        input(root, '.discovery-pair-port').value = '37123';
        input(root, '.discovery-pair-code').value = '12345';
        input(root, '.discovery-connect-port').value = '42111';

        (root.querySelector('.discovery-pair-connect') as HTMLButtonElement).click();
        await flush();

        expect(fetch).not.toHaveBeenCalled();
        expect((root.querySelector('.discovery-pair-result') as HTMLElement).textContent).toContain('exactly 6 digits');
    });

    it('submits pair-and-connect once and clears the code field immediately', async () => {
        vi.mocked(fetch).mockResolvedValue({
            ok: true,
            json: async () => ({
                success: true,
                phase: 'complete',
                address: '100.64.12.34:42111',
                message: 'Paired and connected',
            }),
        } as Response);
        const panel = new NetworkDiscoveryPanel();
        const root = panel.getElement();
        document.body.appendChild(root);
        (root.querySelector('.discovery-pair-btn') as HTMLButtonElement).click();
        input(root, '.discovery-pair-host').value = '100.64.12.34';
        input(root, '.discovery-pair-port').value = '37123';
        input(root, '.discovery-pair-code').value = '123456';
        input(root, '.discovery-connect-port').value = '42111';
        input(root, '.discovery-pair-label').value = 'Personal phone';

        (root.querySelector('.discovery-pair-connect') as HTMLButtonElement).click();
        expect(input(root, '.discovery-pair-code').value).toBe('');
        await flush();

        expect(fetch).toHaveBeenCalledTimes(1);
        const [, init] = vi.mocked(fetch).mock.calls[0]!;
        expect(JSON.parse(String(init?.body))).toEqual({
            host: '100.64.12.34',
            pairingPort: '37123',
            pairingCode: '123456',
            connectPort: '42111',
            label: 'Personal phone',
        });
        expect((root.querySelector('.discovery-pair-result') as HTMLElement).textContent).toContain(
            'Paired and connected',
        );
    });
});
