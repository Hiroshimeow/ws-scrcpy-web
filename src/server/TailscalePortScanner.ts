import { lookup as nodeLookup } from 'dns/promises';
import * as net from 'net';

export const TAILSCALE_QR_PORT_START = 32_768;
export const TAILSCALE_QR_PORT_END = 65_535;

type LookupIpv4 = (hostname: string, options: { family: 4 }) => Promise<{ address: string; family: number }>;
type ResolveHost = (host: string) => Promise<string>;

export interface TcpPortScanOptions {
    startPort?: number;
    endPort?: number;
    concurrency?: number;
    timeoutMs?: number;
    maxOpenPorts?: number;
    signal?: AbortSignal;
    resolveHost?: ResolveHost;
}

function isTailscaleIpv4(address: string): boolean {
    const octets = address.split('.');
    if (octets.length !== 4 || !octets.every((part) => /^\d{1,3}$/.test(part))) return false;
    const values = octets.map(Number);
    return (
        values.every((value) => value >= 0 && value <= 255) &&
        values[0] === 100 &&
        values[1]! >= 64 &&
        values[1]! <= 127
    );
}

/** Resolve once before the worker pool so a MagicDNS hostname never causes one DNS lookup per port. */
export async function resolveTcpScanHost(
    host: string,
    lookup: LookupIpv4 = async (hostname, options) => nodeLookup(hostname, options),
): Promise<string> {
    if (net.isIP(host) !== 0) return host;
    const { address } = await lookup(host, { family: 4 });
    if (host.toLowerCase().replace(/\.$/, '').endsWith('.ts.net') && !isTailscaleIpv4(address)) {
        throw new Error('MagicDNS hostname did not resolve to a Tailscale IPv4 address');
    }
    return address;
}

function abortError(): Error {
    const error = new Error('port scan cancelled');
    error.name = 'AbortError';
    return error;
}

function validateOptions(
    options: TcpPortScanOptions,
): Required<Pick<TcpPortScanOptions, 'startPort' | 'endPort' | 'concurrency' | 'timeoutMs' | 'maxOpenPorts'>> {
    const startPort = options.startPort ?? TAILSCALE_QR_PORT_START;
    const endPort = options.endPort ?? TAILSCALE_QR_PORT_END;
    const concurrency = options.concurrency ?? 512;
    const timeoutMs = options.timeoutMs ?? 500;
    const maxOpenPorts = options.maxOpenPorts ?? 16;

    if (!Number.isInteger(startPort) || !Number.isInteger(endPort) || startPort < 1_024 || endPort > 65_535) {
        throw new Error('invalid TCP scan range');
    }
    if (endPort < startPort || endPort - startPort + 1 > 32_768) {
        throw new Error('TCP scan range is too large');
    }
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 1_024) {
        throw new Error('invalid TCP scan concurrency');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 25 || timeoutMs > 5_000) {
        throw new Error('invalid TCP scan timeout');
    }
    if (!Number.isInteger(maxOpenPorts) || maxOpenPorts < 1 || maxOpenPorts > 256) {
        throw new Error('invalid open-port limit');
    }
    return { startPort, endPort, concurrency, timeoutMs, maxOpenPorts };
}

interface ScanContext {
    signal: AbortSignal | undefined;
    activeSockets: Set<net.Socket>;
}

function probePort(host: string, port: number, timeoutMs: number, context: ScanContext): Promise<boolean> {
    if (context.signal?.aborted) return Promise.reject(abortError());

    return new Promise<boolean>((resolve, reject) => {
        const socket = net.createConnection({ host, port });
        context.activeSockets.add(socket);
        let settled = false;
        const finish = (open: boolean, error?: Error) => {
            if (settled) return;
            settled = true;
            context.activeSockets.delete(socket);
            socket.removeAllListeners();
            socket.destroy();
            if (error) reject(error);
            else resolve(open);
        };
        socket.setTimeout(timeoutMs, () => finish(false));
        socket.once('connect', () => finish(true));
        socket.once('error', () => {
            if (context.signal?.aborted) finish(false, abortError());
            else finish(false);
        });
    });
}

/**
 * Bounded TCP-connect scanner used only after the target has passed the strict
 * Tailscale host validator. It creates a fixed worker pool rather than one
 * Promise/socket per port, keeping memory and descriptor usage predictable.
 */
export async function scanTcpPorts(host: string, options: TcpPortScanOptions = {}): Promise<number[]> {
    const { startPort, endPort, concurrency, timeoutMs, maxOpenPorts } = validateOptions(options);
    if (options.signal?.aborted) throw abortError();

    const targetHost = await (options.resolveHost ?? resolveTcpScanHost)(host);
    if (options.signal?.aborted) throw abortError();

    const open: number[] = [];
    const context: ScanContext = { signal: options.signal, activeSockets: new Set<net.Socket>() };
    let nextPort = startPort;
    let fatal: Error | undefined;
    const onAbort = () => {
        const error = abortError();
        for (const socket of context.activeSockets) socket.destroy(error);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const worker = async () => {
        while (!fatal) {
            if (options.signal?.aborted) throw abortError();
            const port = nextPort++;
            if (port > endPort) return;
            try {
                if (await probePort(targetHost, port, timeoutMs, context)) {
                    open.push(port);
                    if (open.length > maxOpenPorts) {
                        fatal = new Error('too many open ports on Tailscale target');
                        return;
                    }
                }
            } catch (error) {
                fatal = error as Error;
                return;
            }
        }
    };

    try {
        const workerCount = Math.min(concurrency, endPort - startPort + 1);
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
        if (fatal) throw fatal;
        return open.sort((a, b) => a - b);
    } finally {
        options.signal?.removeEventListener('abort', onAbort);
        for (const socket of context.activeSockets) socket.destroy();
        context.activeSockets.clear();
    }
}
