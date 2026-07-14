import { describe, expect, it } from 'vitest';
import { WebCodecsPlayer } from '../WebCodecsPlayer';

describe('stable stream defaults', () => {
    it('uses a conservative bitrate and frame rate for new sessions', () => {
        expect(WebCodecsPlayer.preferredVideoSettings.bitrate).toBe(4_000_000);
        expect(WebCodecsPlayer.preferredVideoSettings.maxFps).toBe(20);
    });
});
