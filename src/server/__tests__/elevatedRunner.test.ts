import { describe, expect, it } from 'vitest';
import { buildPsRunAsCommand, parseResult, toSnakeCase } from '../service/elevatedRunner';

describe('toSnakeCase', () => {
    it('converts camelCase keys to snake_case at the top level', () => {
        const out = toSnakeCase({
            servyPath: 'a',
            displayName: 'b',
            maxRestartAttempts: 3,
        });
        expect(out).toEqual({
            servy_path: 'a',
            display_name: 'b',
            max_restart_attempts: 3,
        });
    });

    it('preserves all-lowercase keys unchanged', () => {
        const out = toSnakeCase({ name: 'X', envvars: 'a=b' });
        expect(out).toEqual({ name: 'X', envvars: 'a=b' });
    });

    it('handles empty object', () => {
        expect(toSnakeCase({})).toEqual({});
    });
});

describe('parseResult', () => {
    it('parses snake_case JSON (Rust default serde format)', () => {
        const json = JSON.stringify({
            ok: true,
            exit_code: 0,
            stdout: 'install ok',
            stderr: '',
        });
        const r = parseResult(json);
        expect(r).toEqual({
            ok: true,
            exitCode: 0,
            stdout: 'install ok',
            stderr: '',
            errorMessage: undefined,
        });
    });

    it('falls back to camelCase keys when present', () => {
        const json = JSON.stringify({
            ok: false,
            exitCode: 4,
            stdout: '',
            stderr: 'failed',
            errorMessage: 'servy-cli install exited with code 1',
        });
        const r = parseResult(json);
        expect(r.ok).toBe(false);
        expect(r.exitCode).toBe(4);
        expect(r.errorMessage).toBe('servy-cli install exited with code 1');
    });

    it('coerces missing fields to safe defaults', () => {
        const r = parseResult('{}');
        expect(r.ok).toBe(false);
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe('');
        expect(r.stderr).toBe('');
        expect(r.errorMessage).toBeUndefined();
    });

    it('returns a structured failure for malformed JSON', () => {
        const r = parseResult('not json at all');
        expect(r.ok).toBe(false);
        expect(r.exitCode).toBe(-1);
        expect(r.errorMessage).toMatch(/could not parse/i);
        // Original raw string is preserved in stderr for debugging.
        expect(r.stderr).toBe('not json at all');
    });
});

describe('buildPsRunAsCommand', () => {
    const params = {
        launcherPath: 'C:\\app\\ws-scrcpy-web-launcher.exe',
        command: 'install-service',
        argsPath: 'C:\\Users\\me\\AppData\\Local\\Temp\\args.json',
        resultPath: 'C:\\Users\\me\\AppData\\Local\\Temp\\result.json',
    };

    it('produces a Start-Process -Verb RunAs invocation', () => {
        const cmd = buildPsRunAsCommand(params);
        expect(cmd).toContain('Start-Process');
        expect(cmd).toContain('-Verb RunAs');
        expect(cmd).toContain('-Wait');
        expect(cmd).toContain('-PassThru');
        expect(cmd).toContain("'C:\\app\\ws-scrcpy-web-launcher.exe'");
    });

    it('includes the elevate-and-run argv with command + paths', () => {
        const cmd = buildPsRunAsCommand(params);
        expect(cmd).toContain("'--elevate-and-run'");
        expect(cmd).toContain("'install-service'");
        expect(cmd).toContain("'C:\\Users\\me\\AppData\\Local\\Temp\\args.json'");
        expect(cmd).toContain("'C:\\Users\\me\\AppData\\Local\\Temp\\result.json'");
    });

    it('escapes single quotes in path values (defense against PS injection)', () => {
        const evil = {
            ...params,
            launcherPath: "C:\\app'with'quotes\\launcher.exe",
        };
        const cmd = buildPsRunAsCommand(evil);
        // Single quotes in the value get doubled, which is the PowerShell
        // single-quote escape. So `'` becomes `''`.
        expect(cmd).toContain("'C:\\app''with''quotes\\launcher.exe'");
    });

    it('propagates the elevated child exit code via $p.ExitCode', () => {
        const cmd = buildPsRunAsCommand(params);
        expect(cmd).toContain('exit $p.ExitCode');
    });
});
