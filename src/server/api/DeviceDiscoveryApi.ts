import type { IncomingMessage, ServerResponse } from 'http';
import { AdbClient, parseSerialFromMdnsName, redactPairingCode } from '../AdbClient';
import { AdbQrPairingSessionManager, type AdbQrPairingStatus, type StartedAdbQrPairing } from '../AdbQrPairingSession';
import { resolveUserId } from '../auth/currentUser';
import { Config } from '../Config';
import { Logger } from '../Logger';
import { resolveMac } from '../network/MacResolver';
import { detectSubnet } from '../network/SubnetDetector';
import { renderQrSvg } from '../QrCodeRenderer';
import {
    assertAdbNetworkAddress,
    assertAdbPairingCode,
    assertDeletablePaths,
    assertTailscaleQrHost,
    shArg,
} from '../security/deviceInput';
import { upsertObservedDevices } from './deviceObserved';
import { BodyTooLargeError, InvalidJsonError, readJsonBodyStrict, sendInternalError } from './utils';

const log = Logger.for('DeviceDiscoveryApi');

type DiscoveryAdbClient = Pick<
    AdbClient,
    'mdnsServices' | 'devices' | 'pair' | 'pairQr' | 'connect' | 'disconnect' | 'shell'
>;
type QrPairingSessions = Pick<AdbQrPairingSessionManager, 'start' | 'getStatus' | 'cancel'>;
type QrRenderer = (payload: string) => Promise<string>;

function pairSucceeded(output: string): boolean {
    return /(?:successfully|already) paired/i.test(output);
}

function connectSucceeded(output: string): boolean {
    return /(?:already )?connected to/i.test(output);
}

export class DeviceDiscoveryApi {
    private adbClient: DiscoveryAdbClient;
    private qrPairing: QrPairingSessions;
    private renderQr: QrRenderer;

    constructor(adbClient?: DiscoveryAdbClient, qrPairing?: QrPairingSessions, renderQr: QrRenderer = renderQrSvg) {
        this.adbClient = adbClient ?? new AdbClient(Config.getInstance().adbPath);
        this.qrPairing = qrPairing ?? new AdbQrPairingSessionManager(this.adbClient);
        this.renderQr = renderQr;
    }

    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const url = req.url || '';
        if (!url.startsWith('/api/devices')) return false;

        res.setHeader('Content-Type', 'application/json');

