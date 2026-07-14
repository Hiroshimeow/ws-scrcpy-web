/**
 * Validation and escaping for untrusted values that flow into adb invocations
 * or device shell command strings. Browser/WebSocket input (paths, serials,
 * encoder names, push destinations) is untrusted; `adb shell <cmd>` runs the
 * command string through the device's /bin/sh, and a serial beginning with "-"
 * is parsed by adb as an option rather than a positional.
 */

/**
 * Wrap an arbitrary string as a single POSIX-sh single-quoted token. Everything
 * inside single quotes is literal except a single quote itself, which is closed,
 * escaped, and reopened (`'\''`). Safe to interpolate into an `adb shell` string.
 */
export function shArg(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

// adb serials: USB serials, `emulator-NNNN`, and `host:port` for network devices.
// They never contain whitespace (adb prints them whitespace-delimited) and never
// start with "-".
const SERIAL_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function isValidSerial(serial: unknown): serial is string {
    return typeof serial === 'string' && serial.length > 0 && !serial.startsWith('-') && SERIAL_RE.test(serial);
}

/** Return the serial when valid, otherwise throw. */
export function assertSerial(serial: unknown): string {
    if (!isValidSerial(serial)) {
        const shown = typeof serial === 'string' ? JSON.stringify(serial) : typeof serial;
        throw new Error(`invalid adb serial: ${shown}`);
    }
    return serial;
}

const ADB_NETWORK_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;

/**
 * Validate an adb network endpoint in host:port form. This deliberately targets
 * IPv4 and DNS/MagicDNS names (the Tailscale MVP path); bracketed IPv6 can be
 * added later once every URL/serial consumer is proven to handle it.
 */
export function assertAdbNetworkAddress(address: unknown): string {
    if (typeof address !== 'string' || address.length === 0 || address.length > 320) {
        throw new Error('invalid adb network address');
    }
    const colon = address.lastIndexOf(':');
    if (colon <= 0 || colon === address.length - 1) {
        throw new Error('adb network address must be host:port');
    }
    const host = address.slice(0, colon);
    const portText = address.slice(colon + 1);
    const port = Number(portText);
    if (!ADB_NETWORK_HOST_RE.test(host) || host.endsWith('-') || host.includes('..')) {
        throw new Error('invalid adb network host');
    }
    if (!/^\d{1,5}$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('invalid adb network port');
    }
    return address;
}

/** Android Wireless debugging currently displays a six-digit pairing code. */
export function assertAdbPairingCode(code: unknown): string {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
        throw new Error('pairing code must be exactly 6 digits');
    }
    return code;
}

/** Host-generated password embedded in Android's standard ADB QR payload. */
export function assertAdbQrPairingPassword(password: unknown): string {
    if (typeof password !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(password)) {
        throw new Error('invalid QR pairing password');
    }
    return password;
}

// Encoder names look like `OMX.qcom.video.encoder.avc` / `c2.android.avc.encoder`.
const ENCODER_RE = /^[A-Za-z0-9_.-]{1,128}$/;

export function isSafeEncoderName(name: unknown): name is string {
    return typeof name === 'string' && ENCODER_RE.test(name);
}

/**
 * Validate an on-device push destination. The value is passed to `adb push` as
 * an argv element (no shell), so the only real hazards are option injection (a
 * leading "-") and an empty/NUL value; we keep the caller's chosen path
 * otherwise so the feature still works for arbitrary device locations.
 */
export function assertSafeRemotePath(name: unknown): string {
    if (typeof name !== 'string' || name.length === 0) {
        throw new Error('invalid remote path: empty');
    }
    if (name.startsWith('-')) {
        throw new Error('invalid remote path: may not start with "-"');
    }
    if (name.includes('\0')) {
        throw new Error('invalid remote path: contains NUL');
    }
    return name;
}

// Device storage/system roots whose recursive deletion would wipe user data or
// brick the device. The file browser only ever deletes user-selected entries
// *beneath* these, never the roots themselves, so we refuse them outright
// (after normalising trailing slashes).
const PROTECTED_ROOTS = new Set([
    '/',
    '/sdcard',
    '/storage',
    '/storage/emulated',
    '/storage/emulated/0',
    '/data',
    '/system',
    '/vendor',
    '/mnt',
    '/proc',
    '/dev',
]);

// A multi-select delete of more than this many entries is treated as abuse
// rather than a legitimate UI action.
const MAX_DELETE_PATHS = 1000;

/**
 * Validate a list of device paths targeted for a privileged recursive delete
 * (`rm -rf`). The op is auth-gated, but a bug or a same-origin script could
 * still drive it, so we defend in depth: the list must be a bounded array of
 * absolute, well-formed paths with no `.`/`..` traversal segments, and must not
 * name a catastrophic storage/system root. Returns the validated paths, else
 * throws.
 */
export function assertDeletablePaths(paths: unknown): string[] {
    if (!Array.isArray(paths) || paths.length === 0) {
        throw new Error('paths must be a non-empty array');
    }
    if (paths.length > MAX_DELETE_PATHS) {
        throw new Error(`too many paths: ${paths.length} (max ${MAX_DELETE_PATHS})`);
    }
    for (const p of paths) {
        if (typeof p !== 'string' || p.length === 0) {
            throw new Error('each path must be a non-empty string');
        }
        if (p.includes('\0')) {
            throw new Error('path contains NUL');
        }
        if (!p.startsWith('/')) {
            throw new Error(`path must be absolute: ${JSON.stringify(p)}`);
        }
        if (p.split('/').some((seg) => seg === '.' || seg === '..')) {
            throw new Error(`path may not contain "." or ".." segments: ${JSON.stringify(p)}`);
        }
        const normalized = p.replace(/\/+$/, '') || '/';
        if (PROTECTED_ROOTS.has(normalized)) {
            throw new Error(`refusing to delete a protected root: ${normalized}`);
        }
    }
    return paths as string[];
}

/**
 * Restricts remote QR endpoint discovery to a Tailscale-owned target.
 *
 * Port discovery is intentionally more powerful than a normal adb connect, so
 * it must never accept an arbitrary LAN or Internet host. Full MagicDNS names
 * are allowed; short MagicDNS aliases are not, because they cannot be
 * distinguished from arbitrary DNS names at validation time.
 */
export function assertTailscaleQrHost(host: unknown): string {
    if (typeof host !== 'string') throw new Error('Tailscale host is required');
    const normalized = host.trim().toLowerCase().replace(/\.$/, '');
    if (!normalized || normalized.length > 253) throw new Error('invalid Tailscale host');

    const octets = normalized.split('.');
    if (octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part))) {
        if (octets.some((part) => part.length > 1 && part.startsWith('0'))) {
            throw new Error('Tailscale IPv4 address must use canonical decimal octets');
        }
        const values = octets.map(Number);
        if (values.some((value) => value < 0 || value > 255)) throw new Error('invalid Tailscale IPv4 address');
        const [first, second] = values;
        if (first !== 100 || second! < 64 || second! > 127) {
            throw new Error('Tailscale QR requires an address in 100.64.0.0/10');
        }
        return normalized;
    }

    if (!normalized.endsWith('.ts.net')) {
        throw new Error('Tailscale QR requires a 100.x address or full .ts.net hostname');
    }
    const labels = normalized.split('.');
    if (
        labels.length < 4 ||
        labels.some(
            (label) => label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
        )
    ) {
        throw new Error('invalid Tailscale hostname');
    }
    return normalized;
}
