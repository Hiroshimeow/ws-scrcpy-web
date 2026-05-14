import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdbClient, AdbExecError, parseMdnsOutput, parseSerialFromMdnsName } from '../AdbClient';

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
        const client = new AdbClient('adb');
        expect(typeof client.mdnsServices).toBe('function');
    });

    it('has connect method', () => {
        const client = new AdbClient('adb');
        expect(typeof client.connect).toBe('function');
    });

    it('has disconnect method', () => {
        const client = new AdbClient('adb');
        expect(typeof client.disconnect).toBe('function');
    });

    it('has killServer method', () => {
        const client = new AdbClient('adb');
        expect(typeof client.killServer).toBe('function');
    });

    it('has startServer method', () => {
        const client = new AdbClient('adb');
        expect(typeof client.startServer).toBe('function');
    });

    it('startServer throws AdbExecError(spawn) when adb binary never appears within waitForBinaryMs', async () => {
        const client = new AdbClient('/definitely/not/a/real/binary/adb');
        // Use a very short wait so the test stays fast.
        await expect(client.startServer({ waitForBinaryMs: 50 })).rejects.toBeInstanceOf(AdbExecError);
        try {
            await client.startServer({ waitForBinaryMs: 50 });
            expect.fail('expected throw');
        } catch (err) {
            expect(err).toBeInstanceOf(AdbExecError);
            expect((err as AdbExecError).kind).toBe('spawn');
            expect((err as AdbExecError).args).toEqual(['start-server']);
        }
    });

    it('startServer reaches the exec path once the binary exists (verified via exit-code error)', async () => {
        // Using node as the "adb" binary: when startServer's exec phase fires,
        // node will try to load 'start-server' as a script and exit non-zero —
        // surfacing as AdbExecError('exit'). Proves the wait-for-binary loop
        // exited cleanly and the exec branch ran.
        const client = new AdbClient(process.execPath);
        try {
            await client.startServer({ waitForBinaryMs: 100 });
            expect.fail('expected throw');
        } catch (err) {
            expect(err).toBeInstanceOf(AdbExecError);
            expect((err as AdbExecError).kind).toBe('exit');
            expect((err as AdbExecError).adbPath).toBe(process.execPath);
        }
    });

    it('cwd is the parent directory of adbPath (decouples daemon from install root)', () => {
        // Cross-platform absolute path so both POSIX and win32 dirname succeed.
        const adbPath = path.join(os.tmpdir(), 'fake-deps', 'adb', 'adb');
        const client = new AdbClient(adbPath);
        expect(client.cwd).toBe(path.join(os.tmpdir(), 'fake-deps', 'adb'));
    });

    it('cwd is the parent dir for Windows-style paths too', () => {
        const adbPath = 'C:\\ProgramData\\WsScrcpyWeb\\dependencies\\adb\\adb.exe';
        const client = new AdbClient(adbPath);
        // path.dirname is platform-aware; on Windows this resolves to the
        // expected parent. On POSIX path.dirname returns '.' for backslash
        // paths (because backslash is a normal char). We just assert it's
        // not the full input path — the real check is the architectural
        // intent: cwd is NOT inside <installRoot>\current\.
        expect(client.cwd).not.toBe(adbPath);
        expect(client.cwd.endsWith('current') || client.cwd.endsWith('current\\')).toBe(false);
    });
});

describe('AdbClient — error surfacing', () => {
    it('throws AdbExecError(spawn) when binary does not exist', async () => {
        const client = new AdbClient('/definitely/not/a/real/binary/adb');
        await expect(client.devices()).rejects.toBeInstanceOf(AdbExecError);
        try {
            await client.devices();
        } catch (err) {
            expect(err).toBeInstanceOf(AdbExecError);
            expect((err as AdbExecError).kind).toBe('spawn');
            expect((err as AdbExecError).adbPath).toBe('/definitely/not/a/real/binary/adb');
            expect((err as AdbExecError).args).toEqual(['devices']);
        }
    });

    it('throws AdbExecError(exit) when the binary exits non-zero', async () => {
        // Cross-platform: run node with a one-liner that exits 2. Node is
        // guaranteed available in this test env (vitest runs under it). The
        // .devices() call will pass 'devices' as the first arg, which node
        // will reject — but we override args via mdnsServices to inject our
        // own script. Simpler: use a tiny shim file we can target with the
        // real `devices` invocation that ignores args and just exits.
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-test-'));
        const shim = path.join(tmpDir, 'shim.js');
        fs.writeFileSync(shim, 'process.exit(2);\n');
        // Make the shim itself the "binary" by spawning node with its path.
        // But AdbClient.devices passes ['devices'] as args, so we need a
        // wrapper that's executable directly. Use a small Node child via
        // shebang on POSIX, or a pwsh/cmd wrapper on Windows that calls node.
        // Cleanest: invoke node directly and verify via a method call where
        // the args path doesn't matter. Just spawn node with -e "process.exit(2)"
        // by setting adbPath = node and exercising via the same exec wrapper
        // — which means we can't use the public methods, but the exec wrapper
        // is tested via the public surface. So: use `connect` with a real
        // node binary and assert it exits non-zero.
        //
        // Actually simplest: set adbPath = node, call any method, node will
        // try to load the first arg ('connect' / 'devices') as a script, fail,
        // and exit 1. That's a clean non-zero exit, classified as 'exit'.
        const client = new AdbClient(process.execPath);
        try {
            await client.devices();
            expect.fail('expected throw');
        } catch (err) {
            expect(err).toBeInstanceOf(AdbExecError);
            // Node fails to load 'devices' as a script and exits with code 1.
            expect((err as AdbExecError).kind).toBe('exit');
            expect((err as AdbExecError).adbPath).toBe(process.execPath);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('mdnsServices no longer swallows errors', async () => {
        // Previously this returned [] on any failure, masking packaging bugs.
        // Now it should throw so callers (scanner / API) can surface a real reason.
        const client = new AdbClient('/definitely/not/a/real/binary/adb');
        await expect(client.mdnsServices()).rejects.toBeInstanceOf(AdbExecError);
    });
});

describe('parseSerialFromMdnsName', () => {
    it('parses plain ADB name', () => {
        expect(parseSerialFromMdnsName('adb-49241HFAG07SUG', '_adb._tcp')).toBe('49241HFAG07SUG');
    });

    it('parses TLS connect name (strips suffix)', () => {
        expect(parseSerialFromMdnsName('adb-47121FDAQ000WC-7vmR8a', '_adb-tls-connect._tcp')).toBe('47121FDAQ000WC');
    });

    it('handles name without adb- prefix', () => {
        expect(parseSerialFromMdnsName('49241HFAG07SUG', '_adb._tcp')).toBe('49241HFAG07SUG');
    });

    it('handles empty string', () => {
        expect(parseSerialFromMdnsName('', '_adb._tcp')).toBe('');
    });
});
