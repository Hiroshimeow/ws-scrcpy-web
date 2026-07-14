# Tailscale QR Pairing Implementation Plan

- [x] Add LAN/Tailscale modes to the existing QR panel.
- [x] Accept only Tailscale CGNAT IPv4 or full `.ts.net` targets.
- [x] Add a bounded, cancellable high-port scanner with a fixed worker pool.
- [x] Use one abort listener for all active scan sockets and clean it up after every run.
- [x] Discover the temporary pairing endpoint by trying the generated QR password with bundled `adb pair`.
- [x] Discover and connect the authenticated secure-ADB endpoint after pairing.
- [x] Preserve same-LAN mDNS QR and manual pairing-code/Tailscale flows.
- [x] Keep QR secrets out of HTTP responses, persistence, logs, and typed ADB errors.
- [x] Cover target validation, scanning, cancellation, retries, API behavior, UI mode switching, and secret redaction.
- [x] Stress the full 32,768-port scanner and repeat deterministic scanner tests.
- [x] Run complete TypeScript, Rust, production-build, package-stage, and visual Chromium gates.
- [ ] Verify Tailscale QR on a physical Android device; record OEM/ROM behavior.

## Verification evidence

- Biome checked 474 source files; TypeScript `--noEmit` completed without errors.
- Vitest passed 177 files / 1,544 tests; Rust passed 193 tests; clippy passed with `-D warnings`.
- Production browser/server/UMD/ESM/embed/type builds completed for `0.1.30-beta.78`.
- Linux package staging completed with a static-pie launcher, staged Node `v24.15.0`, six required runtime assets, and synchronized package metadata.
- Full 32,768-port scanner benchmark: 1,037 ms median across five runs; cancellation completed in 65.7 ms; no listener warnings.
- Chromium staged-package visual checks passed for desktop 1440×1000 and mobile 390×844. The QR form, target input, action button, and QR image remained inside the mobile viewport with no overlap or console errors. The final staged frontend bundle SHA-256 (`498b71afcf5dd36e757f7bd2013760efc69d9d68c055e926962acc43bfb81284`) matches the visually inspected bundle.
- Staged API smoke verified request-gate cookies, version reporting, secret-free QR responses, cancellation, and canonical Tailscale target rejection.
- Physical Android/Tailscale acceptance remains intentionally unchecked because no Android device was available on G8.
