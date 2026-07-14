# Standard ADB QR Pairing

> This document records the initial same-LAN implementation. The later Tailscale discovery extension is specified in [Tailscale QR Pairing Extension](2026-07-15-tailscale-qr-pairing-design.md).

## Goal

Add Android's built-in **Pair device with QR code** flow to the existing network-device panel. Keep the pairing-code/Tailscale form as the fallback for remote networks.

## Protocol

The server generates the official ADB Wi-Fi payload:

```text
WIFI:T:ADB;S:<random-service-name>;P:<random-password>;;
```

After Android scans it, Android opens a temporary pairing server and advertises the requested instance on `_adb-tls-pairing._tcp`. The host waits for that exact mDNS instance, then delegates the cryptographic handshake to the bundled `adb pair` command.

## Boundaries

- QR pairing is same-LAN only because it depends on mDNS.
- The app does not enable Developer options or Wireless debugging.
- The app does not reimplement the ADB pairing protocol.
- One QR session is active per server and expires after 120 seconds.

## Security

- Service name, password, and session ID come from cryptographic randomness.
- The QR password uses a restricted base64url alphabet and is passed to `execFile` as one argv element.
- The password and raw QR payload are never returned by the HTTP API, persisted, or logged.
- Sessions match the exact requested mDNS instance, not any pairing service on the LAN.
- Starting a new session replaces the old one; terminal states clear the stored password.
