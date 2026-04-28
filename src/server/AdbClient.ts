import { type ChildProcess, execFile, spawn } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface AdbDevice {
    serial: string;
    state: string;
}

export interface MdnsDevice {
    name: string;
    service: string;
    address: string;
    port: number;
}

export type AdbExecErrorKind = 'timeout' | 'spawn' | 'exit' | 'unknown';

/**
 * Typed error thrown by AdbClient on any failure path. Carries the resolved
 * adb path and the args so log readers can spot wrong-binary or timing
 * issues without grepping the stack.
 */
export class AdbExecError extends Error {
    constructor(
        public readonly kind: AdbExecErrorKind,
        public readonly adbPath: string,
        public readonly args: readonly string[],
        public readonly cause?: unknown,
    ) {
        const argsPreview = args.join(' ');
        const causeMsg = cause instanceof Error ? cause.message : cause !== undefined ? String(cause) : '';
        const detail = causeMsg ? ` — ${causeMsg}` : '';
        super(`adb ${kind} (path=${adbPath}, args="${argsPreview}")${detail}`);
        this.name = 'AdbExecError';
    }
}

interface AdbExecOptions {
    /** Hard timeout in ms. 0 / undefined = unbounded. */
    timeoutMs?: number;
}

// Default timeouts for short-lived control-plane commands. Anything not on
// this list (push/pull, arbitrary shell) stays unbounded — caller decides.
const DEFAULT_TIMEOUT_MS = {
    devices: 5_000,
    mdnsServices: 8_000,
    connect: 8_000,
    disconnect: 5_000,
    forwardOps: 5_000,
} as const;

export function parseMdnsOutput(output: string): MdnsDevice[] {
    const results: MdnsDevice[] = [];
    for (const line of output.split('\n')) {
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        const [name, service, addressPort] = parts;
        const colonIdx = addressPort.lastIndexOf(':');
        if (colonIdx === -1) continue;
        const address = addressPort.substring(0, colonIdx);
        const port = parseInt(addressPort.substring(colonIdx + 1), 10);
        if (isNaN(port)) continue;
        results.push({ name: name.trim(), service: service.trim(), address, port });
    }
    return results;
}

export function parseSerialFromMdnsName(name: string, service: string): string {
    // Strip 'adb-' prefix
    let serial = name.startsWith('adb-') ? name.slice(4) : name;
    // For TLS connect services, strip the instance suffix (last -segment, 6-8 alphanumeric chars)
    if (service.includes('tls-connect') && serial.includes('-')) {
        serial = serial.substring(0, serial.lastIndexOf('-'));
    }
    return serial;
}

export class AdbClient {
    /**
     * `adbPath` is required. Callers MUST pass `Config.getInstance().adbPath`
     * (or an explicit override). The previous default of `'adb'` masked
     * packaging bugs by silently falling through to whatever adb happened
     * to be on the system PATH.
     */
    constructor(public readonly adbPath: string) {}

