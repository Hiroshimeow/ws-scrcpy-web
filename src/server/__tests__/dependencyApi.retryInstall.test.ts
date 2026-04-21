// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { DependencyStatus } from '../../common/DependencyTypes';
import { DependencyApi } from '../api/DependencyApi';
import { DependencyManager } from '../DependencyManager';

function makeMockRes() {
    const res = new EventEmitter() as EventEmitter & {
        statusCode?: number;
        body?: string;
        writeHead: (code: number) => void;
        end: (body: string) => void;
        setHeader: (k: string, v: string) => void;
    };
    res.setHeader = vi.fn();
    res.writeHead = vi.fn((code: number) => {
        res.statusCode = code;
    });
    res.end = vi.fn((body: string) => {
        res.body = body;
    });
    return res;
}

function makeReq(method: string, url: string) {
    return { method, url } as any;
}

describe('DependencyApi retry-install endpoint', () => {
    it('routes POST /api/dependencies/retry-install', async () => {
        const mgr = new DependencyManager('/tmp/test');
        vi.spyOn(mgr, 'checkAll').mockResolvedValue();
        vi.spyOn(mgr, 'autoInstallMissing').mockResolvedValue();
        const api = new DependencyApi(mgr);
        const req = makeReq('POST', '/api/dependencies/retry-install');
        const res = makeMockRes();

        const handled = await api.handle(req, res);

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(mgr.checkAll).toHaveBeenCalled();
        expect(mgr.autoInstallMissing).toHaveBeenCalled();
    });

    it('reports installed deps in response body', async () => {
        const mgr = new DependencyManager('/tmp/test');
        const adb = mgr.getByName('adb')!;
        adb.installedVersion = null;

        vi.spyOn(mgr, 'checkAll').mockImplementation(async () => {
            adb.latestVersion = '35.0.2';
            // Set all deps to have latest versions so autoInstallMissing can complete them
            for (const dep of mgr.getAll()) {
                if (!dep.latestVersion) {
                    dep.latestVersion = '1.0.0';
                }
            }
        });
        vi.spyOn(mgr, 'autoInstallMissing').mockImplementation(async () => {
            adb.installedVersion = '35.0.2';
            adb.status = DependencyStatus.UpToDate;
            // Mark all deps as up-to-date
            for (const dep of mgr.getAll()) {
                if (dep.installedVersion === null && dep.latestVersion !== null) {
                    dep.installedVersion = dep.latestVersion;
                    dep.status = DependencyStatus.UpToDate;
                }
                dep.errorMessage = undefined;
            }
        });

        const api = new DependencyApi(mgr);
        const req = makeReq('POST', '/api/dependencies/retry-install');
        const res = makeMockRes();
        await api.handle(req, res);

        const body = JSON.parse(res.body!);
        expect(body.success).toBe(true);
        expect(body.installed).toContain('adb');
        expect(body.stillMissing).toEqual([]);
    });

    it('reports stillMissing when deps remain null after retry', async () => {
        const mgr = new DependencyManager('/tmp/test');
        const adb = mgr.getByName('adb')!;
        adb.installedVersion = null;
        adb.latestVersion = null;
        adb.status = DependencyStatus.Error;
        adb.errorMessage = 'network timeout';

        vi.spyOn(mgr, 'checkAll').mockResolvedValue();
        vi.spyOn(mgr, 'autoInstallMissing').mockResolvedValue();

        const api = new DependencyApi(mgr);
        const req = makeReq('POST', '/api/dependencies/retry-install');
        const res = makeMockRes();
        await api.handle(req, res);

        const body = JSON.parse(res.body!);
        expect(body.success).toBe(false);
        expect(body.stillMissing).toContain('adb');
        expect(body.errors.adb).toBe('network timeout');
    });

    it('returns 200 even when success is false', async () => {
        const mgr = new DependencyManager('/tmp/test');
        const adb = mgr.getByName('adb')!;
        adb.installedVersion = null;
        adb.status = DependencyStatus.Error;

        vi.spyOn(mgr, 'checkAll').mockResolvedValue();
        vi.spyOn(mgr, 'autoInstallMissing').mockResolvedValue();

        const api = new DependencyApi(mgr);
        const req = makeReq('POST', '/api/dependencies/retry-install');
        const res = makeMockRes();
        await api.handle(req, res);

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body!);
        expect(body.success).toBe(false);
    });
});
