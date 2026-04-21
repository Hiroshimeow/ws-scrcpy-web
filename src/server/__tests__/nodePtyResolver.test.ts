import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveNodePty, getNodePty, _resetForTest } from '../NodePtyResolver';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as fs from 'fs';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as os from 'os';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as path from 'path';

describe('NodePtyResolver', () => {
    beforeEach(() => {
        _resetForTest();
        vi.restoreAllMocks();
    });

    it('getNodePty returns undefined before resolveNodePty is called', () => {
        expect(getNodePty()).toBeUndefined();
    });

    it('resolveNodePty returns { available: true } when homebridge require succeeds', async () => {
        // Default happy path — the test host should have homebridge installed
        // with a working prebuilt for its own ABI.
        const depsPath = path.join(os.tmpdir(), 'ws-scrcpy-web-test-deps-' + Date.now());
        const handle = await resolveNodePty(depsPath);
        expect(handle.available).toBe(true);
        expect(handle.pty).toBeDefined();
        expect(typeof (handle.pty as any).spawn).toBe('function');
    });

    it('getNodePty returns the resolved handle after resolveNodePty completes', async () => {
        const depsPath = path.join(os.tmpdir(), 'ws-scrcpy-web-test-deps-' + Date.now());
        await resolveNodePty(depsPath);
        const handle = getNodePty();
        expect(handle?.available).toBe(true);
    });

    it('resolveNodePty caches and returns the same handle on subsequent calls', async () => {
        const depsPath = path.join(os.tmpdir(), 'ws-scrcpy-web-test-deps-' + Date.now());
        const first = await resolveNodePty(depsPath);
        const second = await resolveNodePty(depsPath);
        expect(second).toBe(first);
    });
});

describe('NodePtyResolver — helpers', () => {
    let depsPath: string;

    beforeEach(() => {
        _resetForTest();
        depsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scrcpy-web-prebuilds-'));
    });

    afterEach(() => {
        try { fs.rmSync(depsPath, { recursive: true, force: true }); } catch {}
    });

    it('composePrebuiltKey produces a stable filename for linux with libc suffix', async () => {
        const { composePrebuiltKey } = await import('../NodePtyResolver');
        const key = composePrebuiltKey({
            platform: 'linux',
            arch: 'x64',
            libc: 'glibc',
            nodeAbi: '127',
        }, '1.1.0');
        expect(key).toBe('node-pty-v1.1.0-node-abi127-linux-x64-glibc');
    });

    it('composePrebuiltKey omits libc suffix on win32', async () => {
        const { composePrebuiltKey } = await import('../NodePtyResolver');
        const key = composePrebuiltKey({
            platform: 'win32',
            arch: 'arm64',
            libc: 'glibc',
            nodeAbi: '127',
        }, '1.1.0');
        expect(key).toBe('node-pty-v1.1.0-node-abi127-win32-arm64');
    });

    it('verifyChecksum returns true for matching SHA256', async () => {
        const { verifyChecksum } = await import('../NodePtyResolver');
        const filePath = path.join(depsPath, 'test.bin');
        fs.writeFileSync(filePath, 'hello world');
        // sha256('hello world') = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
        const ok = await verifyChecksum(filePath, 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
        expect(ok).toBe(true);
    });

    it('verifyChecksum returns false for mismatching SHA256', async () => {
        const { verifyChecksum } = await import('../NodePtyResolver');
        const filePath = path.join(depsPath, 'test.bin');
        fs.writeFileSync(filePath, 'hello world');
        const ok = await verifyChecksum(filePath, '0'.repeat(64));
        expect(ok).toBe(false);
    });
});
