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

    // Scaffold stub — Task 5 implements TCP probe pool + adb-confirm; Task 6 adds mDNS track.
    protected async runTracks(_subnets: ParsedSubnet[], _totalHosts: number): Promise<void> {
        // No-op scaffold. Tasks 5/6 will replace this body.
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
