// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import type { IncomingMessage, ServerResponse } from 'http';
import { AdbClient, parseSerialFromMdnsName } from '../AdbClient';
import { Config } from '../Config';
import { DeviceLabelStore } from '../DeviceLabelStore';

export class DeviceDiscoveryApi {
    private adbClient: AdbClient;

    constructor() {
        this.adbClient = new AdbClient(Config.getInstance().adbPath);
    }

    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const url = req.url || '';
        if (!url.startsWith('/api/devices')) return false;

        res.setHeader('Content-Type', 'application/json');

        try {
            if (req.method === 'POST' && url === '/api/devices/scan') {
                const discovered = await this.adbClient.mdnsServices();
                const connectable = discovered.filter((d) => d.service.includes('_adb') && !d.service.includes('pairing'));
                const connected = await this.adbClient.devices();
                const connectedAddresses = new Set(connected.map((d) => d.serial));
                const labelStore = DeviceLabelStore.getInstance();
                const available = connectable
                    .filter((d) => {
                        const addr = `${d.address}:${d.port}`;
                        return !connectedAddresses.has(addr);
                    })
                    .map((d) => {
                        const serial = parseSerialFromMdnsName(d.name, d.service);
                        return {
                            ...d,
                            serial,
                            label: labelStore.get(serial) || '',
                        };
                    });
                res.writeHead(200);
                res.end(JSON.stringify(available));
                return true;
            }

            if (req.method === 'POST' && url === '/api/devices/connect') {
                const body = await readBody(req);
                const { address, serial, label } = JSON.parse(body);
                if (!address) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'address is required' }));
                    return true;
                }
                if (serial && label) {
                    DeviceLabelStore.getInstance().set(serial, label);
                }
                const result = await this.adbClient.connect(address);
                const success = result.includes('connected');
                res.writeHead(success ? 200 : 500);
                res.end(JSON.stringify({ success, message: result.trim() }));
                return true;
            }

            if (req.method === 'POST' && url === '/api/devices/disconnect') {
                const body = await readBody(req);
                const { address } = JSON.parse(body);
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

            if (req.method === 'GET' && url === '/api/devices/labels') {
                const labels = DeviceLabelStore.getInstance().getAll();
                res.writeHead(200);
                res.end(JSON.stringify(labels));
                return true;
            }

            if (req.method === 'PUT' && url === '/api/devices/labels') {
                const body = await readBody(req);
                const { serial, label } = JSON.parse(body);
                if (!serial) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'serial is required' }));
                    return true;
                }
                const store = DeviceLabelStore.getInstance();
                if (label) {
                    store.set(serial, label);
                } else {
                    store.delete(serial);
                }
                res.writeHead(200);
                res.end(JSON.stringify({ success: true }));
                return true;
            }

            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Not found' }));
            return true;
        } catch (err: any) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: err.message }));
            return true;
        }
    }
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk: Buffer) => {
            body += chunk.toString();
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}
