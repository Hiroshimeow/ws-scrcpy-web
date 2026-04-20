import type WS from 'ws';
import type { ParsedSubnet } from '../../common/SubnetParser';
import type { ScanServerMessage, ScanStartedMessage, ScanProgressMessage } from '../../common/ScanMessage';
import { parseSerialFromMdnsName } from '../AdbClient';
import { Logger } from '../Logger';
import type { AdbHandshakeResult } from './AdbHandshakeProbe';

const log = Logger.for('NetworkScanner');

export interface NetworkScannerDeps {
    adbDevices: () => Promise<{ serial: string; state: string }[]>;
    adbMdnsServices: () => Promise<{ name: string; service: string; address: string; port: number }[]>;
    tcpProbe: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
    /** Raw ADB CNXN handshake probe — confirms a port-5555 endpoint is really ADB
     *  without touching the adb server (port 5037). Returns { isAdb, model? }. */
    adbHandshakeProbe: (host: string, port: number, timeoutMs: number) => Promise<AdbHandshakeResult>;
    /** Resolve an IPv4 to its MAC via ARP cache. Returns null when ARP has no entry. */
    resolveMac?: (ip: string) => Promise<string | null>;
    /** Look up a saved label by device identifier (serial OR MAC). */
    labelFor?: (key: string) => string | undefined;
    concurrency: number;
    progressInterval: number;
    tcpTimeoutMs?: number;
    handshakeTimeoutMs?: number;
}

type State = 'idle' | 'scanning' | 'draining';

export class NetworkScanner {
    private state: State = 'idle';
    private cancelFlag = false;
    private spectators = new Set<WS | any>();
    private emittedAddresses = new Set<string>();
    private foundSoFar = 0;
    private lastStartedMsg: ScanStartedMessage | null = null;
    private lastProgressMsg: ScanProgressMessage | null = null;

    constructor(private readonly deps: NetworkScannerDeps) {}

    isScanning(): boolean {
        return this.state !== 'idle';
    }

    getState(): 'idle' | 'scanning' | 'draining' {
        return this.state;
    }

    attachSpectator(ws: WS | any): void {
        if (this.state === 'idle') return;
        this.spectators.add(ws);
        // Send snapshot of current state so new spectators aren't stuck on empty chip
        if (this.lastStartedMsg && ws.readyState === ws.OPEN) {
            try { ws.send(JSON.stringify(this.lastStartedMsg)); } catch {}
        }
        if (this.lastProgressMsg && ws.readyState === ws.OPEN) {
            try { ws.send(JSON.stringify(this.lastProgressMsg)); } catch {}
        }
        if (this.state === 'draining' && ws.readyState === ws.OPEN) {
            try { ws.send(JSON.stringify({ type: 'scan.draining' })); } catch {}
        }
        // Clean up on close to avoid accumulating dead entries during long scans
        if (typeof ws.once === 'function') {
            ws.once('close', () => this.spectators.delete(ws));
        }
    }

    cancel(): void {
        if (this.state !== 'scanning') return;
        this.cancelFlag = true;
    }

    async start(subnets: ParsedSubnet[], ws: WS | any): Promise<void> {
        if (this.state !== 'idle') {
            throw new Error('scanner already scanning');
        }
        this.state = 'scanning';
        this.cancelFlag = false;
        this.emittedAddresses.clear();
        this.foundSoFar = 0;
        this.lastStartedMsg = null;
        this.lastProgressMsg = null;
        this.spectators.clear();
        this.spectators.add(ws);
        if (typeof (ws as any).once === 'function') {
            (ws as any).once('close', () => this.spectators.delete(ws));
        }

        try {
            const totalHosts = subnets.reduce((sum, s) => sum + s.hostCount, 0);
            this.emit({
                type: 'scan.started',
                totalHosts,
                totalSubnets: subnets.length,
                startedAt: Date.now(),
            });

            const runPromise = this.runTracks(subnets, totalHosts);

            // Watch for cancel flag: emit scan.draining as soon as it's set, while workers still in flight.
            let drainWatcherDone = false;
            const drainWatcher = (async () => {
                while (!this.cancelFlag) {
                    // Exit as soon as runTracks finishes (normal completion path)
                    if (drainWatcherDone) return;
                    await new Promise((r) => setTimeout(r, 10));
                }
                if (this.cancelFlag && this.state === 'scanning') {
                    this.state = 'draining';
                    this.emit({ type: 'scan.draining' });
                }
            })();

            await runPromise;
            // Snapshot cancel state BEFORE awaiting drainWatcher — any late cancel() after
            // workers completed shouldn't retroactively turn a successful scan into cancelled.
            const wasCancelled = this.cancelFlag;
            drainWatcherDone = true;
            await drainWatcher;

            if (wasCancelled) {
                this.emit({ type: 'scan.cancelled', found: this.foundSoFar });
            } else {
                this.emit({ type: 'scan.complete', found: this.foundSoFar });
            }
        } finally {
            this.state = 'idle';
            this.cancelFlag = false;
        }
    }

