// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import type { ProbeResult } from '../../../../common/ProbeResult';
import { ConfigureScrcpy } from '../ConfigureScrcpy';

describe('ConfigureScrcpy codec selection', () => {
    it('defaults to H.264 instead of silently upgrading to H.265', async () => {
        const modal = Object.create(ConfigureScrcpy.prototype) as any;
        modal.videoCodecSelect = document.createElement('select');
        modal.encoderSelectElement = document.createElement('select');
        modal.audioCodecSelect = undefined;
        modal.displayIdSelectElement = undefined;
        modal.connectButton = undefined;
        modal.statusElement = undefined;
        modal.allVideoEncoders = [];
        modal.TAG = 'ConfigureScrcpy[test]';
        modal.updateVideoSettingsForPlayer = () => {};

        const result: ProbeResult = {
            width: 1440,
            height: 3120,
            density: 480,
            sdkInt: 36,
            videoEncoders: ['c2.exynos.avc.encoder', 'c2.exynos.hevc.encoder'],
            audioEncoders: [],
        };

        await modal.onProbeResult(result);

        expect(modal.videoCodecSelect.value).toBe('h264');
        expect(modal.encoderSelectElement.value).toBe('c2.exynos.avc.encoder');
    });
});
