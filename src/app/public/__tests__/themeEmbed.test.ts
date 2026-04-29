// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { getTheme, setTheme } from '../themeEmbed';

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
});
