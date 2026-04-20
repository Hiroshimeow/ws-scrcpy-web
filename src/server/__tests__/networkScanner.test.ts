import { describe, expect, it, vi } from 'vitest';
import { NetworkScanner } from '../network/NetworkScanner';
import type { ParsedSubnet } from '../../common/SubnetParser';
import type { ScanServerMessage } from '../../common/ScanMessage';

function makeSubnet(hosts: string[]): ParsedSubnet {
    return {
        raw: 'test',
        normalized: `test/${hosts.length}`,
        hostCount: hosts.length,
        *hosts() { for (const h of hosts) yield h; },
    };
}

function makeWs(): { ws: any; messages: ScanServerMessage[] } {
    const messages: ScanServerMessage[] = [];
    const ws = {
        readyState: 1, OPEN: 1, CLOSED: 3, CLOSING: 2,
        send: (data: string) => messages.push(JSON.parse(data)),
        close: vi.fn(),
    };
    return { ws, messages };
}

describe('NetworkScanner — lifecycle', () => {
    it('emits scan.started then scan.complete on empty scan', async () => {
        const scanner = new NetworkScanner({
            adbDevices: async () => [],
            adbMdnsServices: async () => [],
            adbConnect: async () => 'failed',
            adbDisconnect: async () => '',
            tcpProbe: async () => false,
            concurrency: 4,
            progressInterval: 10,
        });
        const { ws, messages } = makeWs();
        await scanner.start([makeSubnet([])], ws);

        expect(messages[0].type).toBe('scan.started');
        expect(messages.at(-1)?.type).toBe('scan.complete');
    });

    it('isScanning transitions through states', async () => {
        const scanner = new NetworkScanner({
            adbDevices: async () => [],
            adbMdnsServices: async () => [],
            adbConnect: async () => 'failed',
            adbDisconnect: async () => '',
            tcpProbe: async () => false,
            concurrency: 4,
            progressInterval: 10,
        });
        expect(scanner.isScanning()).toBe(false);
        const { ws } = makeWs();
        const p = scanner.start([makeSubnet(['1.1.1.1', '1.1.1.2'])], ws);
        expect(scanner.isScanning()).toBe(true);
        await p;
        expect(scanner.isScanning()).toBe(false);
    });

    it('rejects concurrent start calls', async () => {
        const scanner = new NetworkScanner({
            adbDevices: async () => [],
            adbMdnsServices: async () => [],
            adbConnect: async () => 'failed',
            adbDisconnect: async () => '',
            tcpProbe: async () => new Promise((r) => setTimeout(() => r(false), 50)),
            concurrency: 4,
            progressInterval: 10,
        });
        const { ws } = makeWs();
        const p1 = scanner.start([makeSubnet(['1.1.1.1'])], ws);
        await expect(scanner.start([makeSubnet(['1.1.1.2'])], ws)).rejects.toThrow(/already scanning/);
        await p1;
    });
});

describe('NetworkScanner — TCP track', () => {
    it('emits scan.hit for TCP-confirmed devices', async () => {
        const tcpProbe = vi.fn(async (host: string) => host === '1.1.1.2');
        const adbConnect = vi.fn(async (addr: string) =>
            addr === '1.1.1.2:5555' ? 'connected to 1.1.1.2:5555' : 'failed to connect'
        );
        const adbDisconnect = vi.fn(async () => 'disconnected');

        const scanner = new NetworkScanner({
            adbDevices: async () => [],
            adbMdnsServices: async () => [],
            adbConnect,
            adbDisconnect,
            tcpProbe,
            concurrency: 4,
            progressInterval: 1,
        });
        const { ws, messages } = makeWs();
        await scanner.start([makeSubnet(['1.1.1.1', '1.1.1.2', '1.1.1.3'])], ws);

        const hits = messages.filter((m) => m.type === 'scan.hit');
        expect(hits).toHaveLength(1);
        expect(hits[0]).toMatchObject({
            type: 'scan.hit',
            source: 'tcp',
            address: '1.1.1.2:5555',
        });
        expect(adbDisconnect).toHaveBeenCalledWith('1.1.1.2:5555');
    });

    it('emits scan.progress at the configured interval', async () => {
        const scanner = new NetworkScanner({
            adbDevices: async () => [],
            adbMdnsServices: async () => [],
            adbConnect: async () => 'failed',
            adbDisconnect: async () => '',
            tcpProbe: async () => false,
            concurrency: 2,
            progressInterval: 2,
        });
        const { ws, messages } = makeWs();
        await scanner.start([makeSubnet(['1.1.1.1', '1.1.1.2', '1.1.1.3', '1.1.1.4'])], ws);
        const progress = messages.filter((m) => m.type === 'scan.progress');
        // With interval 2 and 4 hosts, we expect two progress emissions.
        expect(progress.length).toBeGreaterThanOrEqual(2);
        expect((progress.at(-1) as any)?.checked).toBe(4);
    });

    it('skips addresses already in adb devices', async () => {
        const tcpProbe = vi.fn(async () => true);
        const scanner = new NetworkScanner({
            adbDevices: async () => [{ serial: '1.1.1.1:5555', state: 'device' }],
            adbMdnsServices: async () => [],
            adbConnect: async () => 'connected',
            adbDisconnect: async () => '',
            tcpProbe,
            concurrency: 2,
            progressInterval: 1,
        });
        const { ws, messages } = makeWs();
        await scanner.start([makeSubnet(['1.1.1.1', '1.1.1.2'])], ws);
        expect(tcpProbe).not.toHaveBeenCalledWith('1.1.1.1', expect.anything(), expect.anything());
        const hits = messages.filter((m) => m.type === 'scan.hit');
        expect(hits.every((h: any) => h.address !== '1.1.1.1:5555')).toBe(true);
    });

    it('drops TCP hits whose adb connect does not return connected', async () => {
        const tcpProbe = vi.fn(async () => true);
        const adbConnect = vi.fn(async () => 'failed to connect');
        const scanner = new NetworkScanner({
            adbDevices: async () => [],
            adbMdnsServices: async () => [],
            adbConnect,
            adbDisconnect: async () => '',
            tcpProbe,
            concurrency: 2,
            progressInterval: 1,
        });
        const { ws, messages } = makeWs();
        await scanner.start([makeSubnet(['1.1.1.1', '1.1.1.2'])], ws);
        const hits = messages.filter((m) => m.type === 'scan.hit');
        expect(hits).toHaveLength(0);
    });

    it('respects concurrency bound', async () => {
        let current = 0;
        let maxObserved = 0;
        const tcpProbe = async () => {
            current++;
            if (current > maxObserved) maxObserved = current;
            await new Promise((r) => setTimeout(r, 10));
            current--;
            return false;
        };
        const scanner = new NetworkScanner({
            adbDevices: async () => [],
            adbMdnsServices: async () => [],
            adbConnect: async () => 'failed',
            adbDisconnect: async () => '',
            tcpProbe,
            concurrency: 3,
            progressInterval: 100,
        });
        const { ws } = makeWs();
        const hosts = Array.from({ length: 20 }, (_, i) => `10.0.0.${i + 1}`);
        await scanner.start([makeSubnet(hosts)], ws);
        expect(maxObserved).toBeLessThanOrEqual(3);
    });
});
