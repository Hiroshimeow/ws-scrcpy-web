import { describe, expect, it } from 'vitest';
import { AdbClient, parseMdnsOutput } from '../AdbClient';

describe('parseMdnsOutput', () => {
    it('parses mdns services output with IPs and ports', () => {
        const output = [
            'List of discovered mdns services',
            'adb-SERIAL1\t_adb-tls-connect._tcp.\t192.168.86.43:5555',
            'adb-SERIAL2\t_adb-tls-connect._tcp.\t192.168.86.44:5555',
        ].join('\n');
        const result = parseMdnsOutput(output);
        expect(result).toEqual([
            { name: 'adb-SERIAL1', service: '_adb-tls-connect._tcp.', address: '192.168.86.43', port: 5555 },
            { name: 'adb-SERIAL2', service: '_adb-tls-connect._tcp.', address: '192.168.86.44', port: 5555 },
        ]);
    });

    it('returns empty array for no services', () => {
        const output = 'List of discovered mdns services\n';
        expect(parseMdnsOutput(output)).toEqual([]);
    });

    it('handles _adb-tls-pairing service type', () => {
        const output = [
            'List of discovered mdns services',
            'adb-SERIAL1\t_adb-tls-pairing._tcp.\t192.168.86.43:37485',
        ].join('\n');
        const result = parseMdnsOutput(output);
        expect(result[0].service).toBe('_adb-tls-pairing._tcp.');
        expect(result[0].port).toBe(37485);
    });

    it('ignores malformed lines', () => {
        const output = [
            'List of discovered mdns services',
            'some garbage line',
            'adb-SERIAL1\t_adb-tls-connect._tcp.\t192.168.86.43:5555',
            '',
        ].join('\n');
        const result = parseMdnsOutput(output);
        expect(result.length).toBe(1);
    });
});

describe('AdbClient', () => {
    it('has mdnsServices method', () => {
        const client = new AdbClient();
        expect(typeof client.mdnsServices).toBe('function');
    });

    it('has connect method', () => {
        const client = new AdbClient();
        expect(typeof client.connect).toBe('function');
    });

    it('has disconnect method', () => {
        const client = new AdbClient();
        expect(typeof client.disconnect).toBe('function');
    });
});
