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

export class AdbClient {
    constructor(private adbPath = 'adb') {}

    private async exec(args: string[]): Promise<string> {
        const { stdout } = await execFileAsync(this.adbPath, args, { maxBuffer: 10 * 1024 * 1024 });
        return stdout;
    }

    async devices(): Promise<AdbDevice[]> {
        const output = await this.exec(['devices']);
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
        await this.exec(['-s', serial, 'forward', local, remote]);
    }

    async listForwards(serial: string): Promise<{ serial: string; local: string; remote: string }[]> {
        const output = await this.exec(['-s', serial, 'forward', '--list']);
        return output
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .map((line) => {
                const [serial, local, remote] = line.trim().split(/\s+/);
                return { serial, local, remote };
            });
    }

    async removeForward(serial: string, local: string): Promise<void> {
        await this.exec(['-s', serial, 'forward', '--remove', local]);
    }

    async reverse(serial: string, remote: string, local: string): Promise<void> {
        await this.exec(['-s', serial, 'reverse', remote, local]);
    }

    async removeReverse(serial: string, remote: string): Promise<void> {
        await this.exec(['-s', serial, 'reverse', '--remove', remote]);
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

    async mdnsServices(): Promise<MdnsDevice[]> {
        try {
            const output = await this.exec(['mdns', 'services']);
            return parseMdnsOutput(output);
        } catch {
            return [];
        }
    }

    async connect(address: string): Promise<string> {
        return this.exec(['connect', address]);
    }

    async disconnect(address: string): Promise<string> {
        return this.exec(['disconnect', address]);
    }
}
