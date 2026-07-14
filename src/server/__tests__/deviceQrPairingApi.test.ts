import { describe, expect, it, vi } from 'vitest';
import type { AdbClient } from '../AdbClient';
import type { AdbQrPairingStatus, StartedAdbQrPairing } from '../AdbQrPairingSession';
import { DeviceDiscoveryApi } from '../api/DeviceDiscoveryApi';
import { makeReqRes } from './helpers/httpMock';

const started: StartedAdbQrPairing = {
    id: 'session_abc',
    state: 'waiting',
    mode: 'lan',
    message: 'Waiting for Android to scan the QR code…',
    expiresAt: 123_456,
    payload: 'WIFI:T:ADB;S:studio-wssw-test;P:super-secret;;',
    serviceName: 'studio-wssw-test',
    password: 'super-secret',
};

function fakeAdb(): AdbClient {
    return {
        mdnsServices: vi.fn(),
        devices: vi.fn(),
        pair: vi.fn(),
        pairQr: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        shell: vi.fn(),
    } as unknown as AdbClient;
}

function fakeSessions(status: AdbQrPairingStatus | null = started, startedSession: StartedAdbQrPairing = started) {
    return {
        start: vi.fn(() => ({ ...startedSession })),
        getStatus: vi.fn(() => status),
        cancel: vi.fn(() => true),
    };
}

describe('DeviceDiscoveryApi — QR pairing', () => {
    it('starts a session, renders the official payload, and never returns the secret', async () => {
        const sessions = fakeSessions();
        const renderQr = vi.fn(async () => '<svg data-test="qr"></svg>');
        const r = makeReqRes('POST', '/api/devices/pair/qr');

        await new DeviceDiscoveryApi(fakeAdb(), sessions, renderQr).handle(r.req, r.res);

        expect(r.getStatus()).toBe(200);
        expect(sessions.start).toHaveBeenCalledWith({ mode: 'lan' });
        expect(renderQr).toHaveBeenCalledWith(started.payload);
        expect(r.getHeader('cache-control')).toBe('no-store');
        expect(r.getJson()).toEqual({
            id: started.id,
            state: 'waiting',
            mode: 'lan',
            message: started.message,
            expiresAt: started.expiresAt,
            qrSvg: '<svg data-test="qr"></svg>',
        });
        expect(JSON.stringify(r.getJson())).not.toContain(started.password);
        expect(JSON.stringify(r.getJson())).not.toContain(started.payload);
    });

    it('starts a Tailscale QR session for a validated tailnet target', async () => {
        const remote: StartedAdbQrPairing = {
            ...started,
            mode: 'tailscale',
            host: '100.64.1.20',
            message: 'Searching the Tailscale endpoint…',
        };
        const sessions = fakeSessions(remote, remote);
        const renderQr = vi.fn(async () => '<svg data-test="tailscale-qr"></svg>');
        const r = makeReqRes('POST', '/api/devices/pair/qr', {
            mode: 'tailscale',
            host: '100.64.1.20',
        });

        await new DeviceDiscoveryApi(fakeAdb(), sessions, renderQr).handle(r.req, r.res);

        expect(r.getStatus()).toBe(200);
        expect(sessions.start).toHaveBeenCalledWith({ mode: 'tailscale', host: '100.64.1.20' });
        expect(r.getJson()).toEqual({
            id: remote.id,
            state: remote.state,
            mode: 'tailscale',
            host: '100.64.1.20',
            message: remote.message,
            expiresAt: remote.expiresAt,
            qrSvg: '<svg data-test="tailscale-qr"></svg>',
        });
        expect(JSON.stringify(r.getJson())).not.toContain(remote.password);
        expect(JSON.stringify(r.getJson())).not.toContain(remote.payload);
    });

    it('normalizes a full MagicDNS hostname for Tailscale QR', async () => {
        const remote: StartedAdbQrPairing = {
            ...started,
            mode: 'tailscale',
            host: 'pixel-8.my-tailnet.ts.net',
        };
        const sessions = fakeSessions(remote, remote);
        const r = makeReqRes('POST', '/api/devices/pair/qr', {
            mode: 'tailscale',
            host: 'PIXEL-8.MY-TAILNET.TS.NET.',
        });

        await new DeviceDiscoveryApi(
            fakeAdb(),
            sessions,
            vi.fn(async () => '<svg></svg>'),
        ).handle(r.req, r.res);

        expect(r.getStatus()).toBe(200);
        expect(sessions.start).toHaveBeenCalledWith({
            mode: 'tailscale',
            host: 'pixel-8.my-tailnet.ts.net',
        });
    });

    it.each([
        [{ mode: 'internet', host: '100.64.1.20' }, 'QR pairing mode'],
        [{ mode: 'tailscale', host: '' }, 'Tailscale'],
        [{ mode: 'tailscale', host: '192.168.1.20' }, '100.64.0.0/10'],
        [{ mode: 'tailscale', host: 'example.com' }, '.ts.net'],
    ])('rejects an unsafe QR session request %#', async (body, message) => {
        const sessions = fakeSessions();
        const r = makeReqRes('POST', '/api/devices/pair/qr', body);

        await new DeviceDiscoveryApi(fakeAdb(), sessions, vi.fn()).handle(r.req, r.res);

        expect(r.getStatus()).toBe(400);
        expect((r.getJson() as { error: string }).error).toContain(message);
        expect(sessions.start).not.toHaveBeenCalled();
    });

    it('returns current status for the matching session', async () => {
        const status: AdbQrPairingStatus = { ...started, state: 'pairing', message: 'Phone found.' };
        const sessions = fakeSessions(status);
        const r = makeReqRes('GET', `/api/devices/pair/qr?id=${started.id}`);

        await new DeviceDiscoveryApi(fakeAdb(), sessions, vi.fn()).handle(r.req, r.res);

        expect(r.getStatus()).toBe(200);
        expect(sessions.getStatus).toHaveBeenCalledWith(started.id);
        expect(r.getJson()).toEqual(status);
        expect(r.getHeader('cache-control')).toBe('no-store');
    });

    it('cancels the matching session', async () => {
        const sessions = fakeSessions();
        const r = makeReqRes('DELETE', `/api/devices/pair/qr?id=${started.id}`);

        await new DeviceDiscoveryApi(fakeAdb(), sessions, vi.fn()).handle(r.req, r.res);

        expect(r.getStatus()).toBe(200);
        expect(sessions.cancel).toHaveBeenCalledWith(started.id);
        expect(r.getJson()).toEqual({ success: true });
    });

    it('rejects missing or unknown session ids', async () => {
        const sessions = fakeSessions(null);
        const missing = makeReqRes('GET', '/api/devices/pair/qr');
        const unknown = makeReqRes('GET', '/api/devices/pair/qr?id=unknown');

        const api = new DeviceDiscoveryApi(fakeAdb(), sessions, vi.fn());
        await api.handle(missing.req, missing.res);
        await api.handle(unknown.req, unknown.res);

        expect(missing.getStatus()).toBe(400);
        expect(unknown.getStatus()).toBe(404);
    });

    it('cancels the new session if QR rendering fails', async () => {
        const sessions = fakeSessions();
        const r = makeReqRes('POST', '/api/devices/pair/qr');

        await new DeviceDiscoveryApi(fakeAdb(), sessions, vi.fn().mockRejectedValue(new Error('render failed'))).handle(
            r.req,
            r.res,
        );

        expect(r.getStatus()).toBe(500);
        expect(sessions.cancel).toHaveBeenCalledWith(started.id);
        expect(JSON.stringify(r.getJson())).not.toContain('render failed');
    });
});
