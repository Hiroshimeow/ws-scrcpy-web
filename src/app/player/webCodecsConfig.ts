/**
 * Build a WebCodecs decoder config for scrcpy's elementary stream.
 *
 * scrcpy sends H.264/H.265 in Annex-B format. For WebCodecs, omitting
 * `description` selects Annex-B byte-stream mode; supplying a description would
 * select avcC/hvcC length-prefixed mode and therefore requires converting every
 * sample as well. Keep the stream in its native Annex-B representation.
 */
export interface BuildDecoderConfigParams {
    /** WebCodecs codec string, e.g. `avc1.42E01E` / `hev1.1.6.L93.B0` / `av01.0.04M.08`. */
    codec: string;
    detectedCodec: 'h264' | 'h265' | 'av1' | null;
    codedWidth: number;
    codedHeight: number;
    /** Raw codec config retained by the caller for Annex-B keyframe prepending. */
    configData: Uint8Array;
}

export function buildDecoderConfig(params: BuildDecoderConfigParams): VideoDecoderConfig {
    return {
        codec: params.codec,
        codedWidth: params.codedWidth,
        codedHeight: params.codedHeight,
        optimizeForLatency: true,
    };
}
