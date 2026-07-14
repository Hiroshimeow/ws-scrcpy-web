import { getEventListeners } from 'events';
import * as net from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveTcpScanHost, scanTcpPorts } from '../TailscalePortScanner';

const servers: net.Server[] = [];

async function listen(port = 0): Promise<{ server: net.Server; port: number }> {
    const server = net.createServer((socket) => socket.end());
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing server address');
    return { server, port: address.port };
}

afterEach(async () => {
    await Promise.all(
        servers.splice(0).map(
            (server) =>
                new Promise<void>((resolve) => {
                    server.close(() => resolve());
                }),
        ),
    );
});

describe('resolveTcpScanHost', () => {
    it('does not perform DNS for a literal IP', async () => {
        const lookup = vi.fn();
        await expect(resolveTcpScanHost('100.64.1.20', lookup)).resolves.toBe('100.64.1.20');
        expect(lookup).not.toHaveBeenCalled();
    });

    it('accepts a MagicDNS result only when it resolves into Tailscale CGNAT', async () => {
        const lookup = vi.fn().mockResolvedValue({ address: '100.100.20.30', family: 4 });
        await expect(resolveTcpScanHost('pixel.my-tailnet.ts.net', lookup)).resolves.toBe('100.100.20.30');
        expect(lookup).toHaveBeenCalledTimes(1);

        lookup.mockResolvedValueOnce({ address: '203.0.113.10', family: 4 });
        await expect(resolveTcpScanHost('pixel.my-tailnet.ts.net', lookup)).rejects.toThrow('Tailscale');
    });
});

describe('scanTcpPorts', () => {
    it('finds listening ports inside the requested bounded range', async () => {
        let first: Awaited<ReturnType<typeof listen>> | undefined;
        let second: Awaited<ReturnType<typeof listen>> | undefined;
        for (let base = 40_000; base < 60_000; base += 2) {
            try {
                first = await listen(base);
                second = await listen(base + 1);
                break;
            } catch {
                if (first) {
                    await new Promise<void>((resolve) => first!.server.close(() => resolve()));
                    servers.splice(servers.indexOf(first.server), 1);
                }
                first = undefined;
                second = undefined;
            }
        }
        if (!first || !second) throw new Error('could not reserve adjacent test ports');

        const open = await scanTcpPorts('127.0.0.1', {
            startPort: first.port,
            endPort: second.port,
            concurrency: 2,
            timeoutMs: 100,
        });

        expect(open).toEqual([first.port, second.port]);
        await expect(
            scanTcpPorts('127.0.0.1', {
                startPort: first.port,
                endPort: second.port,
                concurrency: 2,
                timeoutMs: 100,
                maxOpenPorts: 1,
            }),
        ).rejects.toThrow('too many open ports');
    });

    it('resolves a hostname once before probing the entire range', async () => {
        const listening = await listen();
        const resolveHost = vi.fn().mockResolvedValue('127.0.0.1');

        const open = await scanTcpPorts('phone.test', {
            startPort: listening.port,
            endPort: listening.port,
            resolveHost,
        });

        expect(open).toEqual([listening.port]);
        expect(resolveHost).toHaveBeenCalledTimes(1);
        expect(resolveHost).toHaveBeenCalledWith('phone.test');
    });

    it('removes its shared abort listener after a completed scan', async () => {
        const listening = await listen();
        const controller = new AbortController();

        await scanTcpPorts('127.0.0.1', {
            startPort: listening.port,
            endPort: listening.port,
            signal: controller.signal,
        });

        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    });

    it('honours cancellation without scanning the remaining range', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(
            scanTcpPorts('127.0.0.1', {
                startPort: 32_768,
                endPort: 65_535,
                signal: controller.signal,
            }),
        ).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('rejects unbounded or abusive scan settings', async () => {
        await expect(scanTcpPorts('127.0.0.1', { startPort: 0, endPort: 10 })).rejects.toThrow();
        await expect(scanTcpPorts('127.0.0.1', { startPort: 100, endPort: 65_535 })).rejects.toThrow();
        await expect(
            scanTcpPorts('127.0.0.1', { startPort: 32_768, endPort: 32_800, concurrency: 5_000 }),
        ).rejects.toThrow();
    });
});
