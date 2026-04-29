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

const DEFAULT_MESSAGE_TYPE = 'ws-scrcpy-web:theme';

function isTheme(value: unknown): value is Theme {
    return value === 'dark' || value === 'light';
}

/**
 * Posts a `<messageType>-ready` handshake to the parent window so the host
 * page knows ws-scrcpy-web has loaded and what its current theme is.
 *
 * No-op when not embedded (i.e., when `target === window`, which is true at
 * the top of a frame tree).
 *
 * Uses `'*'` as `targetOrigin` because at handshake time the iframe does not
 * yet know the parent's origin — discovering it is the *purpose* of the
 * handshake. The payload is the iframe's own current theme, which is
 * non-sensitive. The reverse direction (parent → iframe with a new theme)
 * should use `event.origin` from the handshake for `targetOrigin`.
 */
export function notifyThemeReady(target?: Window, opts: ThemeEmbedOptions = {}): void {
    const dest = target ?? window.parent;
    if (!dest || dest === window) return;
    const baseType = opts.messageType ?? DEFAULT_MESSAGE_TYPE;
    const readyType = `${baseType}-ready`;
    dest.postMessage({ type: readyType, theme: getTheme() }, '*');
}

export function installThemeEmbedListener(opts: ThemeEmbedOptions = {}): () => void {
    const messageType = opts.messageType ?? DEFAULT_MESSAGE_TYPE;
    const allowedOrigins = opts.allowedOrigins ?? '*';

    const handler = (event: MessageEvent): void => {
        if (allowedOrigins !== '*' && !allowedOrigins.includes(event.origin)) {
            return;
        }
        const data = event.data;
        if (!data || typeof data !== 'object') return;
        if ((data as { type?: unknown }).type !== messageType) return;
        const theme = (data as { theme?: unknown }).theme;
        if (!isTheme(theme)) return;
        setTheme(theme);
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
}