        try {
            const parsedUrl = new URL(url, 'http://localhost');
            if (parsedUrl.pathname === '/api/devices/pair/qr') {
                res.setHeader('Cache-Control', 'no-store');
                const id = parsedUrl.searchParams.get('id')?.trim() ?? '';

                if (req.method === 'POST') {
                    const body = await readJsonBodyStrict<{ mode?: unknown; host?: unknown }>(req);
                    const mode = body.mode ?? 'lan';
                    if (mode !== 'lan' && mode !== 'tailscale') {
                        res.writeHead(400);
                        res.end(JSON.stringify({ error: 'QR pairing mode must be lan or tailscale' }));
                        return true;
                    }

                    let session: StartedAdbQrPairing;
                    if (mode === 'tailscale') {
                        let host: string;
                        try {
                            host = assertTailscaleQrHost(body.host);
                        } catch (error) {
                            res.writeHead(400);
                            res.end(JSON.stringify({ error: (error as Error).message }));
                            return true;
                        }
                        session = this.qrPairing.start({ mode, host });
                    } else {
                        session = this.qrPairing.start({ mode });
                    }

                    let qrSvg: string;
                    try {
                        qrSvg = await this.renderQr(session.payload);
                    } catch (err) {
                        this.qrPairing.cancel(session.id);
                        throw err;
                    }
                    res.writeHead(200);
                    res.end(
                        JSON.stringify({
                            id: session.id,
                            state: session.state,
                            mode: session.mode,
                            ...(session.host ? { host: session.host } : {}),
                            message: session.message,
                            expiresAt: session.expiresAt,
                            qrSvg,
                        }),
                    );
                    return true;
                }

                if (!id) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'session id is required' }));
                    return true;
                }

                if (req.method === 'GET') {
                    const status: AdbQrPairingStatus | null = this.qrPairing.getStatus(id);
                    if (!status) {
                        res.writeHead(404);
                        res.end(JSON.stringify({ error: 'QR pairing session not found' }));
                        return true;
                    }
                    res.writeHead(200);
                    res.end(JSON.stringify(status));
                    return true;
                }

                if (req.method === 'DELETE') {
                    if (!this.qrPairing.cancel(id)) {
                        res.writeHead(404);
                        res.end(JSON.stringify({ error: 'QR pairing session not found or already finished' }));
                        return true;
                    }
                    res.writeHead(200);
                    res.end(JSON.stringify({ success: true }));
                    return true;
                }
            }

            if (req.method === 'POST' && url === '/api/devices/scan') {
                const discovered = await this.adbClient.mdnsServices();
                const connectable = discovered.filter(
                    (d) => d.service.includes('_adb') && !d.service.includes('pairing'),
                );
                const connected = await this.adbClient.devices();
                const connectedAddresses = new Set(connected.map((d) => d.serial));
                const db = Config.getInstance().db;
                const userId = resolveUserId(req);
                const available = connectable
                    .filter((d) => {
                        const addr = `${d.address}:${d.port}`;
                        return !connectedAddresses.has(addr);
                    })
                    .map((d) => {
                        const serial = parseSerialFromMdnsName(d.name, d.service);
                        // Enrich with the remembered model from a prior observation
                        // (read before the sighting upsert below).
                        const observed = db.devices.getDevice(serial);
                        return {
                            ...d,
                            serial,
                            label: db.devices.getLabel(userId, serial) || '',
                            model: observed?.model ?? null,
                        };
                    });
                // Record this sighting in the shared observed table.
                upsertObservedDevices(
                    db,
                    available.map((d) => ({
                        serial: d.serial,
                        address: `${d.address}:${d.port}`,
                        lastSeenAt: Date.now(),
                    })),
                );
                res.writeHead(200);
                res.end(JSON.stringify(available));
                return true;
            }

            if (req.method === 'GET' && url === '/api/devices/scan/subnet') {
                const detected = await detectSubnet();
                res.writeHead(200);
                res.end(JSON.stringify(detected));
                return true;
            }

            if (req.method === 'POST' && url === '/api/devices/pair') {
                const { host, pairingPort, pairingCode, connectPort, label } = await readJsonBodyStrict<{
                    host?: string;
                    pairingPort?: string | number;
                    pairingCode?: string;
                    connectPort?: string | number;
                    label?: string;
                }>(req);

                const cleanHost = typeof host === 'string' ? host.trim() : '';
                const cleanPairingPort = String(pairingPort ?? '').trim();
                const cleanConnectPort = String(connectPort ?? '').trim();
                const cleanCode = typeof pairingCode === 'string' ? pairingCode.trim() : '';
                const cleanLabel = typeof label === 'string' ? label.trim() : '';

                let pairAddress: string;
                let connectAddress: string;
                try {
                    pairAddress = assertAdbNetworkAddress(`${cleanHost}:${cleanPairingPort}`);
                    connectAddress = assertAdbNetworkAddress(`${cleanHost}:${cleanConnectPort}`);
                    assertAdbPairingCode(cleanCode);
                } catch (err) {
                    res.writeHead(400);
                    res.end(
                        JSON.stringify({
                            success: false,
                            phase: 'validation',
                            message: (err as Error).message,
                        }),
                    );
                    return true;
                }

                let pairResult: string;
                try {
                    pairResult = await this.adbClient.pair(pairAddress, cleanCode);
                } catch (err) {
                    log.warn(`pair ${pairAddress} failed: ${(err as Error).message}`);
                    res.writeHead(502);
                    res.end(
                        JSON.stringify({
                            success: false,
                            phase: 'pair',
                            message: 'Pairing failed. Check the Tailscale IP, pairing port, and fresh 6-digit code.',
                        }),
                    );
                    return true;
                }
                if (!pairSucceeded(pairResult)) {
                    const safePairResult = redactPairingCode(pairResult, cleanCode).trim().replace(/\s+/g, ' ');
                    log.warn(`pair ${pairAddress} returned no success marker: ${safePairResult}`);
                    res.writeHead(502);
                    res.end(
                        JSON.stringify({
                            success: false,
                            phase: 'pair',
                            message: 'ADB did not confirm pairing. Generate a fresh code and try again.',
                        }),
                    );
                    return true;
                }

                let connectResult: string;
                try {
                    connectResult = await this.adbClient.connect(connectAddress);
                } catch (err) {
                    log.warn(`connect ${connectAddress} after pairing failed: ${(err as Error).message}`);
                    res.writeHead(502);
                    res.end(
                        JSON.stringify({
                            success: false,
                            phase: 'connect',
                            message:
                                'Paired, but connection failed. Re-check the connection port shown on Wireless debugging.',
                        }),
                    );
                    return true;
                }
                if (!connectSucceeded(connectResult)) {
                    res.writeHead(502);
                    res.end(
                        JSON.stringify({
                            success: false,
                            phase: 'connect',
                            message: connectResult.trim() || 'ADB did not confirm the device connection.',
                        }),
                    );
                    return true;
                }

                if (cleanLabel) {
                    Config.getInstance().db.devices.setLabel(resolveUserId(req), connectAddress, cleanLabel);
                }
                log.info(`paired ${pairAddress} and connected ${connectAddress}`);
                res.writeHead(200);
                res.end(
                    JSON.stringify({
                        success: true,
                        phase: 'complete',
                        address: connectAddress,
                        message: `Paired and connected to ${connectAddress}`,
                    }),
                );
                return true;
            }

            if (req.method === 'POST' && url === '/api/devices/connect') {
                const { address, serial, label } = await readJsonBodyStrict<{
                    address?: string;
                    serial?: string;
                    label?: string;
                }>(req);
                if (!address) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'address is required' }));
                    return true;
                }
                const db = Config.getInstance().db;
                const userId = resolveUserId(req);
                // mDNS path: serial is known upfront, save the label before connecting.
                if (serial && label) {
                    db.devices.setLabel(userId, serial, label);
                }
                try {
                    assertAdbNetworkAddress(address);
                } catch (err) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ success: false, message: (err as Error).message }));
                    return true;
                }
                const result = await this.adbClient.connect(address);
                const success = connectSucceeded(result);
                log.info(`connect ${address} → ${success ? 'OK' : 'FAIL'}: ${result.trim().replace(/\s+/g, ' ')}`);
                if (success && label) {
                    // Persist the label under the device's real serial AND its MAC.
                    // Storing under both keys lets future scans (which may only have
                    // MAC from ARP — no serial without racing adb) still rehydrate
                    // the label. Only applies when the user provided a label on this
                    // connect; otherwise nothing to persist.
                    try {
                        let realSerial = serial;
                        if (!realSerial) {
                            const lookedUp = (await this.adbClient.shell(address, 'getprop ro.serialno')).trim();
                            if (lookedUp) realSerial = lookedUp;
                        }
                        if (realSerial) {
                            db.devices.setLabel(userId, realSerial, label);
                        }
                        const ip = address.split(':')[0]!;
                        const mac = await resolveMac(ip);
                        if (mac) {
                            db.devices.setLabel(userId, mac, label);
                        }
                    } catch {
                        // Serial or MAC lookup failed — partial persist is OK;
                        // user can edit label later from the card.
                    }
                }
                res.writeHead(success ? 200 : 500);
                res.end(JSON.stringify({ success, message: result.trim() }));
                return true;
            }

            if (req.method === 'POST' && url === '/api/devices/disconnect') {
                const { address } = await readJsonBodyStrict<{ address?: string }>(req);
                if (!address) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'address is required' }));
                    return true;
                }
                const result = await this.adbClient.disconnect(address);
                const success = result.includes('disconnected');
                res.writeHead(success ? 200 : 500);
                res.end(JSON.stringify({ success, message: result.trim() }));
                return true;
            }

            if (req.method === 'GET' && url.startsWith('/api/devices/screen-state')) {
                const parsedUrl = new URL(url, `http://${req.headers.host}`);
                const udid = parsedUrl.searchParams.get('udid');
                if (!udid) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'udid is required' }));
                    return true;
                }
                const output = await this.adbClient.shell(udid, 'dumpsys power 2>/dev/null | grep mWakefulness');
                const awake = output.includes('Awake');
                res.writeHead(200);
                res.end(JSON.stringify({ awake }));
                return true;
            }

            if (req.method === 'POST' && url === '/api/devices/sleep-wake') {
                const { udid, action } = await readJsonBodyStrict<{ udid?: string; action?: string }>(req);
                if (!udid || !action) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'udid and action are required' }));
                    return true;
                }
                const keyevent = action === 'sleep' ? 223 : 224;
                await this.adbClient.shell(udid, `input keyevent ${keyevent}`);
                // Re-check state after a brief delay for the device to respond
                await new Promise((r) => setTimeout(r, 500));
                const output = await this.adbClient.shell(udid, 'dumpsys power 2>/dev/null | grep mWakefulness');
                const awake = output.includes('Awake');
                res.writeHead(200);
                res.end(JSON.stringify({ awake }));
                return true;
            }

            if (req.method === 'GET' && url === '/api/devices/labels') {
                const labels = Config.getInstance().db.devices.getAllLabels(resolveUserId(req));
                res.writeHead(200);
                res.end(JSON.stringify(labels));
                return true;
            }

            if (req.method === 'PUT' && url === '/api/devices/labels') {
                const { serial, label } = await readJsonBodyStrict<{ serial?: string; label?: string }>(req);
                if (!serial) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'serial is required' }));
                    return true;
                }
                const db = Config.getInstance().db;
                const userId = resolveUserId(req);
                if (label) {
                    db.devices.setLabel(userId, serial, label);
                } else {
                    db.devices.deleteLabel(userId, serial);
                }
                res.writeHead(200);
                res.end(JSON.stringify({ success: true }));
                return true;
            }

            if (req.method === 'POST' && url === '/api/devices/files/delete') {
                const { udid, paths } = await readJsonBodyStrict<{ udid?: string; paths?: unknown }>(req);
                if (!udid) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'udid is required' }));
                    return true;
                }
                let safePaths: string[];
                try {
                    // Bound + validate the targets before any privileged delete:
                    // refuses unbounded lists, traversal, and catastrophic roots
                    // (/sdcard, /data, …). udid is serial-checked by adbClient.
                    safePaths = assertDeletablePaths(paths);
                } catch (e) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: (e as Error).message }));
                    return true;
                }
                const errors: { path: string; error: string }[] = [];
                for (const filePath of safePaths) {
                    try {
                        await this.adbClient.shell(udid, `rm -rf ${shArg(filePath)}`);
                    } catch (err) {
                        errors.push({ path: filePath, error: (err as Error).message });
                    }
                }
                const success = errors.length === 0;
                res.writeHead(success ? 200 : 207);
                res.end(JSON.stringify({ success, errors: errors.length > 0 ? errors : undefined }));
                return true;
            }

            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Not found' }));
            return true;
        } catch (err: any) {
            if (err instanceof BodyTooLargeError) {
                res.writeHead(413);
                res.end(JSON.stringify({ error: 'request body too large' }));
                return true;
            }
            if (err instanceof InvalidJsonError) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'invalid JSON body' }));
                return true;
            }
            log.error(`${req.method} ${req.url} threw: ${err?.message ?? String(err)}`);
            sendInternalError(res);
            return true;
        }
    }
}
