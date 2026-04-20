import { describe, expect, it } from 'vitest';
import { DependencyStatus } from '../../common/DependencyTypes';
import { DependencyManager } from '../DependencyManager';

describe('DependencyManager', () => {
    it('initializes with all dependencies in unknown state', () => {
        const mgr = new DependencyManager('/tmp/test-deps');
        const deps = mgr.getAll();
        expect(deps.length).toBe(3);
        expect(deps.every((d) => d.status === DependencyStatus.Unknown)).toBe(true);
    });

    it('getByName returns correct dependency', () => {
        const mgr = new DependencyManager('/tmp/test-deps');
        const node = mgr.getByName('nodejs');
        expect(node).toBeDefined();
        expect(node!.displayName).toBe('Node.js');
    });

    it('getByName returns undefined for unknown dependency', () => {
        const mgr = new DependencyManager('/tmp/test-deps');
        expect(mgr.getByName('nonexistent')).toBeUndefined();
    });

    it('nodejs is marked as requires restart', () => {
        const mgr = new DependencyManager('/tmp/test-deps');
        const node = mgr.getByName('nodejs');
        expect(node!.requiresRestart).toBe(true);
    });

    it('scrcpy-server is marked as no restart needed', () => {
        const mgr = new DependencyManager('/tmp/test-deps');
        const scrcpy = mgr.getByName('scrcpy-server');
        expect(scrcpy!.requiresRestart).toBe(false);
    });
});
