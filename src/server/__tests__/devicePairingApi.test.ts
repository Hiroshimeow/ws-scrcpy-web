import { describe, expect, it, vi } from 'vitest';
import type { AdbClient } from '../AdbClient';
import { DeviceDiscoveryApi } from '../api/DeviceDiscoveryApi';
import { makeReqRes } from './helpers/httpMock';

function fakeAdb(overrides: Partial<AdbClient> = {}): AdbClient {
    return {
        mdnsServices: vi.fn(),
        devices: vi.fn(),
        pair: vi.fn().mockResolvedValue('Successfully paired to 100.64.12.34:37123 [guid=abc]'),
        connect: vi.fn().mockResolvedValue('connected to 100.64.12.34:42111'),
        disconnect: vi.fn(),
        shell: vi.fn(),
        ...overrides,
    } as unknown as AdbClient;
}

describe('DeviceDiscoveryApi — Tailscale pairing', () => {
    it('pairs first, then connects to the distinct Wireless debugging connection port', async () => {
        const adb = fakeAdb();
        const r = makeReqRes('POST', '/api/devices/pair', {
            host: '100.64.12.34',
            pairingPort: '37123',
            pairingCode: '123456',
            connectPort: '42111',
        });

        await new DeviceDiscoveryApi(adb).handle(r.req, r.res);

        expect(r.getStatus()).toBe(200);
        expect(adb.pair).toHaveBeenCalledWith('100.64.12.34:37123', '123456');
        expect(adb.connect).toHaveBeenCalledWith('100.64.12.34:42111');
        expect(r.getJson()).toMatchObject({ success: true, phase: 'complete', address: '100.64.12.34:42111' });
    });

    it('rejects an invalid code before invoking adb', async () => {
        const adb = fakeAdb();
        const r = makeReqRes('POST', '/api/devices/pair', {
            host: '100.64.12.34',
            pairingPort: '37123',
            pairingCode: '12345x',
            connectPort: '42111',
        });

        await new DeviceDiscoveryApi(adb).handle(r.req, r.res);

        expect(r.getStatus()).toBe(400);
        expect(adb.pair).not.toHaveBeenCalled();
        expect(adb.connect).not.toHaveBeenCalled();
    });

    it('does not return the pairing code when adb pairing fails', async () => {
        const adb = fakeAdb({ pair: vi.fn().mockRejectedValue(new Error('adb pair failed <redacted>')) as never });
        const r = makeReqRes('POST', '/api/devices/pair', {
            host: '100.64.12.34',
            pairingPort: '37123',
            pairingCode: '654321',
            connectPort: '42111',
        });

        await new DeviceDiscoveryApi(adb).handle(r.req, r.res);

        expect(r.getStatus()).toBe(502);
        expect(JSON.stringify(r.getJson())).not.toContain('654321');
        expect(adb.connect).not.toHaveBeenCalled();
    });
});
