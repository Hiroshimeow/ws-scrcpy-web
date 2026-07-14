// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkDiscoveryPanel } from '../NetworkDiscoveryPanel';

async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

function response(body: unknown, ok = true): Response {
    return {
        ok,
        json: async () => body,
    } as Response;
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

describe('NetworkDiscoveryPanel — ADB QR pairing', () => {
    it('opens a same-LAN QR guide and renders the server-generated SVG', async () => {
        vi.mocked(fetch).mockResolvedValue(
            response({
                id: 'qr-session-1',
                state: 'waiting',
                message: 'Waiting for Android to scan the QR code…',
                expiresAt: Date.now() + 120_000,
                qrSvg: '<svg data-test="adb-qr"><path /></svg>',
            }),
        );
        const panel = new NetworkDiscoveryPanel();
        const root = panel.getElement();
        document.body.appendChild(root);

        (root.querySelector('.discovery-qr-pair-btn') as HTMLButtonElement).click();
        await flush();

        const form = root.querySelector('.discovery-qr-pair-form') as HTMLElement;
        expect(form.hasAttribute('hidden')).toBe(false);
        expect(form.textContent).toContain('Pair device with QR code');
        expect(form.textContent).toContain('same Wi-Fi');
        expect(root.querySelector('.discovery-qr-code svg')?.getAttribute('data-test')).toBe('adb-qr');
        expect((root.querySelector('.discovery-qr-status') as HTMLElement).textContent).toContain('Waiting');
        expect(fetch).toHaveBeenCalledWith('/api/devices/pair/qr', { method: 'POST' });
    });

    it('polls until complete, stops polling, and starts a quick scan', async () => {
        vi.mocked(fetch)
            .mockResolvedValueOnce(
                response({
                    id: 'qr-session-2',
                    state: 'waiting',
                    message: 'Waiting for Android to scan the QR code…',
                    expiresAt: Date.now() + 120_000,
                    qrSvg: '<svg><path /></svg>',
                }),
            )
            .mockResolvedValueOnce(
                response({
                    id: 'qr-session-2',
                    state: 'complete',
                    message: 'Paired successfully.',
                    expiresAt: Date.now() + 119_000,
                }),
            );
        const panel = new NetworkDiscoveryPanel();
        const quickScan = vi.spyOn(panel as any, 'quickScan').mockImplementation(() => undefined);
        const root = panel.getElement();
        document.body.appendChild(root);

        (root.querySelector('.discovery-qr-pair-btn') as HTMLButtonElement).click();
        await flush();
        await vi.advanceTimersByTimeAsync(1_000);
        await flush();

        expect(fetch).toHaveBeenNthCalledWith(2, '/api/devices/pair/qr?id=qr-session-2', { cache: 'no-store' });
        expect((root.querySelector('.discovery-qr-status') as HTMLElement).textContent).toContain(
            'Paired successfully',
        );
        expect((root.querySelector('.discovery-qr-status') as HTMLElement).classList.contains('success')).toBe(true);
        expect(quickScan).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(5_000);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('cancels the active server session when the QR panel is closed', async () => {
        vi.mocked(fetch)
            .mockResolvedValueOnce(
                response({
                    id: 'qr-session-3',
                    state: 'waiting',
                    message: 'Waiting',
                    expiresAt: Date.now() + 120_000,
                    qrSvg: '<svg><path /></svg>',
                }),
            )
            .mockResolvedValueOnce(response({ success: true }));
        const panel = new NetworkDiscoveryPanel();
        const root = panel.getElement();
        document.body.appendChild(root);

        (root.querySelector('.discovery-qr-pair-btn') as HTMLButtonElement).click();
        await flush();
        (root.querySelector('.discovery-qr-close') as HTMLButtonElement).click();
        await flush();

        expect(fetch).toHaveBeenNthCalledWith(2, '/api/devices/pair/qr?id=qr-session-3', { method: 'DELETE' });
        expect((root.querySelector('.discovery-qr-pair-form') as HTMLElement).hasAttribute('hidden')).toBe(true);
        expect(root.querySelector('.discovery-qr-code')?.innerHTML).toBe('');
    });

    it('keeps QR, Tailscale-code, and manual forms mutually exclusive', async () => {
        vi.mocked(fetch).mockResolvedValue(
            response({
                id: 'qr-session-4',
                state: 'waiting',
                message: 'Waiting',
                expiresAt: Date.now() + 120_000,
                qrSvg: '<svg><path /></svg>',
            }),
        );
        const panel = new NetworkDiscoveryPanel();
        const root = panel.getElement();
        document.body.appendChild(root);

        (root.querySelector('.discovery-pair-btn') as HTMLButtonElement).click();
        expect((root.querySelector('.discovery-pair-form') as HTMLElement).hasAttribute('hidden')).toBe(false);

        (root.querySelector('.discovery-qr-pair-btn') as HTMLButtonElement).click();
        await flush();
        expect((root.querySelector('.discovery-pair-form') as HTMLElement).hasAttribute('hidden')).toBe(true);
        expect((root.querySelector('.discovery-qr-pair-form') as HTMLElement).hasAttribute('hidden')).toBe(false);

        (root.querySelector('.discovery-manual-btn') as HTMLButtonElement).click();
        await flush();
        expect((root.querySelector('.discovery-qr-pair-form') as HTMLElement).hasAttribute('hidden')).toBe(true);
        expect((root.querySelector('.discovery-manual-form') as HTMLElement).hasAttribute('hidden')).toBe(false);
    });
});
