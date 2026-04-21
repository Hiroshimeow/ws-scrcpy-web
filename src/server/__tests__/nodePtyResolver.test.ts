import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as fs from 'fs';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as os from 'os';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as path from 'path';
import {
    _resetForTest,
    composePrebuiltKey, verifyChecksum,
    cacheDirHasBinary, nodeModulesReleaseDir,
} from '../NodePtyResolver';

describe('NodePtyResolver — helpers', () => {
    let tmpDir: string;

    beforeEach(() => {
        _resetForTest();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scrcpy-web-resolver-'));
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('composePrebuiltKey produces linux key with libc suffix', () => {
        const key = composePrebuiltKey({
            platform: 'linux', arch: 'x64', libc: 'glibc', nodeAbi: '127',
        }, '1.1.0');
        expect(key).toBe('node-pty-v1.1.0-node-abi127-linux-x64-glibc');
    });

    it('composePrebuiltKey omits libc suffix on win32', () => {
        const key = composePrebuiltKey({
            platform: 'win32', arch: 'arm64', libc: 'glibc', nodeAbi: '127',
        }, '1.1.0');
        expect(key).toBe('node-pty-v1.1.0-node-abi127-win32-arm64');
    });

    it('verifyChecksum returns true for matching SHA256', async () => {
        const filePath = path.join(tmpDir, 'test.bin');
        fs.writeFileSync(filePath, 'hello world');
        const ok = await verifyChecksum(filePath, 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
        expect(ok).toBe(true);
    });

    it('verifyChecksum returns false for mismatching SHA256', async () => {
        const filePath = path.join(tmpDir, 'test.bin');
        fs.writeFileSync(filePath, 'hello world');
        const ok = await verifyChecksum(filePath, '0'.repeat(64));
        expect(ok).toBe(false);
    });

    it('cacheDirHasBinary returns false for missing dir', () => {
        expect(cacheDirHasBinary(path.join(tmpDir, 'nope'))).toBe(false);
    });

    it('cacheDirHasBinary returns false for dir without pty.node', () => {
        fs.writeFileSync(path.join(tmpDir, 'other.node'), 'x');
        expect(cacheDirHasBinary(tmpDir)).toBe(false);
    });

    it('cacheDirHasBinary returns true for dir containing pty.node', () => {
        fs.writeFileSync(path.join(tmpDir, 'pty.node'), 'x');
        expect(cacheDirHasBinary(tmpDir)).toBe(true);
    });

    it('nodeModulesReleaseDir ends with node-pty/build/Release', () => {
        const dir = nodeModulesReleaseDir();
        const tail = dir.split(path.sep).slice(-4).join('/');
        expect(tail).toBe('node_modules/node-pty/build/Release');
    });
});
