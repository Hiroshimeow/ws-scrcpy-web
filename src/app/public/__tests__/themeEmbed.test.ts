// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { getTheme, setTheme, installThemeEmbedListener } from '../themeEmbed';

describe('getTheme / setTheme', () => {
    beforeEach(() => {
        localStorage.clear();
        document.documentElement.removeAttribute('data-theme');
    });

    it('returns "dark" by default when localStorage is empty', () => {
        expect(getTheme()).toBe('dark');
    });

    it('setTheme("light") writes localStorage and DOM attribute', () => {
        setTheme('light');
        expect(localStorage.getItem('ws-scrcpy-web-theme')).toBe('light');
        expect(document.documentElement.getAttribute('data-theme')).toBe('light');
        expect(getTheme()).toBe('light');
    });

    it('setTheme("dark") round-trips', () => {
        setTheme('light');
        setTheme('dark');
        expect(getTheme()).toBe('dark');
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    it('coerces unexpected localStorage values to "dark"', () => {
        localStorage.setItem('ws-scrcpy-web-theme', 'garbage');
        expect(getTheme()).toBe('dark');
    });
});

describe('installThemeEmbedListener', () => {
    beforeEach(() => {
        localStorage.clear();
        document.documentElement.removeAttribute('data-theme');
    });

    function postFromOrigin(origin: string, data: unknown): void {
        const evt = new MessageEvent('message', {
            data,
            origin,
            source: window,
        });
        window.dispatchEvent(evt);
    }

    it('applies a valid theme message of the default type', () => {
        const dispose = installThemeEmbedListener();
        postFromOrigin('https://example.com', { type: 'ws-scrcpy-web:theme', theme: 'light' });
        expect(getTheme()).toBe('light');
        dispose();
    });

    it('ignores wrong message type', () => {
        const dispose = installThemeEmbedListener();
        postFromOrigin('https://example.com', { type: 'other:theme', theme: 'light' });
        expect(getTheme()).toBe('dark');
        dispose();
    });

    it('ignores invalid theme values', () => {
        const dispose = installThemeEmbedListener();
        postFromOrigin('https://example.com', { type: 'ws-scrcpy-web:theme', theme: 'midnight' });
        postFromOrigin('https://example.com', { type: 'ws-scrcpy-web:theme', theme: null });
        expect(getTheme()).toBe('dark');
        dispose();
    });

    it('honors allowedOrigins allowlist', () => {
        const dispose = installThemeEmbedListener({ allowedOrigins: ['https://allowed.example'] });
        postFromOrigin('https://blocked.example', { type: 'ws-scrcpy-web:theme', theme: 'light' });
        expect(getTheme()).toBe('dark');
        postFromOrigin('https://allowed.example', { type: 'ws-scrcpy-web:theme', theme: 'light' });
        expect(getTheme()).toBe('light');
        dispose();
    });

    it('honors custom messageType', () => {
        const dispose = installThemeEmbedListener({ messageType: 'custom:theme' });
        postFromOrigin('https://example.com', { type: 'custom:theme', theme: 'light' });
        expect(getTheme()).toBe('light');
        dispose();
    });

    it('disposer detaches the listener', () => {
        const dispose = installThemeEmbedListener();
        dispose();
        postFromOrigin('https://example.com', { type: 'ws-scrcpy-web:theme', theme: 'light' });
        expect(getTheme()).toBe('dark');
    });
});
