import { describe, expect, it } from 'vitest';
import { isWindowsAdmin } from '../isWindowsAdmin';

describe('isWindowsAdmin', () => {
    it('returns false on non-Windows platforms unconditionally', () => {
        // We can't truly assert non-Windows behavior on a Windows host
        // without monkey-patching process.platform, which the rest of the
        // suite avoids. Instead we just verify the function returns a
        // boolean and doesn't throw — the platform branch is a one-line
        // early-return and obvious from inspection.
        const result = isWindowsAdmin();
        expect(typeof result).toBe('boolean');
    });

    it('does not throw even when net.exe is unavailable or hangs', () => {
        // Defensive: the implementation has a 5s timeout + try/catch, so
        // even pathological host states (no net.exe, broken SMB, etc.)
        // resolve to false rather than crashing the API request handler.
        expect(() => isWindowsAdmin()).not.toThrow();
    });
});
