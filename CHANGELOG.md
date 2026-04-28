# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.6] - 2026-04-27

### Fixed

- **Windows service mode now actually runs the app.** v0.1.5 fixed Servy's install flag names so the wizard stopped erroring out, but service install was still broken in three deeper ways that only surfaced once you clicked through the install:
  - **`binPath` was wrong.** `ServiceApi.ts` passed `process.execPath` — the currently-running Node binary — as the executable Servy should launch. Servy then ran `node.exe` with no script argument, Node sat idle in REPL mode, port 8000 never bound, the wrapper reported RUNNING to SCM but the app was unreachable. Same architectural failure pattern as the v0.1.4 bare-`'adb'` bug: trusting an ambient resolution (`process.execPath` resolves through PATH in dev) instead of an explicit local-deps path. v0.1.6 binds `binPath` to `<install>/ws-scrcpy-web-launcher.exe`, the packaged launcher, which already knows how to spawn Node + supervise + manage the lifecycle. Existence-check before passing to Servy so dev/from-source runs return a clear 500 rather than installing a broken service.
  - **`startupDir` was never set.** Servy logs showed `Working directory fallback applied: C:\nvm4w\nodejs` — Servy fell back to the directory of the (wrong) `binPath`, and the launcher's relative resolution of `seed/`, `dependencies/`, `dist/` silently broke. v0.1.6 adds `startupDir` to `ServiceInstallOptions` and pins it to the install root on Windows. SystemdClient on Linux now emits a `WorkingDirectory=` directive from the same field.
  - **Service didn't auto-start after install.** Servy's `install` subcommand only registers the service; it doesn't start it. With `--startupType Automatic`, Windows would have started it at next boot, but the welcome modal's "yes install service" UX leads users to expect the service to come up live. v0.1.6 calls `servy-cli start --name <name>` immediately after `install`. Wrapped in try/catch so a start failure surfaces as a warning + a "stopped" status, not a failed install.
- **Service status was always "not installed."** v0.1.5 used `servy-cli list` to derive status, but **Servy 8.2 has no `list` subcommand at all** — invoking `list` fell through to Servy's help text, which our `parseServyListStatus` parsed and never matched. UI showed "not installed" even when the service was registered and running. v0.1.6 replaces the list-parser with `parseServyStatus` that calls `servy-cli status --name <name>` and matches Servy 8.2's actual output (`Service status for '<name>': <State>`). Servy returns non-zero with a "service not found" message when the service is absent; we map that one specific case to `'not-installed'` and rethrow other errors so genuine failures (binary missing, permission denied) surface to the API layer.
- **Admin elevation was unguarded.** Servy CLI requires Administrator to register services with SCM, but Velopack installs ws-scrcpy-web per-user under `%LocalAppData%` without elevation by default. An unelevated user clicking "yes install service" would either hit a UAC prompt that hung `execFileSync` (browser sees "couldn't reach server") or get a confusing 500. v0.1.6 adds `isWindowsAdmin()` (probes via `net session`) and `ServiceApi` returns `503` with an actionable "service install requires running ws-scrcpy-web as Administrator" message before invoking Servy when the process isn't elevated.
- Added `--recoveryAction RestartProcess` to install argv. v0.1.5 omitted `--recoveryAction` and Servy logs showed `recoveryAction: None`, so a child crash had no recovery — the wrapper would just stop. RestartProcess works for every supported account (including Local Service / Network Service if we ever switch off Local System).

### Migration note for users on v0.1.4 / v0.1.5

If you installed the Windows service via the welcome modal on v0.1.4 or v0.1.5, the service is registered with a broken configuration that points at Node-with-no-script. Clean up before reinstalling:

```
servy-cli.exe stop -n WsScrcpyWeb
servy-cli.exe uninstall -n WsScrcpyWeb
```

Then run ws-scrcpy-web v0.1.6 as Administrator and re-enable service mode from Settings → Service.

## [0.1.5] - 2026-04-27

### Fixed

