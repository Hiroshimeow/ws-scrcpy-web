# Stable Stream Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make new stream sessions start with the most compatible settings—H.264, a hardware AVC encoder when available, 4 Mbps, 20 FPS, and audio disabled—without removing, disabling, or locking any existing option.

**Architecture:** Keep the existing `ConfigureScrcpy` UI and scrcpy connection pipeline unchanged. Adjust only preferred defaults and encoder ordering, then persist the user-selected video codec in the existing per-device `video` settings scope so explicit choices override defaults on later sessions.

**Tech Stack:** TypeScript, DOM APIs, Vitest/jsdom, existing `SettingsService`, existing `VideoSettings`, WebCodecs player.

## Global Constraints

- Preserve H.265, AV1, audio, encoder, bitrate, FPS, shell, file-manager, keyboard, and control features.
- Defaults are recommendations, not fixed values.
- Default video codec is `h264`.
- Default bitrate is `4_000_000` bits/s.
- Default maximum frame rate is `20` FPS.
- Default audio state is disabled; a saved explicit enabled state remains respected.
- Prefer a vendor/hardware encoder over Android/Google software encoders while preserving the device-provided order inside each class.
- A saved supported codec and encoder must win over defaults.
- Reset restores the stable defaults without saving until the user presses Save.
- No new dependency and no unrelated UI refactor.

---

### Task 1: Stable media defaults

**Files:**
- Modify: `src/common/__tests__/audioDefaults.test.ts`
- Modify: `src/common/AudioDefaults.ts`
- Create: `src/app/player/__tests__/stableStreamDefaults.test.ts`
- Modify: `src/app/player/WebCodecsPlayer.ts`

**Interfaces:**
- Consumes: `audioEnabledDefault(kind)` and `WebCodecsPlayer.preferredVideoSettings`.
- Produces: audio disabled by default; preferred video settings of 4 Mbps and 20 FPS.

- [ ] **Step 1: Change audio tests to require disabled defaults**

```ts
expect(audioEnabledDefault('phone')).toBe(false);
expect(audioEnabledDefault('tablet')).toBe(false);
expect(audioEnabledDefault('tv')).toBe(false);
expect(audioEnabledDefault(undefined)).toBe(false);
```

- [ ] **Step 2: Add a failing preferred-video test**

```ts
expect(WebCodecsPlayer.preferredVideoSettings.bitrate).toBe(4_000_000);
expect(WebCodecsPlayer.preferredVideoSettings.maxFps).toBe(20);
```

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
npx vitest run src/common/__tests__/audioDefaults.test.ts src/app/player/__tests__/stableStreamDefaults.test.ts --reporter=verbose
```

Expected: failures showing current audio default `true`, bitrate `8_000_000`, and FPS `15`.

- [ ] **Step 4: Implement the minimal defaults**

```ts
export function audioEnabledDefault(_kind: DeviceKind | undefined): boolean {
    return false;
}
```

```ts
bitrate: 4_000_000,
maxFps: 20,
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the command from Step 3. Expected: all tests pass.

### Task 2: Stable encoder preference and codec persistence

**Files:**
- Modify: `src/app/googDevice/client/__tests__/ConfigureScrcpy.codecSelection.test.ts`
- Modify: `src/app/player/__tests__/basePlayerVideoStorage.test.ts`
- Modify: `src/app/client/SettingsService.ts`
- Modify: `src/app/player/BasePlayer.ts`
- Modify: `src/app/googDevice/client/ConfigureScrcpy.ts`

**Interfaces:**
- Consumes: `StoredVideo`, `PlayerClass.saveVideoSettings`, `ConfigureScrcpy.onProbeResult`.
- Produces: `StoredVideo.codec?: 'h264' | 'h265' | 'av1'`; optional codec argument on video-setting persistence; hardware-first encoder ordering.

- [ ] **Step 1: Add failing tests**

Add tests that prove:

```ts
// Hardware AVC wins even when software AVC is listed first.
videoEncoders: ['c2.android.avc.encoder', 'c2.exynos.avc.encoder'];
expect(encoder.value).toBe('c2.exynos.avc.encoder');

// A saved supported H.265 selection is restored.
settingsService.getDeviceVideo(udid) -> { codec: 'h265', settings: { encoderName: 'c2.exynos.hevc.encoder' } };
expect(codec.value).toBe('h265');
expect(encoder.value).toBe('c2.exynos.hevc.encoder');

// Persistence stores the explicit codec beside settings and fit.
expect(video.codec).toBe('h265');
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npx vitest run src/app/googDevice/client/__tests__/ConfigureScrcpy.codecSelection.test.ts src/app/player/__tests__/basePlayerVideoStorage.test.ts --reporter=verbose
```

Expected: hardware-order, saved-codec, and persisted-codec assertions fail.

- [ ] **Step 3: Extend existing storage shape minimally**

```ts
export interface StoredVideo {
    settings?: Record<string, unknown>;
    fit?: boolean;
    codec?: 'h264' | 'h265' | 'av1';
}
```

Thread the optional codec through `PlayerClass.saveVideoSettings`, `BasePlayer.saveVideoSettings`, and `putVideoSettingsToStorage`; include it in the single `setDeviceVideo` write.

- [ ] **Step 4: Restore saved codec and prefer hardware encoders**

After codec options are populated, select a stored codec only when present in the supported option list. Filter encoders by codec, then stable-sort software encoders (`c2.android`, `OMX.google`, or names containing `software`) after other encoders. Keep a previously selected compatible encoder.

- [ ] **Step 5: Save explicit codec with video settings**

Pass the selected validated codec into `player.saveVideoSettings(...)` from the existing Save handler.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: all tests pass.

### Task 3: Reset behavior, release metadata, and regression

**Files:**
- Modify: `src/app/googDevice/client/__tests__/ConfigureScrcpy.codecSelection.test.ts`
- Modify: `src/app/googDevice/client/ConfigureScrcpy.ts`
- Modify: `CHANGELOG.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `Cargo.toml`
- Modify: `Cargo.lock`

**Interfaces:**
- Consumes: stable defaults from Tasks 1–2.
- Produces: Reset restores H.264, stable encoder ordering, audio disabled, and preferred bitrate/FPS; release `0.1.30-beta.75`.

- [ ] **Step 1: Add a failing reset test**

Construct a modal with H.265/audio enabled and invoke Reset. Assert:

```ts
expect(codec.value).toBe('h264');
expect(audioEnabled.checked).toBe(false);
expect(maxFps.value).toBe('20');
expect(bitrate.value).toBe('4000000');
```

- [ ] **Step 2: Run the reset test and verify RED**

```bash
npx vitest run src/app/googDevice/client/__tests__/ConfigureScrcpy.codecSelection.test.ts --reporter=verbose
```

Expected: codec and audio remain user-selected.

- [ ] **Step 3: Implement minimal reset behavior**

Use the existing preferred `VideoSettings`, choose H.264 when available, repopulate the encoder list, clear the audio checkbox, and dispatch its existing change handler so audio controls reflect the state. Do not save automatically.

- [ ] **Step 4: Run focused and full verification**

```bash
npm run lint
npx tsc --noEmit
npm test
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 5: Bump and verify release version**

```bash
node scripts/bump-version.mjs 0.1.30-beta.75
npm install --package-lock-only --ignore-scripts
node scripts/assert-version-sync.mjs 0.1.30-beta.75
```

Add release notes describing defaults only, not feature removal.
