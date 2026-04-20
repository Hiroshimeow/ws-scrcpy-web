import { describe, expect, it } from 'vitest';
import { getArch, getDependencyDefinitions, getPlatform } from '../DependencyDefinitions';

describe('getPlatform', () => {
    it('returns win32 or linux based on os.platform()', () => {
        const platform = getPlatform();
        expect(['win32', 'linux']).toContain(platform);
    });
});

describe('getArch', () => {
    it('returns x64 or arm64', () => {
        const arch = getArch();
        expect(['x64', 'arm64']).toContain(arch);
    });
});

describe('getDependencyDefinitions', () => {
    it('returns definitions for all managed dependencies', () => {
        const defs = getDependencyDefinitions();
        const names = defs.map((d) => d.name);
        expect(names).toContain('nodejs');
        expect(names).toContain('adb');
        expect(names).toContain('scrcpy-server');
    });

    it('each definition has required fields', () => {
        const defs = getDependencyDefinitions();
        for (const def of defs) {
            expect(def.name).toBeTruthy();
            expect(def.displayName).toBeTruthy();
            expect(def.description).toBeTruthy();
            expect(typeof def.checkInstalled).toBe('function');
            expect(typeof def.checkLatest).toBe('function');
        }
    });

    it('nodejs definition includes node-pty pairing', () => {
        const defs = getDependencyDefinitions();
        const node = defs.find((d) => d.name === 'nodejs');
        expect(node?.pairedWith).toBe('node-pty');
        expect(node?.requiresRestart).toBe(true);
    });

    it('scrcpy-server does not require restart', () => {
        const defs = getDependencyDefinitions();
        const scrcpy = defs.find((d) => d.name === 'scrcpy-server');
        expect(scrcpy?.requiresRestart).toBe(false);
    });
});
