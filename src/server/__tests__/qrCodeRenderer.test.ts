import { describe, expect, it } from 'vitest';
import { renderQrSvg } from '../QrCodeRenderer';

describe('renderQrSvg', () => {
    it('renders an ADB pairing payload as a standalone SVG QR code', async () => {
        const svg = await renderQrSvg('WIFI:T:ADB;S:studio-wssw-test;P:secret123;;');

        expect(svg).toMatch(/^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
        expect(svg).toContain('<path');
        expect(svg).toContain('viewBox=');
    });
});
