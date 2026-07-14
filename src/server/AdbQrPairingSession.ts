import { randomBytes as nodeRandomBytes } from 'crypto';
import type { AdbClient } from './AdbClient';
import { assertTailscaleQrHost } from './security/deviceInput';
import { scanTcpPorts, type TcpPortScanOptions } from './TailscalePortScanner';

export type AdbQrPairingMode = 'lan' | 'tailscale';
export type AdbQrPairingState =
    | 'waiting'
    | 'scanning'
    | 'pairing'
    | 'connecting'
    | 'complete'
    | 'failed'
    | 'expired'
    | 'cancelled';

export interface AdbQrPairingStatus {
    id: string;
    state: AdbQrPairingState;
    mode: AdbQrPairingMode;
    message: string;
    expiresAt: number;
    host?: string;
    address?: string;
}

export interface StartedAdbQrPairing extends AdbQrPairingStatus {
    payload: string;
    serviceName: string;
    password: string;
}

export interface StartAdbQrPairingOptions {
    mode?: AdbQrPairingMode;
    host?: string;
}

type QrPairingAdb = Pick<AdbClient, 'mdnsServices' | 'pairQr' | 'connect'>;
type ScanPorts = (host: string, options: TcpPortScanOptions) => Promise<number[]>;

interface Session extends StartedAdbQrPairing {
    abortController: AbortController;
    paired: boolean;
    pairPort?: number;
    pairAttempts: Map<number, number>;
    connectAttempts: Map<number, number>;
}

interface Options {
    now?: () => number;
    randomBytes?: (size: number) => Buffer;
    setInterval?: (callback: () => void, ms: number) => NodeJS.Timeout;
    clearInterval?: (handle: NodeJS.Timeout) => void;
    ttlMs?: number;
    tailscaleTtlMs?: number;
    pollIntervalMs?: number;
    scanPorts?: ScanPorts;
}

const DEFAULT_TTL_MS = 120_000;
const DEFAULT_TAILSCALE_TTL_MS = 180_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const REMOTE_PAIR_TIMEOUT_MS = 6_000;
const REMOTE_CONNECT_TIMEOUT_MS = 5_000;
const MAX_PAIR_ATTEMPTS_PER_PORT = 3;
const MAX_CONNECT_ATTEMPTS_PER_PORT = 3;
const PAIRING_SERVICE = '_adb-tls-pairing._tcp';

function token(bytes: number, randomBytes: (size: number) => Buffer): string {
    return randomBytes(bytes).toString('base64url');
}

function publicStatus(session: Session): AdbQrPairingStatus {
    return {
        id: session.id,
        state: session.state,
        mode: session.mode,
        message: session.message,
        expiresAt: session.expiresAt,
        ...(session.host ? { host: session.host } : {}),
        ...(session.address ? { address: session.address } : {}),
    };
}

function startedCopy(session: Session): StartedAdbQrPairing {
    return {
        ...publicStatus(session),
        payload: session.payload,
        serviceName: session.serviceName,
        password: session.password,
    };
}

function pairSucceeded(output: string): boolean {
    return /(?:successfully|already) paired/i.test(output);
}

function connectSucceeded(output: string): boolean {
    return /(?:already )?connected to/i.test(output);
}

function isTerminal(state: AdbQrPairingState): boolean {
    return state === 'complete' || state === 'failed' || state === 'expired' || state === 'cancelled';
}

export class AdbQrPairingSessionManager {
    private readonly now: () => number;
    private readonly randomBytes: (size: number) => Buffer;
    private readonly clearIntervalFn: (handle: NodeJS.Timeout) => void;
    private readonly ttlMs: number;
    private readonly tailscaleTtlMs: number;
    private readonly scanPorts: ScanPorts;
    private readonly timer: NodeJS.Timeout;
    private current: Session | undefined;
    private polling = false;

