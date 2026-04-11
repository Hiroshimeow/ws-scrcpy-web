import * as portfinder from 'portfinder';
import * as path from 'path';
import { AdbExtended } from './adb';
import { Forward } from '@dead50f7/adbkit/lib/Forward';
import Entry from '@dead50f7/adbkit/lib/adb/sync/entry';
import Stats from '@dead50f7/adbkit/lib/adb/sync/stats';
import PullTransfer from '@dead50f7/adbkit/lib/adb/sync/pulltransfer';
import { FileStats } from '../../types/FileStats';
import Protocol from '@dead50f7/adbkit/lib/adb/protocol';
import { Multiplexer } from '../../packages/multiplexer/Multiplexer';
import { ReadStream } from 'fs';
import PushTransfer from '@dead50f7/adbkit/lib/adb/sync/pushtransfer';

export class AdbUtils {
    private static async formatStatsMin(entry: Entry): Promise<FileStats> {
        return {
            name: entry.name,
            isDir: entry.isDirectory() ? 1 : 0,
            size: entry.size,
            dateModified: entry.mtimeMs ? entry.mtimeMs : entry.mtime.getTime(),
        };
    }

    public static async push(serial: string, stream: ReadStream, pathString: string): Promise<PushTransfer> {
        const client = AdbExtended.createClient();
        const transfer = await client.push(serial, stream, pathString);
        client.on('error', (error: Error) => {
            transfer.emit('error', error);
        });
        return transfer;
    }

    public static async stats(serial: string, pathString: string, stats?: Stats, deep = 0): Promise<Stats> {
        if (!stats || (stats.isSymbolicLink() && pathString.endsWith('/'))) {
            const client = AdbExtended.createClient();
            stats = await client.stat(serial, pathString);
        }
        if (stats.isSymbolicLink()) {
            if (deep === 5) {
                throw Error('Too deep');
            }
            if (!pathString.endsWith('/')) {
                pathString += '/';
            }
            try {
                stats = await this.stats(serial, pathString, stats, deep++);
            } catch (error: any) {
                if (error.message === 'Too deep') {
                    if (deep === 0) {
                        console.error(`Symlink is too deep: ${pathString}`);
                        return stats;
                    }
                    throw error;
                }
                if (error.code !== 'ENOENT') {
                    console.error(error.message);
                }
            }
            return stats;
        }
        return stats;
    }

    public static async readdir(serial: string, pathString: string): Promise<FileStats[]> {
        const client = AdbExtended.createClient();
        const list = await client.readdir(serial, pathString);
        const all = list.map(async (entry) => {
            if (entry.isSymbolicLink()) {
                const stat = await this.stats(serial, path.join(pathString, entry.name));
                const mtime = stat.mtimeMs ? stat.mtimeMs : stat.mtime.getTime();
                entry = new Entry(entry.name, stat.mode, stat.size, (mtime / 1000) | 0);
            }
            return AdbUtils.formatStatsMin(entry);
        });
        return Promise.all(all);
    }

    public static async pipePullFile(serial: string, pathString: string): Promise<PullTransfer> {
        const client = AdbExtended.createClient();
        const transfer = await client.pull(serial, pathString);

        transfer.on('progress', function (stats) {
            console.log('[%s] [%s] Pulled %d bytes so far', serial, pathString, stats.bytesTransferred);
        });
        transfer.on('end', function () {
            console.log('[%s] [%s] Pull complete', serial, pathString);
        });
        return new Promise((resolve, reject) => {
            transfer.on('readable', () => {
                resolve(transfer);
            });
            transfer.on('error', (e) => {
                reject(e);
            });
        });
    }

    public static async pipeStatToStream(serial: string, pathString: string, stream: Multiplexer): Promise<void> {
        const client = AdbExtended.createClient();
        return client.pipeStat(serial, pathString, stream);
    }

    public static async pipeReadDirToStream(serial: string, pathString: string, stream: Multiplexer): Promise<void> {
        const client = AdbExtended.createClient();
        return client.pipeReadDir(serial, pathString, stream);
    }

    public static async pipePullFileToStream(serial: string, pathString: string, stream: Multiplexer): Promise<void> {
        const client = AdbExtended.createClient();
        const transfer = await client.pull(serial, pathString);
        transfer.on('data', (data) => {
            stream.send(Buffer.concat([Buffer.from(Protocol.DATA, 'ascii'), data]));
        });
        return new Promise((resolve, reject) => {
            transfer.on('end', function () {
                stream.send(Buffer.from(Protocol.DONE, 'ascii'));
                stream.close();
                resolve();
            });
            transfer.on('error', (e) => {
                reject(e);
            });
        });
    }

    public static async forward(serial: string, remote: string): Promise<number> {
        const client = AdbExtended.createClient();
        const forwards = await client.listForwards(serial);
        const forward = forwards.find((item: Forward) => {
            return item.remote === remote && item.local.startsWith('tcp:') && item.serial === serial;
        });
        if (forward) {
            const { local } = forward;
            return parseInt(local.split('tcp:')[1], 10);
        }
        const port = await portfinder.getPortPromise();
        const local = `tcp:${port}`;
        await client.forward(serial, local, remote);
        return port;
    }

    public static async getDeviceName(serial: string): Promise<string> {
        const client = AdbExtended.createClient();
        const props = await client.getProperties(serial);
        return props['ro.product.model'] || 'Unknown device';
    }
}