    private async exec(args: string[], opts: AdbExecOptions = {}): Promise<string> {
        const execOpts: { maxBuffer: number; timeout?: number; killSignal?: NodeJS.Signals } = {
            maxBuffer: 10 * 1024 * 1024,
        };
        if (opts.timeoutMs && opts.timeoutMs > 0) {
            execOpts.timeout = opts.timeoutMs;
            execOpts.killSignal = 'SIGKILL';
        }
        try {
            const { stdout } = await execFileAsync(this.adbPath, args, execOpts);
            return stdout;
        } catch (err) {
            const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: string | number };
            if (e?.killed && (e.signal === 'SIGKILL' || e.signal === 'SIGTERM')) {
                throw new AdbExecError('timeout', this.adbPath, args, err);
            }
            if (e?.code === 'ENOENT' || e?.code === 'EACCES') {
                throw new AdbExecError('spawn', this.adbPath, args, err);
            }
            if (typeof e?.code === 'number') {
                throw new AdbExecError('exit', this.adbPath, args, err);
            }
            throw new AdbExecError('unknown', this.adbPath, args, err);
        }
    }

    async devices(): Promise<AdbDevice[]> {
        const output = await this.exec(['devices'], { timeoutMs: DEFAULT_TIMEOUT_MS.devices });
        return output
            .split('\n')
            .slice(1) // skip "List of devices attached" header
            .filter((line) => line.trim().length > 0)
            .map((line) => {
                const [serial, state] = line.trim().split(/\s+/);
                return { serial, state };
            });
    }

    async shell(serial: string, command: string): Promise<string> {
        const { stdout } = await execFileAsync(this.adbPath, ['-s', serial, 'shell', command], {
            maxBuffer: 10 * 1024 * 1024,
        });
        return stdout.trim();
    }

    async push(serial: string, local: string, remote: string): Promise<void> {
        await this.exec(['-s', serial, 'push', local, remote]);
    }

    async pull(serial: string, remote: string, local: string): Promise<void> {
        await this.exec(['-s', serial, 'pull', remote, local]);
    }

    async forward(serial: string, local: string, remote: string): Promise<void> {
        await this.exec(['-s', serial, 'forward', local, remote], { timeoutMs: DEFAULT_TIMEOUT_MS.forwardOps });
    }

    async listForwards(serial: string): Promise<{ serial: string; local: string; remote: string }[]> {
        const output = await this.exec(['-s', serial, 'forward', '--list'], { timeoutMs: DEFAULT_TIMEOUT_MS.forwardOps });
        return output
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .map((line) => {
                const [serial, local, remote] = line.trim().split(/\s+/);
                return { serial, local, remote };
            });
    }

    async removeForward(serial: string, local: string): Promise<void> {
        await this.exec(['-s', serial, 'forward', '--remove', local], { timeoutMs: DEFAULT_TIMEOUT_MS.forwardOps });
    }

    async reverse(serial: string, remote: string, local: string): Promise<void> {
        await this.exec(['-s', serial, 'reverse', remote, local], { timeoutMs: DEFAULT_TIMEOUT_MS.forwardOps });
    }

    async removeReverse(serial: string, remote: string): Promise<void> {
        await this.exec(['-s', serial, 'reverse', '--remove', remote], { timeoutMs: DEFAULT_TIMEOUT_MS.forwardOps });
    }

    async getProperties(serial: string): Promise<Record<string, string>> {
        const output = await this.shell(serial, 'getprop');
        const props: Record<string, string> = {};
        const regex = /\[(.+?)\]: \[(.*)]/g;
        let match;
        while ((match = regex.exec(output)) !== null) {
            props[match[1]] = match[2];
        }
        return props;
    }

    /** Long-running shell command using spawn (doesn't wait for completion) */
    shellSpawn(serial: string, command: string): ChildProcess {
        return spawn(this.adbPath, ['-s', serial, 'shell', command], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    }

    /**
     * Returns mDNS-discovered services. Throws AdbExecError on failure
     * (timeout, ENOENT, non-zero exit). Callers wanting silent degradation
     * must wrap. Previously this swallowed errors and returned [], which
     * masked packaging bugs (notably bare 'adb' falling through to whatever
     * adb happened to be on the system PATH).
     */
    async mdnsServices(): Promise<MdnsDevice[]> {
        const output = await this.exec(['mdns', 'services'], { timeoutMs: DEFAULT_TIMEOUT_MS.mdnsServices });
        return parseMdnsOutput(output);
    }

    async connect(address: string): Promise<string> {
        return this.exec(['connect', address], { timeoutMs: DEFAULT_TIMEOUT_MS.connect });
    }

    async disconnect(address: string): Promise<string> {
        return this.exec(['disconnect', address], { timeoutMs: DEFAULT_TIMEOUT_MS.disconnect });
    }
}
