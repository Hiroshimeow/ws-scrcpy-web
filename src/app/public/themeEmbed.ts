/**
 * Public theme-embed helpers for ws-scrcpy-web.
 *
 * Exposes the same get/set semantics used internally by ThemeToggle, plus
 * postMessage helpers so a parent window (e.g., a host page embedding
 * ws-scrcpy-web in an iframe) can push theme changes across origins.
 */

const STORAGE_KEY = 'ws-scrcpy-web-theme';

export type Theme = 'dark' | 'light';

export interface ThemeEmbedOptions {
    /** Default 'ws-scrcpy-web:theme'. */
    messageType?: string;
    /**
     * Origins allowed to push theme messages. Default '*' — accepts any
     * origin. WARNING: leave as '*' only when ws-scrcpy-web is intended to be
     * embeddable by arbitrary hosts. Pass an explicit allowlist
     * (e.g., ['https://my-host.example']) for locked-down deployments.
     */
    allowedOrigins?: '*' | string[];
}

export function getTheme(): Theme {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' ? 'light' : 'dark';
}

export function setTheme(theme: Theme): void {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(STORAGE_KEY, theme);
}