    protected async runTracks(subnets: ParsedSubnet[], totalHosts: number): Promise<void> {
        const connectedAddresses = new Set(
            (await this.deps.adbDevices()).map((d) => d.serial),
        );

        // Track A: mDNS — synchronous (adb returns all at once)
        const mdnsPromise = (async () => {
            try {
                const hits = await this.deps.adbMdnsServices();
                for (const hit of hits) {
                    if (this.cancelFlag) break;
                    if (!hit.service.includes('_adb') || hit.service.includes('pairing')) continue;
                    const address = `${hit.address}:${hit.port}`;
                    if (connectedAddresses.has(address)) continue;
                    const serial = parseSerialFromMdnsName(hit.name, hit.service);
                    this.emitHit({
                        source: 'mdns',
                        address,
                        serial,
                        name: `adb-${serial}`,
                    });
                }
            } catch {
                // mDNS track failed — silent; TCP track continues
            }
        })();

        // Track B: TCP (existing pool logic)
        const hostList: string[] = [];
        for (const subnet of subnets) {
            for (const host of subnet.hosts()) hostList.push(host);
        }

        let checked = 0;
        const tcpTimeout = this.deps.tcpTimeoutMs ?? 300;
        const handshakeTimeout = this.deps.handshakeTimeoutMs ?? 2000;

        let cursor = 0;
        const nextHost = (): string | null => {
            if (this.cancelFlag) return null;
            if (cursor >= hostList.length) return null;
            return hostList[cursor++];
        };

        const probeOne = async (host: string): Promise<void> => {
            const address = `${host}:5555`;
            try {
                if (connectedAddresses.has(address)) return;
                if (this.emittedAddresses.has(address)) return; // mDNS already claimed
                const open = await this.deps.tcpProbe(host, 5555, tcpTimeout);
                if (!open) return;
                log.info(`TCP open ${address}`);
                // Raw CNXN handshake — confirms ADB without touching adb server (port 5037).
                const handshake = await this.deps.adbHandshakeProbe(host, 5555, handshakeTimeout);
                log.info(`handshake ${address} -> isAdb=${handshake.isAdb} model=${JSON.stringify(handshake.model)}`);
                if (!handshake.isAdb) return;
                // ARP cache is freshly populated from the TCP + handshake traffic.
                const mac = this.deps.resolveMac ? await this.deps.resolveMac(host) : null;
                log.info(`mac ${address} -> ${mac}`);
                this.emitHit({
                    source: 'tcp',
                    address,
                    serial: address,
                    name: handshake.model ?? '',
                    mac,
                });
            } catch (err) {
                log.info(`probeOne ${address} threw: ${(err as Error).message}`);
            }
        };

        const worker = async (): Promise<void> => {
            for (;;) {
                const host = nextHost();
                if (host === null) return;
                await probeOne(host);
                checked++;
                if (checked % this.deps.progressInterval === 0 || checked === totalHosts) {
                    this.emit({
                        type: 'scan.progress',
                        checked,
                        total: totalHosts,
                        foundSoFar: this.foundSoFar,
                    });
                }
            }
        };

        const workers: Promise<void>[] = [];
        for (let i = 0; i < Math.min(this.deps.concurrency, Math.max(hostList.length, 1)); i++) {
            workers.push(worker());
        }
        await Promise.all([mdnsPromise, ...workers]);
    }

    private emitHit(partial: { source: 'mdns' | 'tcp'; address: string; serial: string; name: string; mac?: string | null; label?: string }): void {
        if (this.emittedAddresses.has(partial.address)) return;
        this.emittedAddresses.add(partial.address);
        this.foundSoFar++;
        // Label precedence: explicit > MAC lookup > serial lookup > ''.
        // MAC-first helps TCP hits (where `serial` is address-as-placeholder);
        // serial-fallback catches mDNS hits (where serial is authoritative).
        let label = partial.label;
        if (label === undefined && this.deps.labelFor) {
            if (partial.mac) label = this.deps.labelFor(partial.mac);
            if (label === undefined) label = this.deps.labelFor(partial.serial);
        }
        this.emit({
            type: 'scan.hit',
            source: partial.source,
            address: partial.address,
            serial: partial.serial,
            name: partial.name,
            label: label ?? '',
        });
    }

    protected emit(msg: ScanServerMessage): void {
        if (msg.type === 'scan.started') {
            this.lastStartedMsg = msg;
        } else if (msg.type === 'scan.progress') {
            this.lastProgressMsg = msg;
        }
        for (const ws of this.spectators) {
            if (ws.readyState !== ws.OPEN) continue;
            try {
                ws.send(JSON.stringify(msg));
            } catch {
                // Dropped spectator — silent
            }
        }
    }
}
