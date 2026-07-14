// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProbeResult } from '../../../../common/ProbeResult';

const storedVideo = new Map<string, { codec?: string; settings?: Record<string, unknown> }>();

vi.mock('../../../client/DeviceProbeClient', () => ({
    DeviceProbeClient: {
        probe: vi.fn().mockResolvedValue({
            width: 1440,
            height: 3120,
            density: 480,
            sdkInt: 36,
            videoEncoders: ['c2.exynos.avc.encoder', 'c2.exynos.hevc.encoder'],
            audioEncoders: [],
        }),
    },
}));

vi.mock('../../../client/SettingsService', () => ({
    settingsService: {
        hydrateDevice: vi.fn().mockResolvedValue(undefined),
        getDeviceVideo: (udid: string) => storedVideo.get(udid),
        getDeviceAudio: () => undefined,
    },
}));

import { ConfigureScrcpy } from '../ConfigureScrcpy';

function makeModal(udid = 'test-device'): any {
    const modal = Object.create(ConfigureScrcpy.prototype) as any;
    modal.udid = udid;
    modal.videoCodecSelect = document.createElement('select');
    modal.encoderSelectElement = document.createElement('select');
    modal.audioCodecSelect = undefined;
    modal.displayIdSelectElement = undefined;
    modal.connectButton = undefined;
    modal.statusElement = undefined;
    modal.allVideoEncoders = [];
    modal.TAG = 'ConfigureScrcpy[test]';
    modal.updateVideoSettingsForPlayer = () => {
        const encoder = storedVideo.get(udid)?.settings?.['encoderName'];
        if (typeof encoder === 'string') {
            modal.encoderSelectElement.value = encoder;
        }
    };
    return modal;
}

function probe(videoEncoders: string[]): ProbeResult {
    return {
        width: 1440,
        height: 3120,
        density: 480,
        sdkInt: 36,
        videoEncoders,
        audioEncoders: [],
    };
}

beforeEach(() => {
    storedVideo.clear();
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();
});

describe('ConfigureScrcpy codec selection', () => {
    it('defaults to H.264 instead of silently upgrading to H.265', async () => {
        const modal = makeModal();

        await modal.onProbeResult(probe(['c2.exynos.avc.encoder', 'c2.exynos.hevc.encoder']));

        expect(modal.videoCodecSelect.value).toBe('h264');
        expect(modal.encoderSelectElement.value).toBe('c2.exynos.avc.encoder');
    });

    it('prefers a hardware AVC encoder over a software AVC encoder', async () => {
        const modal = makeModal();

        await modal.onProbeResult(probe(['c2.android.avc.encoder', 'c2.exynos.avc.encoder']));

        expect(modal.videoCodecSelect.value).toBe('h264');
        expect(modal.encoderSelectElement.value).toBe('c2.exynos.avc.encoder');
    });

    it('restores a saved supported codec and matching encoder', async () => {
        storedVideo.set('saved-device', {
            codec: 'h265',
            settings: { encoderName: 'c2.exynos.hevc.encoder' },
        });
        const modal = makeModal('saved-device');

        await modal.onProbeResult(probe(['c2.exynos.avc.encoder', 'c2.exynos.hevc.encoder']));

        expect(modal.videoCodecSelect.value).toBe('h265');
        expect(modal.encoderSelectElement.value).toBe('c2.exynos.hevc.encoder');
    });

    it('passes the selected codec when saving video settings', async () => {
        const modal = new ConfigureScrcpy(
            {} as any,
            { udid: 'save-device', 'ro.build.version.sdk': '36', deviceKind: 'phone' } as any,
            'Save device',
            { action: 'stream' } as any,
        ) as any;
        await new Promise((resolve) => setTimeout(resolve, 0));

        modal.videoCodecSelect.value = 'h265';
        const videoSettings = { bitrate: 4_000_000 };
        modal.buildVideoSettings = () => videoSettings;
        modal.getFitToScreenValue = () => false;
        modal.displayInfo = undefined;
        modal.audioEnabledCheckbox = undefined;
        modal.audioSourceSelect = undefined;
        modal.audioCodecSelect = undefined;
        modal.saveSettingsButton = undefined;
        const saveVideoSettings = vi.fn();
        modal.getPlayer = () => ({ saveVideoSettings });

        modal.saveSettings();

        expect(saveVideoSettings).toHaveBeenCalledWith('save-device', videoSettings, false, undefined, 'h265');
        modal.close();
    });
});
