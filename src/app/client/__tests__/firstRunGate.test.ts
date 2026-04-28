// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    getBookmarkDismissedPort,
    isServiceFirstRunDismissed,
    isWelcomeDismissed,
    resetAllDismissals,
    setBookmarkDismissedPort,
    setServiceFirstRunDismissed,
    setWelcomeDismissed,
} from '../firstRunGate';

describe('firstRunGate', () => {
    beforeEach(() => {
        window.localStorage.clear();
    });

    afterEach(() => {
        window.localStorage.clear();
    });

    describe('welcomeDismissed flag', () => {
        it('returns false when never set', () => {
            expect(isWelcomeDismissed()).toBe(false);
        });

        it('returns true after setWelcomeDismissed', () => {
            setWelcomeDismissed();
            expect(isWelcomeDismissed()).toBe(true);
        });

        it('is independent from serviceFirstRunDismissed', () => {
            setWelcomeDismissed();
            expect(isServiceFirstRunDismissed()).toBe(false);
        });
    });

    describe('serviceFirstRunDismissed flag', () => {
        it('returns false when never set', () => {
            expect(isServiceFirstRunDismissed()).toBe(false);
        });

        it('returns true after setServiceFirstRunDismissed', () => {
            setServiceFirstRunDismissed();
            expect(isServiceFirstRunDismissed()).toBe(true);
        });

        it('is independent from welcomeDismissed', () => {
            setServiceFirstRunDismissed();
            expect(isWelcomeDismissed()).toBe(false);
        });
    });

    describe('bookmarkDismissedPort flag', () => {
        it('returns null when never set', () => {
            expect(getBookmarkDismissedPort()).toBeNull();
        });

        it('returns the saved port number', () => {
            setBookmarkDismissedPort(8123);
            expect(getBookmarkDismissedPort()).toBe(8123);
        });

        it('returns null for non-numeric stored values (defensive)', () => {
            window.localStorage.setItem('wsScrcpy.bookmarkDismissedForPort', 'abc');
            expect(getBookmarkDismissedPort()).toBeNull();
        });

        it('overwrites with the most recent port', () => {
            setBookmarkDismissedPort(8000);
            setBookmarkDismissedPort(9090);
            expect(getBookmarkDismissedPort()).toBe(9090);
        });

        it('mismatching saved port vs current is the trigger to re-show modal', () => {
            // Mirrors maybeShowPortChangeModal's gating: dismissedFor !== currentPort.
            setBookmarkDismissedPort(8000);
            const currentPort = 9090;
            expect(getBookmarkDismissedPort() !== currentPort).toBe(true);
        });
    });

    describe('resetAllDismissals (v0.1.12)', () => {
        it('clears all three flags', () => {
            setWelcomeDismissed();
            setServiceFirstRunDismissed();
            setBookmarkDismissedPort(8000);

            resetAllDismissals();

            expect(isWelcomeDismissed()).toBe(false);
            expect(isServiceFirstRunDismissed()).toBe(false);
            expect(getBookmarkDismissedPort()).toBeNull();
        });

        it('does not touch unrelated localStorage keys', () => {
            window.localStorage.setItem('audio.preferredBitrate', '128');
            window.localStorage.setItem('theme.mode', 'dark');
            setWelcomeDismissed();

            resetAllDismissals();

            expect(window.localStorage.getItem('audio.preferredBitrate')).toBe('128');
            expect(window.localStorage.getItem('theme.mode')).toBe('dark');
            expect(isWelcomeDismissed()).toBe(false);
        });

        it('is idempotent — calling on a clean state is a no-op', () => {
            expect(() => resetAllDismissals()).not.toThrow();
            expect(isWelcomeDismissed()).toBe(false);
        });
    });
});
