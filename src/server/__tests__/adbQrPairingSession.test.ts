import { describe, expect, it, vi } from 'vitest';
import type { AdbClient } from '../AdbClient';
import { AdbQrPairingSessionManager } from '../AdbQrPairingSession';

function fakeAdb(overrides: Partial<AdbClient> = {}): AdbClient {
    return {
        mdnsServices: vi.fn().mockResolvedValue([]),
        pairQr: vi.fn().mockResolvedValue('Successfully paired to 192.168.1.20:37123 [guid=abc]'),
        ...overrides,
    } as unknown as AdbClient;
}

function manager(adb: AdbClient, now = 1_000): AdbQrPairingSessionManager {
    let fill = 1;
    return new AdbQrPairingSessionManager(adb, {
        now: () => now,
        randomBytes: (size) => Buffer.alloc(size, fill++),
        setInterval: () => 1 as unknown as NodeJS.Timeout,
        clearInterval: () => undefined,
    });
}

describe('AdbQrPairingSessionManager', () => {
    it('creates an official ADB Wi-Fi QR payload with ephemeral credentials', () => {
        const qr = manager(fakeAdb()).start();

        expect(qr.payload).toMatch(/^WIFI:T:ADB;S:studio-wssw-[A-Za-z0-9_-]+;P:[A-Za-z0-9_-]+;;$/);
        expect(qr.state).toBe('waiting');
        expect(qr.expiresAt).toBe(121_000);
        expect(qr.id).not.toContain(qr.password);
    });

    it('pairs only the exact mDNS service requested by the QR', async () => {
        const adb = fakeAdb();
        const sessions = manager(adb);
        const qr = sessions.start();
        vi.mocked(adb.mdnsServices).mockResolvedValue([
            {
                name: `${qr.serviceName}-other`,
                service: '_adb-tls-pairing._tcp.',
                address: '192.168.1.19',
                port: 30001,
            },
            { name: qr.serviceName, service: '_adb-tls-pairing._tcp.', address: '192.168.1.20', port: 37123 },
        ]);

        await sessions.pollNow();

        expect(adb.pairQr).toHaveBeenCalledTimes(1);
        expect(adb.pairQr).toHaveBeenCalledWith('192.168.1.20:37123', qr.password);
        expect(sessions.getStatus(qr.id)).toMatchObject({ state: 'complete' });
    });

    it('keeps waiting when only unrelated pairing services are visible', async () => {
        const adb = fakeAdb({
            mdnsServices: vi.fn().mockResolvedValue([
                {
                    name: 'studio-someone-else',
                    service: '_adb-tls-pairing._tcp.',
                    address: '192.168.1.50',
                    port: 39999,
                },
            ]),
        });
        const sessions = manager(adb);
        const qr = sessions.start();

        await sessions.pollNow();

        expect(adb.pairQr).not.toHaveBeenCalled();
        expect(sessions.getStatus(qr.id)).toMatchObject({ state: 'waiting' });
    });

    it('returns a generic failure and never exposes the QR password', async () => {
        const adb = fakeAdb();
        const sessions = manager(adb);
        const qr = sessions.start();
        vi.mocked(adb.mdnsServices).mockResolvedValue([
            { name: qr.serviceName, service: '_adb-tls-pairing._tcp.', address: '192.168.1.20', port: 37123 },
        ]);
        vi.mocked(adb.pairQr).mockRejectedValue(new Error(`wrong password ${qr.password}`));

        await sessions.pollNow();

        const status = sessions.getStatus(qr.id)!;
        expect(status.state).toBe('failed');
        expect(JSON.stringify(status)).not.toContain(qr.password);
    });

    it('expires and cancels sessions without pairing afterwards', async () => {
        let now = 1_000;
        const adb = fakeAdb();
        const sessions = new AdbQrPairingSessionManager(adb, {
            now: () => now,
            randomBytes: (size) => Buffer.alloc(size, 0xcd),
            setInterval: () => 1 as unknown as NodeJS.Timeout,
            clearInterval: () => undefined,
        });
        const expired = sessions.start();
        now = expired.expiresAt;
        await sessions.pollNow();
        expect(sessions.getStatus(expired.id)).toMatchObject({ state: 'expired' });

        const cancelled = sessions.start();
        expect(sessions.cancel(cancelled.id)).toBe(true);
        expect(sessions.getStatus(cancelled.id)).toMatchObject({ state: 'cancelled' });

        await sessions.pollNow();
        expect(adb.pairQr).not.toHaveBeenCalled();
    });

    it('does not overwrite a cancellation when adb pair finishes later', async () => {
        let resolvePair!: (value: string) => void;
        const pairResult = new Promise<string>((resolve) => {
            resolvePair = resolve;
        });
        const adb = fakeAdb({ pairQr: vi.fn(() => pairResult) });
        const sessions = manager(adb);
        const qr = sessions.start();
        vi.mocked(adb.mdnsServices).mockResolvedValue([
            { name: qr.serviceName, service: '_adb-tls-pairing._tcp.', address: '192.168.1.20', port: 37123 },
        ]);

        const poll = sessions.pollNow();
        await Promise.resolve();
        expect(sessions.getStatus(qr.id)).toMatchObject({ state: 'pairing' });
        expect(sessions.cancel(qr.id)).toBe(true);
        resolvePair('Successfully paired to 192.168.1.20:37123');
        await poll;

        expect(sessions.getStatus(qr.id)).toMatchObject({ state: 'cancelled' });
    });

    it('replaces the prior active session so stale QR codes cannot pair', async () => {
        const adb = fakeAdb();
        let fill = 1;
        const sessions = new AdbQrPairingSessionManager(adb, {
            now: () => 1_000,
            randomBytes: (size) => Buffer.alloc(size, fill++),
            setInterval: () => 1 as unknown as NodeJS.Timeout,
            clearInterval: () => undefined,
        });
        const oldQr = sessions.start();
        const newQr = sessions.start();
        vi.mocked(adb.mdnsServices).mockResolvedValue([
            { name: oldQr.serviceName, service: '_adb-tls-pairing._tcp.', address: '192.168.1.19', port: 30001 },
        ]);

        await sessions.pollNow();

        expect(sessions.getStatus(oldQr.id)).toBeNull();
        expect(sessions.getStatus(newQr.id)).toMatchObject({ state: 'waiting' });
        expect(adb.pairQr).not.toHaveBeenCalled();
    });
});
