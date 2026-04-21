import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as http from 'http';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as fs from 'fs';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as os from 'os';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as path from 'path';
import {
    resolveNodePty, _resetForTest, _setReleaseUrlBase,
    composePrebuiltKey, getHostInfo, nodeModulesReleaseDir,
    type Manifest,
} from '../NodePtyResolver';
import { buildFixtureTarball } from './setup-fixture';

describe('NodePtyResolver — integration (download path)', () => {
    let tempDepsPath: string;
    let fixtureDir: string;
    let server: http.Server;
    let serverUrl: string;
    let originalReleaseDirSnapshot: string | null = null;

    beforeEach(async () => {
        _resetForTest();

        // The integration test uses the host's already-installed node-pty binary
        // as fixture source. It must be present (globalSetup normally ensures this).
        const activeDir = nodeModulesReleaseDir();
        if (!fs.existsSync(activeDir) || fs.readdirSync(activeDir).length === 0) {
            throw new Error(
                'Integration test requires node-pty binary already present in node_modules. ' +
                'Run `npm run fetch-prebuilts` or rely on vitest globalSetup.',
            );
        }

        // Snapshot active dir so the test's copy-to-active step can be reversed
        originalReleaseDirSnapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'nodepty-snapshot-'));
        fs.cpSync(activeDir, originalReleaseDirSnapshot, { recursive: true });

        tempDepsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nodepty-integration-'));
        fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodepty-fixture-'));

        const host = getHostInfo();
        const version = '9.9.9';  // fake version so we don't collide with real cache
        const key = composePrebuiltKey(host, version);
        const { tarPath, sha256 } = buildFixtureTarball(activeDir, key, fixtureDir);
        const manifest: Manifest = { upstreamVersion: version, coveredAbis: [host.nodeAbi] };
        const sha256Sums = `${sha256}  ${key}.tar.gz\n`;

        server = http.createServer((req, res) => {
            const url = req.url ?? '';
            if (url.endsWith('/node-pty-prebuilds-latest/manifest.json')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(manifest));
                return;
            }
            if (url.endsWith('/SHA256SUMS')) {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end(sha256Sums);
                return;
            }
            if (url.endsWith(`${key}.tar.gz`)) {
                res.writeHead(200, { 'Content-Type': 'application/gzip' });
                fs.createReadStream(tarPath).pipe(res);
                return;
            }
            res.writeHead(404);
            res.end('not found');
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('server.address() returned unexpected value');
        serverUrl = `http://127.0.0.1:${addr.port}`;
        _setReleaseUrlBase(serverUrl);
    });

    afterEach(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        _setReleaseUrlBase('https://github.com/bilbospocketses/ws-scrcpy-web/releases/download');
        try { fs.rmSync(tempDepsPath, { recursive: true, force: true }); } catch {}
        try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
        if (originalReleaseDirSnapshot) {
            const activeDir = nodeModulesReleaseDir();
            try { fs.rmSync(activeDir, { recursive: true, force: true }); } catch {}
            fs.cpSync(originalReleaseDirSnapshot, activeDir, { recursive: true });
            try { fs.rmSync(originalReleaseDirSnapshot, { recursive: true, force: true }); } catch {}
            originalReleaseDirSnapshot = null;
        }
    });

    it('downloads, extracts, places, and loads', async () => {
        const handle = await resolveNodePty(tempDepsPath);
        expect(handle.reason).toBeUndefined();
        expect(handle.available).toBe(true);
        expect(typeof (handle.pty as any).spawn).toBe('function');

        const host = getHostInfo();
        const version = '9.9.9';
        const libcSegment = host.platform === 'linux' ? `-${host.libc}` : '';
        const cacheDir = path.join(tempDepsPath, 'node-pty', `v${version}`, `${host.platform}-${host.arch}${libcSegment}`);
        expect(fs.existsSync(path.join(cacheDir, 'pty.node'))).toBe(true);

        expect(fs.existsSync(path.join(tempDepsPath, 'node-pty', 'manifest.json'))).toBe(true);
    });

    it('cache hit skips download on second call', async () => {
        await resolveNodePty(tempDepsPath);
        _resetForTest();

        // Break the server so any download attempt would fail
        await new Promise<void>((resolve) => server.close(() => resolve()));

        const handle = await resolveNodePty(tempDepsPath);
        expect(handle.available).toBe(true);
    });

    it('returns reason=download-failed when checksum is wrong', async () => {
        // Swap server to return a non-matching checksum
        await new Promise<void>((resolve) => server.close(() => resolve()));
        const host = getHostInfo();
        const manifest: Manifest = { upstreamVersion: '9.9.9', coveredAbis: [host.nodeAbi] };
        const key = composePrebuiltKey(host, '9.9.9');
        server = http.createServer((req, res) => {
            const url = req.url ?? '';
            if (url.endsWith('manifest.json')) {
                res.writeHead(200); res.end(JSON.stringify(manifest)); return;
            }
            if (url.endsWith('SHA256SUMS')) {
                res.writeHead(200);
                res.end(`0000000000000000000000000000000000000000000000000000000000000000  ${key}.tar.gz\n`);
                return;
            }
            if (url.endsWith(`${key}.tar.gz`)) {
                res.writeHead(200);
                res.end('not a real tarball');
                return;
            }
            res.writeHead(404); res.end('not found');
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
        const addr = server.address() as any;
        _setReleaseUrlBase(`http://127.0.0.1:${addr.port}`);

        _resetForTest();
        const handle = await resolveNodePty(tempDepsPath);
        expect(handle.available).toBe(false);
        expect(handle.reason).toBe('download-failed');
    });
});
