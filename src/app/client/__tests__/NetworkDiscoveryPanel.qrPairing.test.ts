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
                mode: 'lan',
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
        expect(fetch).toHaveBeenCalledWith('/api/devices/pair/qr', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'lan' }),
        });
    });

    it('switches to Tailscale QR and sends only the validated target host', async () => {
        vi.mocked(fetch)
            .mockResolvedValueOnce(
                response({
                    id: 'qr-lan-before-switch',
                    state: 'waiting',
                    mode: 'lan',
                    message: 'Waiting',
                    expiresAt: Date.now() + 120_000,
                    qrSvg: '<svg></svg>',
                }),
            )
            .mockResolvedValueOnce(response({ success: true }))
            .mockResolvedValueOnce(
                response({
                    id: 'qr-tailscale-1',
                    state: 'waiting',
                    mode: 'tailscale',
                    host: '100.64.1.20',
                    message: 'Searching the Tailscale endpoint…',
                    expiresAt: Date.now() + 180_000,
                    qrSvg: '<svg data-test="tailscale-qr"><path /></svg>',
                }),
            );
        const panel = new NetworkDiscoveryPanel();
        const root = panel.getElement();
        document.body.appendChild(root);

        (root.querySelector('.discovery-qr-pair-btn') as HTMLButtonElement).click();
        await flush();
        (root.querySelector('.discovery-qr-mode-tailscale') as HTMLButtonElement).click();
        await flush();

        const target = root.querySelector('.discovery-qr-tailscale-target') as HTMLElement;
        expect(target.hasAttribute('hidden')).toBe(false);
        expect((root.querySelector('.discovery-qr-code') as HTMLElement).innerHTML).toBe('');
        const host = root.querySelector('.discovery-qr-tailscale-host') as HTMLInputElement;
        host.value = '100.64.1.20';
        (root.querySelector('.discovery-qr-generate') as HTMLButtonElement).click();
        await flush();

        expect(fetch).toHaveBeenNthCalledWith(2, '/api/devices/pair/qr?id=qr-lan-before-switch', {
            method: 'DELETE',
        });
        expect(fetch).toHaveBeenNthCalledWith(3, '/api/devices/pair/qr', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'tailscale', host: '100.64.1.20' }),
        });
        expect(root.querySelector('.discovery-qr-code svg')?.getAttribute('data-test')).toBe('tailscale-qr');
        expect((root.querySelector('.discovery-qr-guide-title') as HTMLElement).textContent).toContain('Tailscale');
    });

    it('shows a Tailscale connection result without starting an mDNS quick scan', async () => {
        vi.mocked(fetch)
            .mockResolvedValueOnce(
                response({
                    id: 'qr-lan-before-remote',
                    state: 'waiting',
                    mode: 'lan',
                    message: 'Waiting',
                    expiresAt: Date.now() + 120_000,
                    qrSvg: '<svg></svg>',
                }),
            )
            .mockResolvedValueOnce(response({ success: true }))
            .mockResolvedValueOnce(
                response({
                    id: 'qr-tailscale-2',
                    state: 'waiting',
                    mode: 'tailscale',
                    host: 'pixel.my-tailnet.ts.net',
                    message: 'Searching',
                    expiresAt: Date.now() + 180_000,
                    qrSvg: '<svg></svg>',
                }),
            )
            .mockResolvedValueOnce(
                response({
                    id: 'qr-tailscale-2',
                    state: 'complete',
                    mode: 'tailscale',
                    host: 'pixel.my-tailnet.ts.net',
                    address: 'pixel.my-tailnet.ts.net:42111',
                    message: 'Paired and connected over Tailscale.',
                    expiresAt: Date.now() + 179_000,
                }),
            );
        const panel = new NetworkDiscoveryPanel();
        const quickScan = vi.spyOn(panel as any, 'quickScan').mockImplementation(() => undefined);
        const root = panel.getElement();
        document.body.appendChild(root);

        (root.querySelector('.discovery-qr-pair-btn') as HTMLButtonElement).click();
        await flush();
        (root.querySelector('.discovery-qr-mode-tailscale') as HTMLButtonElement).click();
        await flush();
        const host = root.querySelector('.discovery-qr-tailscale-host') as HTMLInputElement;
        host.value = 'pixel.my-tailnet.ts.net';
        (root.querySelector('.discovery-qr-generate') as HTMLButtonElement).click();
        await flush();
        await vi.advanceTimersByTimeAsync(1_000);
        await flush();

        expect(quickScan).not.toHaveBeenCalled();
        expect((root.querySelector('.discovery-qr-status') as HTMLElement).classList.contains('success')).toBe(true);
        expect((root.querySelector('.discovery-info') as HTMLElement).textContent).toContain(
            'pixel.my-tailnet.ts.net:42111',
        );
    });

    it('does not start Tailscale QR without a target', async () => {
        vi.mocked(fetch)
            .mockResolvedValueOnce(
                response({
                    id: 'qr-lan-before-empty',
                    state: 'waiting',
                    mode: 'lan',
                    message: 'Waiting',
                    expiresAt: Date.now() + 120_000,
                    qrSvg: '<svg></svg>',
                }),
            )
            .mockResolvedValueOnce(response({ success: true }));
        const panel = new NetworkDiscoveryPanel();
        const root = panel.getElement();
        document.body.appendChild(root);

        (root.querySelector('.discovery-qr-pair-btn') as HTMLButtonElement).click();
        await flush();
        (root.querySelector('.discovery-qr-mode-tailscale') as HTMLButtonElement).click();
        await flush();
        (root.querySelector('.discovery-qr-generate') as HTMLButtonElement).click();
        await flush();

        expect(fetch).toHaveBeenCalledTimes(2);
        expect((root.querySelector('.discovery-qr-status') as HTMLElement).textContent).toContain('Tailscale IP');
        expect((root.querySelector('.discovery-qr-status') as HTMLElement).classList.contains('error')).toBe(true);
    });

    it('polls until complete, stops polling, and starts a quick scan', async () => {
        vi.mocked(fetch)
            .mockResolvedValueOnce(
                response({
                    id: 'qr-session-2',
                    state: 'waiting',
                    mode: 'lan',
                    message: 'Waiting for Android to scan the QR code…',
                    expiresAt: Date.now() + 120_000,
                    qrSvg: '<svg><path /></svg>',
                }),
            )
            .mockResolvedValueOnce(
                response({
                    id: 'qr-session-2',
                    state: 'complete',
                    mode: 'lan',
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
                    mode: 'lan',
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
                mode: 'lan',
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
