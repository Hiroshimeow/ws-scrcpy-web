import { randomBytes as nodeRandomBytes } from 'crypto';
import type { AdbClient } from './AdbClient';

export type AdbQrPairingState = 'waiting' | 'pairing' | 'complete' | 'failed' | 'expired' | 'cancelled';

export interface AdbQrPairingStatus {
    id: string;
    state: AdbQrPairingState;
    message: string;
    expiresAt: number;
}

export interface StartedAdbQrPairing extends AdbQrPairingStatus {
    payload: string;
    serviceName: string;
    password: string;
}

type QrPairingAdb = Pick<AdbClient, 'mdnsServices' | 'pairQr'>;

interface Session extends StartedAdbQrPairing {}

interface Options {
    now?: () => number;
    randomBytes?: (size: number) => Buffer;
    setInterval?: (callback: () => void, ms: number) => NodeJS.Timeout;
    clearInterval?: (handle: NodeJS.Timeout) => void;
    ttlMs?: number;
    pollIntervalMs?: number;
}

const DEFAULT_TTL_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const PAIRING_SERVICE = '_adb-tls-pairing._tcp';

function token(bytes: number, randomBytes: (size: number) => Buffer): string {
    return randomBytes(bytes).toString('base64url');
}

function publicStatus(session: Session): AdbQrPairingStatus {
    return {
        id: session.id,
        state: session.state,
        message: session.message,
        expiresAt: session.expiresAt,
    };
}

function pairSucceeded(output: string): boolean {
    return /(?:successfully|already) paired/i.test(output);
}

function isTerminal(state: AdbQrPairingState): boolean {
    return state === 'complete' || state === 'failed' || state === 'expired' || state === 'cancelled';
}

export class AdbQrPairingSessionManager {
    private readonly now: () => number;
    private readonly randomBytes: (size: number) => Buffer;
    private readonly clearIntervalFn: (handle: NodeJS.Timeout) => void;
    private readonly ttlMs: number;
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
        const setIntervalFn: (callback: () => void, ms: number) => NodeJS.Timeout =
            options.setInterval ?? ((callback, ms) => globalThis.setInterval(callback, ms) as NodeJS.Timeout);
        this.timer = setIntervalFn(() => void this.pollNow(), options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
        this.timer.unref?.();
    }

    start(): StartedAdbQrPairing {
        this.clearCurrentSecret();
        const serviceName = `studio-wssw-${token(8, this.randomBytes)}`;
        const password = token(12, this.randomBytes);
        const now = this.now();
        this.current = {
            id: token(16, this.randomBytes),
            state: 'waiting',
            message: 'Waiting for Android to scan the QR code…',
            expiresAt: now + this.ttlMs,
            serviceName,
            password,
            payload: `WIFI:T:ADB;S:${serviceName};P:${password};;`,
        };
        return { ...this.current };
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
            let services;
            try {
                services = await this.adb.mdnsServices();
            } catch {
                return;
            }
            if (this.current !== session || session.state !== 'waiting') return;
            if (this.expireIfNeeded(session)) return;

            const match = services.find(
                (service) =>
                    service.name === session.serviceName && service.service.replace(/\.$/, '') === PAIRING_SERVICE,
            );
            if (!match) return;

            session.state = 'pairing';
            session.message = 'Phone found. Pairing with ADB…';
            const password = session.password;
            try {
                const output = await this.adb.pairQr(`${match.address}:${match.port}`, password);
                if (this.current !== session || session.state !== 'pairing') return;
                if (!pairSucceeded(output)) {
                    this.finish(session, 'failed', 'ADB did not confirm QR pairing. Generate a new QR code and retry.');
                    return;
                }
                this.finish(session, 'complete', 'Paired successfully. The phone should connect automatically.');
            } catch {
                if (this.current === session) {
                    this.finish(session, 'failed', 'QR pairing failed. Generate a new QR code and retry.');
                }
            }
        } finally {
            this.polling = false;
        }
    }

    dispose(): void {
        this.clearIntervalFn(this.timer);
        this.clearCurrentSecret();
        this.current = undefined;
    }

    private expireIfNeeded(session: Session): boolean {
        if (!isTerminal(session.state) && this.now() >= session.expiresAt) {
            this.finish(session, 'expired', 'QR code expired. Generate a new one.');
            return true;
        }
        return session.state === 'expired';
    }

    private finish(session: Session, state: AdbQrPairingState, message: string): void {
        session.state = state;
        session.message = message;
        session.password = '';
        session.payload = '';
    }

    private clearCurrentSecret(): void {
        if (!this.current) return;
        this.current.password = '';
        this.current.payload = '';
    }
}
