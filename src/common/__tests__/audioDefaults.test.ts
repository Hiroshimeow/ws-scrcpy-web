import { describe, expect, it } from 'vitest';
import {
    audioCaptureSupported,
    audioDupSupported,
    audioEnabledDefault,
    defaultAudioSourceForSdk,
} from '../AudioDefaults';

describe('audioEnabledDefault', () => {
    // Stable mode starts without audio. Users may enable and save it explicitly.
    it('returns false for TV devices', () => {
        expect(audioEnabledDefault('tv')).toBe(false);
    });

    it('returns false for phones', () => {
        expect(audioEnabledDefault('phone')).toBe(false);
    });

    it('returns false for tablets', () => {
        expect(audioEnabledDefault('tablet')).toBe(false);
    });

    it('returns false when device kind is unknown', () => {
        expect(audioEnabledDefault(undefined)).toBe(false);
    });
});

describe('audioCaptureSupported — SDK 30+', () => {
    it('rejects SDK 29 and below (scrcpy cannot capture audio there)', () => {
        expect(audioCaptureSupported(25)).toBe(false);
        expect(audioCaptureSupported(29)).toBe(false);
    });

    it('accepts SDK 30+', () => {
        expect(audioCaptureSupported(30)).toBe(true);
        expect(audioCaptureSupported(34)).toBe(true);
    });

    it('rejects unparseable SDK (NaN / 0)', () => {
        expect(audioCaptureSupported(Number.NaN)).toBe(false);
        expect(audioCaptureSupported(0)).toBe(false);
    });
});

describe('audioDupSupported — SDK 33+', () => {
    it('rejects SDK below 33 (--audio-dup requires Android 13)', () => {
        expect(audioDupSupported(32)).toBe(false);
        expect(audioDupSupported(30)).toBe(false);
    });

    it('accepts SDK 33+', () => {
        expect(audioDupSupported(33)).toBe(true);
        expect(audioDupSupported(36)).toBe(true);
    });
});

describe('defaultAudioSourceForSdk', () => {
    // Matches scrcpy's own default — `output` across every SDK. Users who want
    // device audio to keep playing can opt into `playback` (Android 13+) via
    // the ConfigureScrcpy dropdown.
    it('returns output on SDK 33+', () => {
        expect(defaultAudioSourceForSdk(33)).toBe('output');
        expect(defaultAudioSourceForSdk(36)).toBe('output');
    });

    it('returns output on SDK 30-32', () => {
        expect(defaultAudioSourceForSdk(30)).toBe('output');
        expect(defaultAudioSourceForSdk(32)).toBe('output');
    });

    it('returns output when sdk is unknown', () => {
        expect(defaultAudioSourceForSdk(Number.NaN)).toBe('output');
    });
});
