import { describe, expect, it, vi } from 'vitest';
import type { AdbClient } from '../AdbClient';
import { AdbQrPairingSessionManager } from '../AdbQrPairingSession';

function fakeAdb(): AdbClient {
    return {
        mdnsServices: vi.fn().mockResolvedValue([]),
        pairQr: vi.fn().mockRejectedValue(new Error('not a pairing endpoint')),
        connect: vi.fn().mockRejectedValue(new Error('not a connect endpoint')),
    } as unknown as AdbClient;
}

function manager(adb: AdbClient, scanPorts: (host: string, options: { signal?: AbortSignal }) => Promise<number[]>) {
    let fill = 1;
    return new AdbQrPairingSessionManager(adb, {
        now: () => 1_000,
        randomBytes: (size) => Buffer.alloc(size, fill++),
        setInterval: () => 1 as unknown as NodeJS.Timeout,
        clearInterval: () => undefined,
        scanPorts,
    });
}

describe('AdbQrPairingSessionManager — Tailscale QR', () => {
    it('creates the same official Android QR payload but records the remote target', () => {
        const sessions = manager(fakeAdb(), vi.fn().mockResolvedValue([]));
        const qr = sessions.start({ mode: 'tailscale', host: '100.64.1.20' });

        expect(qr.mode).toBe('tailscale');
        expect(qr.host).toBe('100.64.1.20');
        expect(qr.payload).toMatch(/^WIFI:T:ADB;S:studio-wssw-[A-Za-z0-9_-]+;P:[A-Za-z0-9_-]+;;$/);
        expect(sessions.getStatus(qr.id)).toMatchObject({
            mode: 'tailscale',
            state: 'waiting',
        });
    });

    it('normalizes and independently validates the remote target', () => {
        const sessions = manager(fakeAdb(), vi.fn().mockResolvedValue([]));
        const qr = sessions.start({ mode: 'tailscale', host: 'PIXEL.MY-TAILNET.TS.NET.' });

        expect(qr.host).toBe('pixel.my-tailnet.ts.net');
        expect(() => sessions.start({ mode: 'tailscale', host: '192.168.1.20' })).toThrow('100.64.0.0/10');
    });

    it('finds a pairing endpoint, pairs, then connects the authenticated ADB endpoint', async () => {
        const adb = fakeAdb();
        const scanPorts = vi.fn().mockResolvedValue([40_001, 40_002]);
        vi.mocked(adb.pairQr)
            .mockRejectedValueOnce(new Error('secure-connect port is not a pairing server'))
            .mockResolvedValueOnce('Successfully paired to 100.64.1.20:40002');
        vi.mocked(adb.connect).mockResolvedValueOnce('connected to 100.64.1.20:40001');
        const sessions = manager(adb, scanPorts);
        const qr = sessions.start({ mode: 'tailscale', host: '100.64.1.20' });

        await sessions.pollNow();

        expect(scanPorts).toHaveBeenCalledWith('100.64.1.20', expect.objectContaining({ signal: expect.anything() }));
        expect(adb.pairQr).toHaveBeenNthCalledWith(1, '100.64.1.20:40001', qr.password, 6_000);
        expect(adb.pairQr).toHaveBeenNthCalledWith(2, '100.64.1.20:40002', qr.password, 6_000);
        expect(adb.connect).toHaveBeenCalledWith('100.64.1.20:40001', 5_000);
        expect(sessions.getStatus(qr.id)).toMatchObject({
            state: 'complete',
            mode: 'tailscale',
            address: '100.64.1.20:40001',
        });
    });

    it('keeps scanning when the phone has not opened its temporary pairing port yet', async () => {
        const adb = fakeAdb();
        const sessions = manager(adb, vi.fn().mockResolvedValue([]));
        const qr = sessions.start({ mode: 'tailscale', host: '100.64.1.20' });

        await sessions.pollNow();

        expect(adb.pairQr).not.toHaveBeenCalled();
        expect(adb.connect).not.toHaveBeenCalled();
        expect(sessions.getStatus(qr.id)).toMatchObject({ state: 'waiting', mode: 'tailscale' });
    });

    it('retries a transiently failing pairing endpoint', async () => {
        const adb = fakeAdb();
        const scanPorts = vi.fn().mockResolvedValue([43_000]);
        vi.mocked(adb.pairQr)
            .mockRejectedValueOnce(new Error('endpoint not ready'))
            .mockResolvedValueOnce('Successfully paired to 100.64.1.20:43000');
        const sessions = manager(adb, scanPorts);
        const qr = sessions.start({ mode: 'tailscale', host: '100.64.1.20' });

        await sessions.pollNow();
        expect(sessions.getStatus(qr.id)).toMatchObject({ state: 'waiting' });

        await sessions.pollNow();
        expect(adb.pairQr).toHaveBeenCalledTimes(2);
        expect(sessions.getStatus(qr.id)).toMatchObject({ state: 'connecting' });
    });

    it('stops retrying a non-pairing port after the strict attempt cap', async () => {
        const adb = fakeAdb();
        const scanPorts = vi.fn().mockResolvedValue([43_500]);
        const sessions = manager(adb, scanPorts);
        sessions.start({ mode: 'tailscale', host: '100.64.1.20' });

        for (let attempt = 0; attempt < 5; attempt += 1) await sessions.pollNow();

        expect(adb.pairQr).toHaveBeenCalledTimes(3);
    });

    it('retries connect discovery after pairing completes but the secure endpoint is not ready', async () => {
        const adb = fakeAdb();
        const scanPorts = vi.fn().mockResolvedValueOnce([42_000]).mockResolvedValueOnce([42_000, 42_001]);
        vi.mocked(adb.pairQr).mockResolvedValueOnce('Successfully paired to 100.64.1.20:42000');
        vi.mocked(adb.connect).mockResolvedValueOnce('connected to 100.64.1.20:42001');
        const sessions = manager(adb, scanPorts);
        const qr = sessions.start({ mode: 'tailscale', host: '100.64.1.20' });

        await sessions.pollNow();
        expect(sessions.getStatus(qr.id)).toMatchObject({ state: 'connecting' });

        await sessions.pollNow();
        expect(adb.pairQr).toHaveBeenCalledTimes(1);
        expect(adb.connect).toHaveBeenLastCalledWith('100.64.1.20:42001', 5_000);
        expect(sessions.getStatus(qr.id)).toMatchObject({ state: 'complete', address: '100.64.1.20:42001' });
    });

    it('fails generically when target resolution or scanning cannot start', async () => {
        const adb = fakeAdb();
        const sessions = manager(adb, vi.fn().mockRejectedValue(new Error('internal DNS detail')));
        const qr = sessions.start({ mode: 'tailscale', host: 'pixel.my-tailnet.ts.net' });

        await sessions.pollNow();

        const status = sessions.getStatus(qr.id);
        expect(status).toMatchObject({ state: 'failed', mode: 'tailscale' });
        expect(status?.message).not.toContain('internal DNS detail');
        expect(adb.pairQr).not.toHaveBeenCalled();
    });

    it('aborts an in-flight remote scan when the user cancels', async () => {
        let observedSignal: AbortSignal | undefined;
        let release!: () => void;
        const scanPorts = vi.fn((_host: string, options: { signal?: AbortSignal }) => {
            observedSignal = options.signal;
            return new Promise<number[]>((resolve) => {
                release = () => resolve([]);
            });
        });
        const sessions = manager(fakeAdb(), scanPorts);
        const qr = sessions.start({ mode: 'tailscale', host: '100.64.1.20' });

        const poll = sessions.pollNow();
        await Promise.resolve();
        expect(observedSignal?.aborted).toBe(false);
        expect(sessions.cancel(qr.id)).toBe(true);
        expect(observedSignal?.aborted).toBe(true);
        release();
        await poll;
        expect(sessions.getStatus(qr.id)).toMatchObject({ state: 'cancelled' });
    });
});
