import type WS from 'ws';
import type { ParsedSubnet } from '../../common/SubnetParser';
import type { ScanServerMessage } from '../../common/ScanMessage';

export interface NetworkScannerDeps {
    adbDevices: () => Promise<{ serial: string; state: string }[]>;
    adbMdnsServices: () => Promise<{ name: string; service: string; address: string; port: number }[]>;
    adbConnect: (address: string) => Promise<string>;
    adbDisconnect: (address: string) => Promise<string>;
    tcpProbe: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
    concurrency: number;
    progressInterval: number;
    tcpTimeoutMs?: number;
    adbConnectTimeoutMs?: number;
}

type State = 'idle' | 'scanning' | 'draining';

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export class NetworkScanner {
    private state: State = 'idle';
    private cancelFlag = false;
    private spectators = new Set<WS | any>();
    private emittedAddresses = new Set<string>();
    private foundSoFar = 0;

    constructor(private readonly deps: NetworkScannerDeps) {}

    isScanning(): boolean {
        return this.state !== 'idle';
    }

    attachSpectator(ws: WS | any): void {
        if (this.state === 'idle') return;
        this.spectators.add(ws);
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
        this.spectators.clear();
        this.spectators.add(ws);

        try {
            const totalHosts = subnets.reduce((sum, s) => sum + s.hostCount, 0);
            this.emit({
                type: 'scan.started',
                totalHosts,
                totalSubnets: subnets.length,
                startedAt: Date.now(),
            });

            await this.runTracks(subnets, totalHosts);

            if (this.cancelFlag) {
                this.state = 'draining';
                this.emit({ type: 'scan.draining' });
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

        // mDNS track handled in Task 6.
        // TCP track:
        const hostList: string[] = [];
        for (const subnet of subnets) {
            for (const host of subnet.hosts()) hostList.push(host);
        }

        let checked = 0;
        const tcpTimeout = this.deps.tcpTimeoutMs ?? 300;
        const adbTimeout = this.deps.adbConnectTimeoutMs ?? 3000;

        const workers: Promise<void>[] = [];
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
                const open = await this.deps.tcpProbe(host, 5555, tcpTimeout);
                if (!open) return;
                const connectOutput = await withTimeout(this.deps.adbConnect(address), adbTimeout);
                if (!connectOutput.toLowerCase().includes('connected')) return;
                await withTimeout(this.deps.adbDisconnect(address), 2000).catch(() => {});
                this.emitHit({
                    source: 'tcp',
                    address,
                    serial: address,
                    name: address,
                });
            } catch {
                // Silent probe failure
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

        for (let i = 0; i < Math.min(this.deps.concurrency, hostList.length); i++) {
            workers.push(worker());
        }
        await Promise.all(workers);
    }

    private emitHit(partial: { source: 'mdns' | 'tcp'; address: string; serial: string; name: string; label?: string }): void {
        if (this.emittedAddresses.has(partial.address)) return;
        this.emittedAddresses.add(partial.address);
        this.foundSoFar++;
        this.emit({
            type: 'scan.hit',
            source: partial.source,
            address: partial.address,
            serial: partial.serial,
            name: partial.name,
            label: partial.label ?? '',
        });
    }

    protected emit(msg: ScanServerMessage): void {
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
