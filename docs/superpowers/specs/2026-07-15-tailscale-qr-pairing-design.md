# Tailscale QR Pairing Extension

## Goal

Extend the existing official Android `WIFI:T:ADB` QR flow across a Tailscale tailnet without installing a ws-scrcpy client on Android and without asking the Android owner to transcribe temporary ADB ports or a six-digit code.

## Protocol constraint

The QR payload contains only a random service name and password. Android publishes the temporary pairing endpoint through mDNS, but multicast DNS does not traverse Tailscale. The host therefore cannot learn the port from the QR or from tailnet DNS.

AOSP starts both the QR pairing server and the authenticated secure-connect server on kernel-selected TCP ports and binds them to `INADDR_ANY`. The extension preserves ADB's pairing protocol and delegates all cryptography to the bundled `adb pair`/`adb connect` commands; it only replaces mDNS discovery with bounded TCP endpoint discovery.

## Flow

1. The user selects Tailscale QR and supplies one Android `100.64.0.0/10` address or full `.ts.net` hostname.
2. The server creates the same random official QR payload used by LAN mode.
3. A full MagicDNS hostname is resolved exactly once and must resolve to Tailscale CGNAT (`100.64.0.0/10`); literal IPv4 input must already be canonical CGNAT form.
4. A cancellable worker pool scans TCP ports `32768-65535` on that single resolved target.
5. Each open candidate is tried with `adb pair <host:port> <random-QR-password>` until ADB confirms pairing. A transiently failing candidate is retried at most three times.
6. The server rescans and tries the other open candidates with `adb connect` until the authenticated endpoint confirms connection.
7. The public status reports only state, target, and final address. The password and raw payload never leave server memory.

## Security boundaries

- Targets are restricted to canonical Tailscale CGNAT IPv4 (`100.64.0.0/10`) or a syntactically valid full `device.tailnet.ts.net` hostname whose one-time IPv4 resolution also falls inside CGNAT.
- Arbitrary LAN, localhost, Internet, non-canonical IPv4, and short `.ts.net` targets are rejected before port probes start.
- The scan range is capped at 32,768 ports, concurrency at 1,024, per-socket timeout at five seconds, and discovered ports at 256. Production defaults use 512 workers, a 500 ms timeout, and at most 16 open ports.
- One shared abort listener owns all active sockets, preventing listener leaks and allowing cancellation/expiry to tear down the scan immediately.
- ADB pairing secrets are passed as one `execFile` argument and redacted from typed errors, command previews, and preserved causes.
- One QR session is active per server. Starting another session aborts and clears the prior one.

## Runtime boundaries

- Tailscale must already be installed and connected on Windows and Android.
- Developer options and Wireless debugging must be enabled manually on Android.
- OEM Android networking policy may still make Wireless debugging unreachable through the VPN interface. The explicit pairing-code form remains the supported fallback.
- Automated tests can prove scanning, state transitions, cancellation, input restrictions, and secret handling. End-to-end acceptance still requires a physical Android device on the target ROM/tailnet.
