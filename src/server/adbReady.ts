/**
 * Cross-module hand-off for "the startup adb daemon pre-warm has completed."
 *
 * Set once by `index.ts` after the background `adbClient.startServer()` call
 * either succeeds (daemon up) or gives up (timed out waiting for binary).
 * Awaited by code paths that make the FIRST adb invocation early in startup
 * (notably `ControlCenter.init`'s initial device enumeration). Without this
 * coordination, ControlCenter's adb call races the background pre-warm:
 * both try to spawn the cold daemon, neither wins, and the next 5s of
 * `adb devices` calls fail with "failed to start daemon / connection reset".
 *
 * Single-set semantics — only the first `setAdbDaemonReady` wins so a misuse
 * (e.g. a test calling it twice) doesn't silently replace the live promise.
 *
 * Pre-set value is `Promise.resolve()` so callers in environments that don't
 * go through `index.ts` startup (vitest, isolated unit tests, an installed
 * launcher path that doesn't call this seam) get a non-hanging await.
 */
let readyPromise: Promise<void> = Promise.resolve();
let isSet = false;

export function setAdbDaemonReady(p: Promise<void>): void {
    if (isSet) return;
    readyPromise = p;
    isSet = true;
}

export function whenAdbReady(): Promise<void> {
    return readyPromise;
}

/** Test-only: reset the module state so a fresh test can set the promise. */
export function _resetAdbReadyForTest(): void {
    readyPromise = Promise.resolve();
    isSet = false;
}