    constructor(
        private readonly adb: QrPairingAdb,
        options: Options = {},
    ) {
        this.now = options.now ?? Date.now;
        this.randomBytes = options.randomBytes ?? nodeRandomBytes;
        this.clearIntervalFn = options.clearInterval ?? clearInterval;
        this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
        this.tailscaleTtlMs = options.tailscaleTtlMs ?? DEFAULT_TAILSCALE_TTL_MS;
        this.scanPorts = options.scanPorts ?? scanTcpPorts;
        const setIntervalFn: (callback: () => void, ms: number) => NodeJS.Timeout =
            options.setInterval ?? ((callback, ms) => globalThis.setInterval(callback, ms) as NodeJS.Timeout);
        this.timer = setIntervalFn(() => void this.pollNow(), options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
        this.timer.unref?.();
    }

    start(options: StartAdbQrPairingOptions = {}): StartedAdbQrPairing {
        this.clearCurrentSecret();
        const mode = options.mode ?? 'lan';
        const host = mode === 'tailscale' ? assertTailscaleQrHost(options.host) : undefined;

        const serviceName = `studio-wssw-${token(8, this.randomBytes)}`;
        const password = token(12, this.randomBytes);
        const now = this.now();
        const session: Session = {
            id: token(16, this.randomBytes),
            state: 'waiting',
            mode,
            message:
                mode === 'tailscale'
                    ? 'Scan the QR code on Android. Searching the Tailscale endpoint…'
                    : 'Waiting for Android to scan the QR code…',
            expiresAt: now + (mode === 'tailscale' ? this.tailscaleTtlMs : this.ttlMs),
            ...(host ? { host } : {}),
            serviceName,
            password,
            payload: `WIFI:T:ADB;S:${serviceName};P:${password};;`,
            abortController: new AbortController(),
            paired: false,
            pairAttempts: new Map<number, number>(),
            connectAttempts: new Map<number, number>(),
        };
        this.current = session;
        return startedCopy(session);
    }

    getStatus(id: string): AdbQrPairingStatus | null {
        const session = this.current;
        if (!session || session.id !== id) return null;
        this.expireIfNeeded(session);
        return publicStatus(session);
    }

    cancel(id: string): boolean {
        const session = this.current;
        if (!session || session.id !== id || isTerminal(session.state)) return false;
        this.finish(session, 'cancelled', 'QR pairing cancelled.');
        return true;
    }

    async pollNow(): Promise<void> {
        const session = this.current;
        if (!session || this.polling || isTerminal(session.state)) return;
        if (this.expireIfNeeded(session)) return;

        this.polling = true;
        try {
            if (session.mode === 'tailscale') await this.pollTailscale(session);
            else await this.pollLan(session);
        } finally {
            this.polling = false;
        }
    }

    dispose(): void {
        this.clearIntervalFn(this.timer);
        this.clearCurrentSecret();
        this.current = undefined;
    }

    private async pollLan(session: Session): Promise<void> {
        let services;
        try {
            services = await this.adb.mdnsServices();
        } catch {
            return;
        }
        if (!this.isCurrentActive(session) || session.state !== 'waiting') return;
        if (this.expireIfNeeded(session)) return;

        const match = services.find(
            (service) => service.name === session.serviceName && service.service.replace(/\.$/, '') === PAIRING_SERVICE,
        );
        if (!match) return;

        session.state = 'pairing';
        session.message = 'Phone found. Pairing with ADB…';
        const password = session.password;
        try {
            const output = await this.adb.pairQr(`${match.address}:${match.port}`, password);
            if (!this.isCurrentActive(session) || session.state !== 'pairing') return;
            if (!pairSucceeded(output)) {
                this.finish(session, 'failed', 'ADB did not confirm QR pairing. Generate a new QR code and retry.');
                return;
            }
            this.finish(session, 'complete', 'Paired successfully. The phone should connect automatically.');
        } catch {
            if (this.isCurrentActive(session)) {
                this.finish(session, 'failed', 'QR pairing failed. Generate a new QR code and retry.');
            }
        }
    }

    private async pollTailscale(session: Session): Promise<void> {
        const host = session.host;
        if (!host) {
            this.finish(session, 'failed', 'Tailscale QR target is missing.');
            return;
        }

        session.state = session.paired ? 'connecting' : 'scanning';
        session.message = session.paired
            ? 'Paired. Searching for Android’s secure ADB connection over Tailscale…'
            : 'Scanning the Android Tailscale IP for the temporary pairing endpoint…';

        let openPorts: number[];
        try {
            openPorts = await this.scanPorts(host, { signal: session.abortController.signal });
        } catch (error) {
            if ((error as Error).name === 'AbortError' || !this.isCurrentActive(session)) return;
            this.finish(
                session,
                'failed',
                'Could not scan the Tailscale target. Verify the address and generate a new QR code.',
            );
            return;
        }
        if (!this.isCurrentActive(session) || this.expireIfNeeded(session)) return;

        if (!session.paired) {
            const candidates = openPorts.filter(
                (port) => (session.pairAttempts.get(port) ?? 0) < MAX_PAIR_ATTEMPTS_PER_PORT,
            );
            for (const port of candidates) {
                if (!this.isCurrentActive(session)) return;
                session.pairAttempts.set(port, (session.pairAttempts.get(port) ?? 0) + 1);
                session.state = 'pairing';
                session.message = 'Potential Android pairing endpoint found. Pairing with ADB…';
                try {
                    const output = await this.adb.pairQr(`${host}:${port}`, session.password, REMOTE_PAIR_TIMEOUT_MS);
                    if (!this.isCurrentActive(session)) return;
                    if (pairSucceeded(output)) {
                        session.paired = true;
                        session.pairPort = port;
                        break;
                    }
                } catch {
                    // Open high ports may belong to another service. Continue until
                    // the endpoint created by the scanned QR password is found.
                }
            }
            if (!session.paired) {
                session.state = 'waiting';
                session.message =
                    openPorts.length === 0
                        ? 'Waiting for Android to open the QR pairing endpoint over Tailscale…'
                        : 'Open ports found, but not the QR pairing endpoint yet. Retrying…';
                return;
            }
        }

        session.state = 'connecting';
        session.message = 'Paired. Connecting to Android over Tailscale…';
        const connectCandidates = openPorts.filter((port) => port !== session.pairPort);
        for (const port of connectCandidates) {
            if (!this.isCurrentActive(session)) return;
            const attempts = session.connectAttempts.get(port) ?? 0;
            if (attempts >= MAX_CONNECT_ATTEMPTS_PER_PORT) continue;
            session.connectAttempts.set(port, attempts + 1);
            const address = `${host}:${port}`;
            try {
                const output = await this.adb.connect(address, REMOTE_CONNECT_TIMEOUT_MS);
                if (!this.isCurrentActive(session)) return;
                if (connectSucceeded(output)) {
                    session.address = address;
                    this.finish(session, 'complete', `Paired and connected over Tailscale at ${address}.`);
                    return;
                }
            } catch {
                // Retry after the next bounded port scan; Android may advertise the
                // secure-connect socket shortly after the pairing exchange finishes.
            }
        }
        if (this.isCurrentActive(session)) {
            session.state = 'connecting';
            session.message = 'Paired. Waiting for Android’s secure ADB connection port…';
        }
    }

    private isCurrentActive(session: Session): boolean {
        return this.current === session && !isTerminal(session.state);
    }

    private expireIfNeeded(session: Session): boolean {
        if (!isTerminal(session.state) && this.now() >= session.expiresAt) {
            this.finish(
                session,
                'expired',
                session.mode === 'tailscale'
                    ? 'Tailscale QR pairing expired. Confirm the phone is online and generate a new QR code.'
                    : 'QR code expired. Generate a new one.',
            );
            return true;
        }
        return session.state === 'expired';
    }

    private finish(session: Session, state: AdbQrPairingState, message: string): void {
        session.state = state;
        session.message = message;
        session.abortController.abort();
        session.password = '';
        session.payload = '';
    }

    private clearCurrentSecret(): void {
        if (!this.current) return;
        this.current.abortController.abort();
        this.current.password = '';
        this.current.payload = '';
    }
}