- **Service install wizard hard-failed with "Option 'binPath' is unknown."** The Windows ServyClient was passing `--binPath`, `--account`, `--startType`, and `--logPath` — none of which are valid Servy 8.2 CLI flags (those names look like NSSM, which Servy was originally inspired by but does not match). Servy 8.2 uses `--path`, `--startupType`, `--stdout`, `--stderr`, and `--user` (the latter omitted entirely now). The bug was hidden during v0.1.4 fresh-VM smoke because that smoke stopped at "Setup runs, app launches, page reachable" — nobody clicked "yes install service" on the welcome modal. Fixed by:
  - Rewriting the install args in `src/server/service/ServyClient.ts` to use Servy 8.2's actual flag names: `--path` (not `--binPath`), `--startupType` (not `--startType`), and `--stdout` + `--stderr` (not `--logPath`, both pointed at the same file for a unified service log).
  - Dropping `--account` entirely. The Windows service now runs as Local System (Servy's default when `--user` is omitted), which side-steps password capture in the welcome modal and is the standard for tray-app service installs.
  - Removing the `account: ServiceAccount` field from the cross-platform `ServiceInstallOptions` interface, dropping the `ServiceAccount` type from `src/server/service/ServiceClient.ts`, and stripping the corresponding plumbing from `src/server/api/ServiceApi.ts`. SystemdClient on Linux had never actually consumed `account` (it derives behavior from `scope`), so the field was dead weight there too.
  - Updating `src/server/__tests__/ServyClient.test.ts` to assert the correct Servy 8.2 argv shape *and* explicitly assert that the v0.1.4-broken flag names (`--binPath`, `--account`, `--startType`, `--logPath`, `--user`) are NOT present in argv — regression guard against a future revert.

## [0.1.4] - 2026-04-27

**v0.1.0, v0.1.1, v0.1.2, AND v0.1.3 all shipped broken and have been withdrawn.** That's four broken releases in a row. If you installed any of them: apologies for the wasted time. v0.1.4 is the FIFTH attempt and the first one where every previously-deferred packaging-path bug has been closed instead of "noted for later."

The honest accounting of how we got here:

- **v0.1.0** — Setup.exe crashed on a clean Win11 install with `VCRUNTIME140.dll was not found`. The Rust launcher and tray binaries were dynamically linked against the Visual C++ Redistributable, which a clean Win11 doesn't ship. Fixed in v0.1.1 by statically linking the MSVC C runtime.
- **v0.1.1** — Setup.exe completed, but the launcher silent-failed at first run because no Node binary could be found at `<install>/current/seed/node/`. The SP3 spec called for shipping a bootstrap Node binary at that path, but the script that populates `seed/` was deferred during P6 packaging and never landed. Fixed in v0.1.2 with a `scripts/fetch-node.mjs` that downloads + SHA256-verifies Node v24.15.0 LTS during CI.
- **v0.1.2** — `seed/node/node.exe` shipped correctly, but the launcher STILL silent-failed because the supervisor was unconditionally setting `DEPS_PATH` on its own process env before calling `resolve_node`, making `resolve_node` enforce strict mode and refuse the seed fallback. Fixed in v0.1.3 by passing `DEPS_PATH` to the Node child env directly instead of the launcher's own env.
- **v0.1.3** — Setup.exe finally installed and the app launched, but the network scan (full + quick) and device discovery hung indefinitely on every click — chip never moved, cancel did nothing, only a page refresh reset the UI. Root cause: the server invoked bare `'adb'` (PATH lookup), and on a clean machine that hit ENOENT, while on a machine with a system adb already installed it triggered a version-mismatch hang. The chip-freeze symptom was made worse by `NetworkScanner.start()` having no `catch` block — any exception got silently swallowed by `ScanMw`'s `.catch(() => {})` and the WebSocket waited forever for a message that never came. **This bug was foreseeable.** A 2026-04-15 cross-platform audit had explicitly noticed that all `new AdbClient()` calls used the default `'adb'` PATH lookup AND that `Config.adbPath` itself didn't auto-resolve to the bundled binary — and filed both as "low priority — works when ADB is in the dependencies folder or on PATH." That self-granted deferral, made by the AI assistant doing the audit, was the actual cause of v0.1.3 shipping broken; the deferred items were the bug. v0.1.4 is the fix, plus a new architectural rule (in CLAUDE.md) that bans this category of deferral on installer-shipping projects.

### Fixed (v0.1.4)

- **Network scan + device discovery work again.** `Config.adbPath` now resolves *exclusively* to the local `<install>/dependencies/adb/adb[.exe]` path (or to a user-explicit `config.json` `adbPath` override). There is no system-PATH fallback. There is no `ADB_PATH` env-var resolution. If the bundled binary isn't there yet on first run, `DependencyManager.autoInstallMissing` fetches it; until it's present, adb-dependent operations throw `AdbExecError('spawn', ...)` and surface as a `scan.error` message in the UI rather than freezing the chip.
- **`AdbClient` constructor now requires an explicit `adbPath` argument** (compile-time guardrail). The previous `'adb'` default had silently masked the bug. All 6 production call sites (`DeviceProbe`, `AdbUtils`, `Device`, `FilePushReader`, `ControlCenter`, `ScrcpyConnection`) updated to pass `Config.getInstance().adbPath`.
- **Hard timeouts on adb control-plane calls.** `AdbClient.exec` now sets `timeout` + `killSignal: 'SIGKILL'` on `devices` (5s), `mdns services` (8s), `connect` (8s), `disconnect`/forward ops (5s). Long-running commands (`shell`, `push`, `pull`) remain unbounded by design.
- **Typed `AdbExecError`** carries `kind` (`timeout` | `spawn` | `exit` | `unknown`), the resolved `adbPath`, and the `args` so the failure message is debuggable from logs alone.
- **`NetworkScanner.start()` has a `catch` block** that emits `scan.error` with the exception message before `finally` resets state. Any future scanner-side failure surfaces visibly instead of hanging the UI.
- **`AdbClient.mdnsServices` no longer swallows errors** and returns `[]` — that behavior was the original sin masking the v0.1.3 hang. It now throws and lets the caller decide on degradation.

### Installation

- **Windows installer (`Setup.exe`)** — installs per-user under `%LocalAppData%`, no admin required. Best for most users. Velopack-managed auto-updates from the in-app **Settings** panel or the header **Update Available** button.
- **Linux AppImage** — single executable; `chmod +x` and run, on any glibc 2.31+ or musl-libc distro. Velopack-managed auto-updates.
- **Windows portable ZIP** — unzip and run; no install required, no auto-updates. Air-gapped friendly.
- Stable and beta release channels, switchable in Settings without reinstall.
- Manual install path still works: clone the repo, `npm install`, `npm start`.

### Service mode

- Optional Windows service (managed by [Servy](https://github.com/aelassas/servy)) so `ws-scrcpy-web` runs at login or boot. Pick from the first-run welcome modal or Settings → Service.
- Optional Linux systemd unit. User scope (no sudo) writes to `~/.config/systemd/user/`; system scope (requires sudo) writes to `/etc/systemd/system/`. Welcome modal asks per-platform; `loginctl enable-linger` keeps user-scope services alive after logout.
- A small system-tray icon on Windows shows a single confirm-and-exit dialog. (Linux skips the tray entirely; use the web UI Stop Server button.)

### Streaming features

- **Multi-codec video** (H.264, H.265, AV1) and **multi-codec audio** (Opus, AAC, FLAC, raw PCM), all decoded via WebCodecs in the browser. No WASM fallbacks.
- **Audio capture** is SDK-aware with three sources (output / playback / mic), per-device persisted preferences, and graceful gating for older Android. Playback mode keeps device audio audible during capture (Android 13+).
- **D-pad / Touch input modes** with a toolbar toggle for leanback TV apps. UHID keyboard and mouse with hardware-level input via USB HID. Scroll wheel and Shift+scroll forwarding tuned for high-latency streams.
- **Programmatic stream API**: load `ws-scrcpy.umd.js` or `ws-scrcpy.esm.js` and call `WsScrcpy.startStream(container, deviceId, options)` to embed a stream into any DOM element. Bundled TypeScript types. Thin `embed.html?device=<udid>` shim for iframe consumers.

### Device discovery

- **Network scan** combining mDNS (modern devices) with a TCP-port-5555 sweep (older devices that do not advertise). Auto-detects gateway subnet; accepts additional subnets as CIDR, bare IP, or IP range. mDNS and TCP hits dedupe automatically.
- **Quick Scan** button on the home page for fast mDNS-only discovery.
- **Device labels** persist across sessions, keyed by both serial and MAC, so devices keep their names whether they show up via mDNS or TCP.
- **Sleep / wake toggle** on each device card with server-polled state, kept in sync over WebSocket so buttons stay accurate when the device sleeps via timer or remote.

### UI

- **First-run welcome modal** that shows the chosen port (with auto-shift if 8000 is busy) and the service-install prompt.
- **Settings panel** (gear icon, top-right) for web port, auto-update preferences, channel selection, GitHub owner override, and service install/uninstall. Dev-mode banner when running from source.
- **Dark / light theme toggle** persisted in localStorage.
- File browser with breadcrumbs, sortable columns, drag-and-drop upload, download with progress, bulk delete.
- Remote ADB shell terminal with xterm.js.
- Browser tab title is now static ("Android Power Tools") on every page.

### Self-contained dependencies

- Bundled Node.js 24.15.0 LTS (ships in the installer payload, no first-run download needed). ADB platform-tools and `scrcpy-server` v3.3.4 download on first run with SHA256 verification.
- Native `node-pty` prebuilds for Windows (x64, arm64) and Linux glibc (x64, arm64), built weekly via GitHub Actions matrix. Falls back to source-compile on unsupported targets.
- **In-app dependency updater** in the Settings panel: check and update Node.js, ADB, and `scrcpy-server` from the home page with one click.

### Linux portability

- Launcher built for `x86_64-unknown-linux-musl` — zero glibc dependency on the launcher itself. The bundled Node 24 binary still requires glibc 2.31+, which is the actual minimum-glibc for the full app.
- AppImage runtime stub swapped post-`vpk pack` with the upstream static-fuse runtime from [AppImage/type2-runtime](https://github.com/AppImage/type2-runtime). The .AppImage no longer needs `libfuse2` or `libfuse3` installed on the host.

### Privacy and code signing

- `PRIVACY.md` documents outbound traffic (update checks, optional dep installs from `nodejs.org`, `dl.google.com`, `github.com`). No telemetry. No analytics. No project-operated server.
- Code signing via [SignPath Foundation](https://signpath.org)'s free OSS program — application is in review. Once approved, the next release will be the first signed release. Until then, integrity is verifiable via the `SHA256SUMS` file shipped with each release.

## [0.1.3] - 2026-04-27 [YANKED]

**Withdrawn.** Setup.exe installed and the app launched, but the network scan (full + quick) and device discovery hung on every click — chip frozen at 0/N, cancel button non-functional, only a page refresh reset the UI. Root cause was bare `'adb'` PATH lookup combined with a missing `catch` block in the scanner's main try. See [0.1.4] above for the full root-cause writeup and fix. The GitHub Release page was deleted. Tag retained for archaeology.

## [0.1.2] - 2026-04-27 [YANKED]

**First actually-installable release.** v0.1.0 (initial tag) and v0.1.1 (VCRUNTIME fix + branded icons) both shipped with broken installers — v0.1.0 crashed on a clean Win11 install with `VCRUNTIME140.dll was not found`, and v0.1.1 fixed that crash but exposed a separate gap where the post-install app launch silent-failed because the bundled Node bootstrap binary was missing from the installer payload. Both have been withdrawn from the Releases page; this is the first version that actually installs and runs end-to-end on a clean machine. See § Install-blocker fixes below for the full chain.

### Install-blocker fixes (the v0.1.0 → v0.1.2 journey)

- **v0.1.1 fix → still in v0.1.2:** the Rust launcher and tray binaries now statically link the MSVC C runtime (`-C target-feature=+crt-static`), so they have no runtime DLL dependency on the Visual C++ Redistributable. v0.1.0 crashed with `VCRUNTIME140.dll was not found` on any Windows install missing VCRedist (true of fresh Win11). Verified with `dumpbin /dependents`: only Windows-native DLLs remain.
- **v0.1.2 fix:** `Setup.exe` now actually launches the installed app. v0.1.1 fixed the VCRUNTIME crash but the launcher then silent-failed at first run because no Node binary could be found at `<install>/current/seed/node/`. Process lifetime was under 200 ms — invisible in Task Manager. The SP3 spec called for shipping a bootstrap Node binary at that path, but the script that populates `seed/` was deferred during P6 packaging and never landed. New `scripts/fetch-node.mjs` downloads + SHA256-verifies Node v24.15.0 LTS from `nodejs.org/dist/`, stages the binary into `seed/node/`, and is invoked from `release.yml` before `stage-publish.mjs` on both Windows and Linux jobs.
- **v0.1.1 fix → still in v0.1.2:** branded app icon now appears in Explorer, taskbar, Start Menu, Add/Remove Programs, and the Setup.exe installer itself. Setup.exe gets it via `vpk pack --icon`; launcher and tray binaries embed it via `winresource`-driven `build.rs` files.
- **v0.1.1 change → still in v0.1.2:** the broken Velopack `--msiDeploymentTool` MSI artifact was withdrawn from the release pipeline. It was an SCCM/Intune deployment-tool harness, not a user-clickable installer. Setup.exe (per-user, wizardful) and Portable.zip remain the supported Windows install paths. A real user-facing WiX MSI is logged as a future enhancement.
- **v0.1.2 change:** Linux AppImage is now truly portable — `chmod +x` and run on any Linux from the last 18 years. Two changes land together: (i) the Rust launcher is built for `x86_64-unknown-linux-musl`, so the binary itself has zero glibc dependency (`ldd` on the shipped ELF reports `not a dynamic executable`); (ii) the AppImage runtime stub is swapped post-`vpk pack` with the upstream static-fuse runtime from [AppImage/type2-runtime](https://github.com/AppImage/type2-runtime), so the .AppImage no longer needs `libfuse2` (or `libfuse3`) installed on the host. Net minimum-glibc is still 2.31+ (set by the bundled Node 24), but the launcher itself runs on anything including musl-libc distros like Alpine.

### Installation

- **Windows installer (`Setup.exe`)** — installs per-user under `%LocalAppData%`, no admin required. Best for most users. Velopack-managed auto-updates from the in-app **Settings** panel or the header **Update Available** button.
- **Linux AppImage** — single executable; `chmod +x` and run, on any glibc 2.31+ or musl-libc distro. Velopack-managed auto-updates.
- **Windows portable ZIP** — unzip and run; no install required, no auto-updates. Air-gapped friendly.
- Stable and beta release channels, switchable in Settings without reinstall.
- Manual install path still works: clone the repo, `npm install`, `npm start`.

### Service mode

- Optional Windows service (managed by [Servy](https://github.com/aelassas/servy)) so `ws-scrcpy-web` runs at login or boot. Pick from the first-run welcome modal or Settings → Service.
- Optional Linux systemd unit. User scope (no sudo) writes to `~/.config/systemd/user/`; system scope (requires sudo) writes to `/etc/systemd/system/`. Welcome modal asks per-platform; `loginctl enable-linger` keeps user-scope services alive after logout.
- A small system-tray icon on Windows shows a single confirm-and-exit dialog. (Linux skips the tray entirely; use the web UI Stop Server button.)

### Streaming features

- **Multi-codec video** (H.264, H.265, AV1) and **multi-codec audio** (Opus, AAC, FLAC, raw PCM), all decoded via WebCodecs in the browser. No WASM fallbacks.
- **Audio capture** is SDK-aware with three sources (output / playback / mic), per-device persisted preferences, and graceful gating for older Android. Playback mode keeps device audio audible during capture (Android 13+).
- **D-pad / Touch input modes** with a toolbar toggle for leanback TV apps. UHID keyboard and mouse with hardware-level input via USB HID. Scroll wheel and Shift+scroll forwarding tuned for high-latency streams.
- **Programmatic stream API**: load `ws-scrcpy.umd.js` or `ws-scrcpy.esm.js` and call `WsScrcpy.startStream(container, deviceId, options)` to embed a stream into any DOM element. Bundled TypeScript types. Thin `embed.html?device=<udid>` shim for iframe consumers.

### Device discovery

- **Network scan** combining mDNS (modern devices) with a TCP-port-5555 sweep (older devices that do not advertise). Auto-detects gateway subnet; accepts additional subnets as CIDR, bare IP, or IP range. mDNS and TCP hits dedupe automatically.
- **Quick Scan** button on the home page for fast mDNS-only discovery.
- **Device labels** persist across sessions, keyed by both serial and MAC, so devices keep their names whether they show up via mDNS or TCP.
- **Sleep / wake toggle** on each device card with server-polled state, kept in sync over WebSocket so buttons stay accurate when the device sleeps via timer or remote.

### UI

- **First-run welcome modal** that shows the chosen port (with auto-shift if 8000 is busy) and the service-install prompt.
- **Settings panel** (gear icon, top-right) for web port, auto-update preferences, channel selection, GitHub owner override, and service install/uninstall. Dev-mode banner when running from source.
- **Dark / light theme toggle** persisted in localStorage.
- File browser with breadcrumbs, sortable columns, drag-and-drop upload, download with progress, bulk delete.
- Remote ADB shell terminal with xterm.js.
- Browser tab title is now static ("Android Power Tools") on every page.

### Self-contained dependencies

- Bundled Node.js 24.15.0 LTS, ADB platform-tools, and `scrcpy-server` v3.3.4. The app downloads ADB and `scrcpy-server` on first run if missing, with SHA256 verification. Node ships in the installer payload itself (the v0.1.2 fix above) so first-run works offline.
- Native `node-pty` prebuilds for Windows (x64, arm64) and Linux glibc (x64, arm64), built weekly via GitHub Actions matrix. Falls back to source-compile on unsupported targets.
- **In-app dependency updater** in the Settings panel: check and update Node.js, ADB, and `scrcpy-server` from the home page with one click.

### Privacy and code signing

- `PRIVACY.md` documents outbound traffic (update checks, optional dep installs from `nodejs.org`, `dl.google.com`, `github.com`). No telemetry. No analytics. No project-operated server.
- Code signing via [SignPath Foundation](https://signpath.org)'s free OSS program — application is in review. Once approved, the next release will be the first signed release. Until then, integrity is verifiable via the `SHA256SUMS` file shipped with each release.

## [0.1.1] - 2026-04-27 [YANKED]

### Fixed

- **Setup.exe now installs successfully on clean Windows boxes.** v0.1.0 failed with `VCRUNTIME140.dll was not found` → `application install hook failed` on any machine missing the Visual C++ Redistributable (true of a fresh Win11 install). The Rust launcher and tray binaries now statically link the MSVC C runtime (`-C target-feature=+crt-static`), so they have no runtime DLL dependency on VCRedist. Verified with `dumpbin /dependents`: only Windows-native DLLs remain. *(Setup.exe install completes; app launch is still broken in v0.1.1 — see v0.1.2.)*
- Internal: `libcDetect.test.ts` mock typing widened from `string` to `fs.PathLike`, and `detectInstallScope` now uses `path.win32.dirname` for execPath splitting on POSIX CI hosts. CI-only fixes; no runtime behavior change.

### Changed

- **Branded app icon** now appears in Explorer, taskbar, Start Menu, Add/Remove Programs, and the Setup.exe installer itself. Previously all three displayed the default Rust toolchain / Velopack generic icon. Setup.exe gets it via `vpk pack --icon`; the launcher and tray binaries embed it via new `build.rs` files using the `winresource` crate.

### Removed

- **Windows MSI artifact withdrawn.** The MSI we shipped in v0.1.0 was Velopack's `--msiDeploymentTool` output — designed for SCCM / Intune mass deployment, not user-clickable (it silently registered as a "Deployment Tool" in Add/Remove Programs without installing the actual app). Setup.exe (per-user, wizardful) and Portable.zip remain the supported Windows install paths. A real user-facing WiX MSI is logged as a future enhancement.

## [0.1.0] - 2026-04-27 [YANKED]

First public release.

### Installation

- **Windows installer (`Setup.exe`)** — installs per-user under `%LocalAppData%`, no admin required. Best for most users. Velopack-managed auto-updates from the in-app **Settings** panel or the header **Update Available** button.
- **Windows MSI** — installs system-wide under `Program Files` (requires admin). For corporate / SCCM / Group Policy deployment scenarios. Same auto-update behavior as Setup.exe.
- **Linux AppImage** — single executable; `chmod +x` and run. Velopack-managed auto-updates.
- **Windows portable ZIP** — unzip and run; no install required, no auto-updates. Air-gapped friendly.
- Stable and beta release channels, switchable in Settings without reinstall.
- Manual install path still works: clone the repo, `npm install`, `npm start`.

### Service mode

- Optional Windows service (managed by [Servy](https://github.com/aelassas/servy)) so `ws-scrcpy-web` runs at login or boot. Pick from the first-run welcome modal or Settings → Service.
- Optional Linux systemd unit. User scope (no sudo) writes to `~/.config/systemd/user/`; system scope (requires sudo) writes to `/etc/systemd/system/`. Welcome modal asks per-platform; `loginctl enable-linger` keeps user-scope services alive after logout.
- A small system-tray icon on Windows shows a single confirm-and-exit dialog. (Linux skips the tray entirely; use the web UI Stop Server button.)

### Streaming features

- **Multi-codec video** (H.264, H.265, AV1) and **multi-codec audio** (Opus, AAC, FLAC, raw PCM), all decoded via WebCodecs in the browser. No WASM fallbacks.
- **Audio capture** is SDK-aware with three sources (output / playback / mic), per-device persisted preferences, and graceful gating for older Android. Playback mode keeps device audio audible during capture (Android 13+).
- **D-pad / Touch input modes** with a toolbar toggle for leanback TV apps. UHID keyboard and mouse with hardware-level input via USB HID. Scroll wheel and Shift+scroll forwarding tuned for high-latency streams.
- **Programmatic stream API**: load `ws-scrcpy.umd.js` or `ws-scrcpy.esm.js` and call `WsScrcpy.startStream(container, deviceId, options)` to embed a stream into any DOM element. Bundled TypeScript types. Thin `embed.html?device=<udid>` shim for iframe consumers.

### Device discovery

- **Network scan** combining mDNS (modern devices) with a TCP-port-5555 sweep (older devices that do not advertise). Auto-detects gateway subnet; accepts additional subnets as CIDR, bare IP, or IP range. mDNS and TCP hits dedupe automatically.
- **Quick Scan** button on the home page for fast mDNS-only discovery.
- **Device labels** persist across sessions, keyed by both serial and MAC, so devices keep their names whether they show up via mDNS or TCP.
- **Sleep / wake toggle** on each device card with server-polled state, kept in sync over WebSocket so buttons stay accurate when the device sleeps via timer or remote.

### UI

- New **first-run welcome modal** that shows the chosen port (with auto-shift if 8000 is busy) and the service-install prompt.
- **Settings panel** (gear icon, top-right) for web port, auto-update preferences, channel selection, GitHub owner override, and service install/uninstall. Dev-mode banner when running from source.
- **Dark / light theme toggle** persisted in localStorage.
- File browser with breadcrumbs, sortable columns, drag-and-drop upload, download with progress, bulk delete.
- Remote ADB shell terminal with xterm.js.
- Browser tab title is now static ("Android Power Tools") on every page.

### Self-contained dependencies

- Bundled Node.js, ADB platform-tools, and `scrcpy-server` v3.3.4. The app downloads these on first run if missing, with SHA256 verification.
- Native `node-pty` prebuilds for Windows (x64, arm64) and Linux glibc (x64, arm64), built weekly via GitHub Actions matrix. Falls back to source-compile on unsupported targets.
- **In-app dependency updater** in the Settings panel: check and update Node.js, ADB, and `scrcpy-server` from the home page with one click.

### Privacy and code signing

- New `PRIVACY.md` documenting outbound traffic (update checks, optional dep installs from nodejs.org / dl.google.com / github.com). No telemetry. No analytics. No project-operated server.
- Code signing via [SignPath Foundation](https://signpath.org)'s free OSS program — application is in review at v0.1.0 release. Once approved, **v0.1.1** will be the first signed release. Until then, integrity is verifiable via the `SHA256SUMS` file shipped with the release.

### Notes

- See `docs/RELEASING.md` for the release runbook.
- `docs/TECHNICAL_GUIDE.md` covers architecture and module-level details.

## [1.0.0] - 2026-04-17

First public release. Browser-based Android screen mirroring rebuilt from the ground up on vanilla scrcpy v3.x with a modernized Node.js + TypeScript stack.

### Added

**Stream API + embed mode** (this release's headline)
- Public `WsScrcpy.startStream(container, deviceId, options)` library shipped as UMD (`ws-scrcpy.umd.js`) and ES module (`ws-scrcpy.esm.js`) with bundled TypeScript types (`ws-scrcpy.d.ts`)
- `/embed.html?device=<udid>` thin wrapper for iframe consumers; transparent background, auto-connect, full toolbar
- `StreamHandle` with idempotent `stop()`, `isConnected`, `deviceId`
- `onConnect` / `onDisconnect` / `onError` lifecycle callbacks with typed payloads
- Full URL parameter surface (`host`, `port`, `secure`, `pathname`, `codec`, `encoder`, `bitrate`, `maxFps`, `maxSize`, `audio`, `keyboard`)

**Modal system**
- Native HTML `<dialog>` base class (`Modal`) with glassmorphism styling, `@starting-style` transitions, and `addHeaderButton()` helper
- `ConfigureScrcpy`, `ShellModal`, `ConnectModal`, `ListFilesModal` all extend the base class
- Device labels displayed in modal headers

**File browser** (`ListFilesModal`)
- Sticky header, reserved actions column, SVG hover icons that scale with size picker, sortable columns, breadcrumb navigation, bulk selection, drag-and-drop upload, download with progress, client-side filter

**Input**
- UHID keyboard + mouse via USB HID report descriptors (pointer lock)
- D-pad / Touch input mode toggle (D-pad default for TV apps, fire-then-debounce for scroll wheel)
- Scroll wheel with i16fp encoding (`sc_float_to_i16fp`) and latent-stream-tuned normalization
- Clipboard toolbar buttons (GET device→host, SET host→device) — modernized from legacy MoreBox textarea flow

**Codecs**
- Multi-codec video: H.264, H.265 (HEVC), AV1 with smart auto-selection (H.265 preferred, falls back to H.264 for Firefox)
- Multi-codec audio: Opus, AAC, FLAC, raw PCM via WebCodecs `AudioDecoder` + `AudioWorklet`
- HEVC SPS parser with RBSP stripping, AV1 config record parser
- Edge H.265 rendering fix: 8-arg `drawImage` using full coded rect as source (Edge reports display dims ≠ coded dims)

**Device management**
- Connected-devices card grid with live WebSocket updates
- Network scan via `adb mdns services` with one-click connect
- Device labels persisted to `device-labels.json`, keyed by `ro.serialno`
- Per-card sleep/wake toggle with server-side polling (`dumpsys power`, 5s loop, `Promise.all` concurrency)
- Disconnect button for network-connected devices

**Deployment**
- Self-contained folder layout: `dependencies/node/`, `dependencies/adb/`, `start.cmd` / `start.sh` launcher scripts
- In-app updater for Node.js + node-pty (paired), ADB platform-tools, scrcpy-server
- Windows file-locking workaround: rename running `node.exe`, write `.restart` marker, launcher relaunches
- Dark/light theme toggle with localStorage persistence

**Server**
- Tagged logger (`Logger.for('Tag')`) replaces all raw `console.log`; tees to `ws-scrcpy-web.log` with ISO timestamps, 5MB rotation
- `uncaughtException` + `unhandledRejection` handlers log to file before exit
- Crash-safe WebSocket close (readyState guard, 123-byte reason truncation)
- Vanilla scrcpy-server v3.3.4 binary; no Java patching

**API endpoints**
- `GET /api/dependencies/*` — updater status and operations
- `GET /api/devices/labels` / `PUT /api/devices/labels`
- `POST /api/devices/scan` — mDNS discovery
- `POST /api/devices/connect` / `POST /api/devices/disconnect`
- `POST /api/devices/files/*` — file browser operations including delete

**Quality stats overlay**
- Top-left HUD shows resolution, video codec, encoder name, bitrate, FPS counters; font scales with canvas resolution
- Toolbar bar-chart button toggles stats visibility
- Server echoes encoder in session metadata

**Tests**
- Vitest suite for control messages, binary readers/writers, multiplexer, codec configs, device labels
- 87 tests passing across the final release

### Changed

- Dependencies overhaul: Node 24 LTS, TypeScript 6, Biome 2, webpack 5, node-pty 1.1.0, xterm 6.x
- Runtime dependencies reduced to 2 total: `ws`, `node-pty`
- Control message protocol: `ScrollControlMessage` now 20-byte int16 (not 25-byte int32); `TouchControlMessage` payload corrected to 31 bytes
- Default keyboard: ON at stream start
- Default FPS: 15 (tuned for latent network streams)
- Default encoder: auto-selects hardware HEVC (`c2.mtk.hevc.encoder`, Qualcomm or Exynos equivalents)
- Home page centered at max-width 1800px (5 cards on 4K)
- Toolbar icons centered via SVG sizing; vertical spacing increased

### Removed

- iOS support, Chrome DevTools proxy, WASM decoder fallbacks, vendor decoder shims (~6,500 lines deleted)
- `adbkit`, Express, YAML, ESLint, path-browserify (replaced by own implementations)
- `GoogMoreBox` (383 lines) — clipboard flow replaced by toolbar buttons
- `#!action=stream` URL hash routing
- `?embed=true` URL parameter and all `body.embed` CSS rules
- Patched `scrcpy-server.jar` — project now uses unmodified Genymobile binaries

### Fixed

- Edge WebCodecs H.265 displayWidth/codedWidth mismatch causing blurry or clipped frames
- Firefox `VideoDecoder.isConfigSupported` falsely rejecting `avc1.42E01E` — H.264 now skips the check
- Mouse click freeze after stream-quality refresh (race: old demuxer's async `onclose` fired after `isRefreshing` reset)
- Stale device cards persisting across disconnects (ControlCenter + client-side `updateDescriptor` both now remove disconnected devices)
- Scan Network missed plain `_adb._tcp` services (filter was restricted to `_adb-tls-connect`)
- `RemoteShell` crash from `ws.send()` on closed socket (readyState guard)
- `AdbUtils.ts` and `RemoteShell.ts` cross-platform fixes (hardcoded `'adb'` → `Config.adbPath`, `env.PWD` → `process.cwd()`)

### Security

- WebSocket close reason truncated to 123-byte spec limit with try/catch — offline devices no longer crash the Node process
