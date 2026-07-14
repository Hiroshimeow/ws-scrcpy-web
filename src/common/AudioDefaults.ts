import type { DeviceKind } from '../server/goog-device/deviceKind';

export type AudioSource = 'playback' | 'output' | 'mic';

/**
 * Audio streaming starts disabled for the compatibility-first default.
 * Users may still enable and persist audio per device from the existing UI.
 */
export function audioEnabledDefault(_kind: DeviceKind | undefined): boolean {
    return false;
}

/**
 * Default audio-capture source. Matches scrcpy's own default (`output`) —
 * captures the whole audio output, which silences device playback during the
 * session. `playback` + `--audio-dup` is an opt-in in `ConfigureScrcpy` for
 * users who want device audio to keep playing while they mirror (Android 13+).
 */
export const DEFAULT_AUDIO_SOURCE: AudioSource = 'output';

/** scrcpy can capture audio starting at Android 11 / SDK 30. Older devices can't. */
export function audioCaptureSupported(sdkInt: number): boolean {
    return Number.isFinite(sdkInt) && sdkInt >= 30;
}

/** `--audio-dup` (keeps device audio playing during capture) requires Android 13+. */
export function audioDupSupported(sdkInt: number): boolean {
    return Number.isFinite(sdkInt) && sdkInt >= 33;
}

/**
 * Default audio source for a given SDK. Always `output` today — that's
 * scrcpy's own default and it works on every audio-capable SDK (30+).
 * Accepts `sdkInt` for forward-compat in case we ever want to re-tier
 * (e.g. a future SDK that only supports a particular source).
 */
export function defaultAudioSourceForSdk(_sdkInt: number): AudioSource {
    return DEFAULT_AUDIO_SOURCE;
}
