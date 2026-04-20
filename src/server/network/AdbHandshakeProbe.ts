// Raw ADB protocol CNXN handshake probe. Opens a TCP socket to host:port,
// writes a CNXN packet, reads back the device's CNXN (or AUTH) reply, and
// returns whether the endpoint is genuinely speaking ADB plus the device's
// model string extracted from the banner. The adb server (on port 5037) is
// never involved — this is pure socket protocol, no state mutation.

import * as net from 'net';
import * as zlib from 'zlib';

const A_CNXN = 0x4e584e43; // "CNXN"
const A_AUTH = 0x48545541; // "AUTH"
const A_CNXN_MAGIC = (A_CNXN ^ 0xffffffff) >>> 0;
const A_AUTH_MAGIC = (A_AUTH ^ 0xffffffff) >>> 0;
const ADB_VERSION = 0x01000000; // protocol version 1 — widest compatibility
const ADB_MAX_DATA = 0x00040000; // 256KB max payload
const HEADER_SIZE = 24;
const HOST_BANNER = Buffer.from('host::features=shell_v2\0', 'utf8');

export interface AdbHandshakeResult {
    isAdb: boolean;
    model?: string;
}

export function buildCnxnPacket(): Buffer {
    const payload = HOST_BANNER;
    const header = Buffer.alloc(HEADER_SIZE);
    header.writeUInt32LE(A_CNXN, 0);
    header.writeUInt32LE(ADB_VERSION, 4);
    header.writeUInt32LE(ADB_MAX_DATA, 8);
    header.writeUInt32LE(payload.length, 12);
    header.writeUInt32LE(zlib.crc32(payload), 16);
    header.writeUInt32LE(A_CNXN_MAGIC, 20);
    return Buffer.concat([header, payload]);
}

export function parseCnxnReply(buf: Buffer): AdbHandshakeResult {
    if (buf.length < HEADER_SIZE) return { isAdb: false };
    const command = buf.readUInt32LE(0);
    const dataLen = buf.readUInt32LE(12);
    const magic = buf.readUInt32LE(20);

    if (command === A_CNXN) {
        if (magic !== A_CNXN_MAGIC) return { isAdb: false };
        if (buf.length < HEADER_SIZE + dataLen) return { isAdb: false };
        const banner = buf.slice(HEADER_SIZE, HEADER_SIZE + dataLen).toString('utf8').replace(/\0+$/, '');
        return { isAdb: true, model: extractModel(banner) };
    }
    if (command === A_AUTH) {
        if (magic !== A_AUTH_MAGIC) return { isAdb: false };
        // Device requires RSA auth; we still know it's ADB, just no banner yet.
        return { isAdb: true };
    }
    return { isAdb: false };
}

function extractModel(banner: string): string | undefined {
    // Banner shape: "device::key=val;key=val;..."
    const sepIdx = banner.indexOf('::');
    if (sepIdx === -1) return undefined;
    const props = banner.slice(sepIdx + 2);
    let model: string | undefined;
    let name: string | undefined;
    for (const pair of props.split(';')) {
        const eq = pair.indexOf('=');
        if (eq === -1) continue;
        const key = pair.slice(0, eq).trim();
        const val = pair.slice(eq + 1).trim();
        if (key === 'ro.product.model') model = val;
        else if (key === 'ro.product.name') name = val;
    }
    const raw = model || name;
    if (!raw) return undefined;
    return dedupModel(raw);
}

export function dedupModel(s: string): string {
    const trimmed = s.trim();
    if (!trimmed) return '';
    // Full-string duplicate: "X X" where X may contain spaces.
    // Works when length is odd and the midpoint is a space separating two equal halves.
    const mid = Math.floor(trimmed.length / 2);
    if (trimmed.length % 2 === 1 && trimmed[mid] === ' ') {
        const left = trimmed.slice(0, mid);
        const right = trimmed.slice(mid + 1);
        if (left === right) return left;
    }
    // Adjacent duplicate words: "Google Google Chromecast" → "Google Chromecast"
    return trimmed.replace(/\b(\w[\w-]*)(\s+\1\b)+/gi, '$1');
}

export function probeAdb(host: string, port: number, timeoutMs: number): Promise<AdbHandshakeResult> {
    return new Promise<AdbHandshakeResult>((resolve) => {
        const socket = new net.Socket();
        const chunks: Buffer[] = [];
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const done = (result: AdbHandshakeResult): void => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            try { socket.destroy(); } catch { /* ignore */ }
            resolve(result);
        };
        // Manual timer rather than socket.setTimeout — reliable regardless of
        // socket state (half-closed, idle, etc.).
        timer = setTimeout(() => done({ isAdb: false }), timeoutMs);
        socket.once('error', () => done({ isAdb: false }));
        socket.once('end', () => done(parseCnxnReply(Buffer.concat(chunks))));
        socket.once('close', () => done(parseCnxnReply(Buffer.concat(chunks))));
        socket.on('data', (chunk) => {
            chunks.push(chunk);
            const all = Buffer.concat(chunks);
            if (all.length >= HEADER_SIZE) {
                const dataLen = all.readUInt32LE(12);
                if (all.length >= HEADER_SIZE + dataLen) {
                    done(parseCnxnReply(all));
                }
            }
        });
        socket.once('connect', () => {
            socket.write(buildCnxnPacket());
        });
        socket.connect(port, host);
    });
}
