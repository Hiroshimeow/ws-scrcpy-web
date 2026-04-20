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
