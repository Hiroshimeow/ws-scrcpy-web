// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Browser-level regression guard: scrcpy sends H.264 Annex-B. WebCodecs must
 * remain in Annex-B mode (no avcC `description`) and receive SPS/PPS prepended
 * to the keyframe rather than raw Annex-B bytes mislabelled as avcC.
 *
 * We stub the WebCodecs globals and the canvas 2d context so the player can be
 * instantiated and driven in jsdom without real WebCodecs support.
 */

type Chunk = { type: string; timestamp: number; data: Uint8Array };

let decodedChunks: Chunk[] = [];
let lastConfig: VideoDecoderConfig | undefined;
let decoderState: string;

class FakeVideoDecoder {
    public state = 'unconfigured';
    constructor(_init: unknown) {
        decoderState = 'unconfigured';
    }
    configure(cfg: VideoDecoderConfig) {
        lastConfig = cfg;
        this.state = 'configured';
        decoderState = 'configured';
    }
    decode(chunk: Chunk) {
        decodedChunks.push(chunk);
    }
    flush() {
        return Promise.resolve();
    }
    close() {
        this.state = 'closed';
    }
    static isConfigSupported() {
        return Promise.resolve({ supported: true });
    }
}

class FakeEncodedVideoChunk {
    public type: string;
    public timestamp: number;
    public data: Uint8Array;
    constructor(init: Chunk) {
        this.type = init.type;
        this.timestamp = init.timestamp;
        // Copy the bytes the player handed us so later buffer reuse can't rewrite history.
        this.data = new Uint8Array(init.data);
    }
}

// Minimal H.264 config frame (SPS NAL type 7 after the 00 00 00 01 start code).
const H264_CONFIG = new Uint8Array([
    0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1e, 0x8c, 0x8d, 0x40, 0xa0, 0x2f, 0xf9, 0x70, 0x11, 0x00, 0x00, 0x00, 1, 0x68, 0xce,
    0x3c, 0x80,
]);
// A keyframe payload that does not contain SPS/PPS; the player must prepend them.
const H264_KEYFRAME = new Uint8Array([0, 0, 0, 1, 0x65, 0xaa, 0xbb, 0xcc, 0xdd]);

describe('WebCodecsPlayer keyframe decode (finding #41)', () => {
    beforeEach(() => {
        decodedChunks = [];
        lastConfig = undefined;
        decoderState = 'unconfigured';
        vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
        vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
        // jsdom's canvas has no 2d context without the `canvas` pkg — stub it.
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
            drawImage: vi.fn(),
            clearRect: vi.fn(),
            fillRect: vi.fn(),
            measureText: () => ({ actualBoundingBoxLeft: 0, actualBoundingBoxRight: 0 }),
            fillText: vi.fn(),
            save: vi.fn(),
            restore: vi.fn(),
        } as unknown as CanvasRenderingContext2D);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('configures Annex-B mode and prepends SPS/PPS to the keyframe', async () => {
        const { WebCodecsPlayer } = await import('../WebCodecsPlayer');
        const player = new WebCodecsPlayer('udid-test');
        player.setMetadataSize(1280, 720);

        player.pushVideoFrame(H264_CONFIG, 0n, true, false);
        expect(decoderState).toBe('configured');
        expect(lastConfig).toBeDefined();
        expect(lastConfig?.description).toBeUndefined();

        player.pushVideoFrame(H264_KEYFRAME, 100n, false, true);
        expect(decodedChunks.length).toBe(1);
        const chunk = decodedChunks[0]!;
        expect(chunk.type).toBe('key');
        const expected = new Uint8Array(H264_CONFIG.length + H264_KEYFRAME.length);
        expected.set(H264_CONFIG);
        expected.set(H264_KEYFRAME, H264_CONFIG.length);
        expect(Array.from(chunk.data)).toEqual(Array.from(expected));
    });
});
