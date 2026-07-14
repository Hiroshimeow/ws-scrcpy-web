# ADB QR Pairing Implementation Plan

- [x] Add an in-memory, expiring QR session manager.
- [x] Generate the official Android ADB Wi-Fi QR payload.
- [x] Match the exact `_adb-tls-pairing._tcp` mDNS instance.
- [x] Add a separate `pairQr` path for non-numeric QR passwords while preserving six-digit PIN validation.
- [x] Add start/status/cancel APIs with `Cache-Control: no-store`.
- [x] Add a responsive QR panel and polling flow to the browser UI.
- [x] Preserve pairing-code/Tailscale and manual-connect fallbacks.
- [x] Cover expiry, cancellation, replacement, redaction, race handling, API behavior, SVG rendering, and UI behavior with tests.
- [x] Production-build and visually smoke-test the panel in Chromium.
- [x] Screenshot the rendered QR and decode it independently back to the expected `WIFI:T:ADB` payload.
- [x] Run the complete TypeScript/Rust/build gates.
- [ ] Verify the final flow with a physical Android phone on the same LAN.
