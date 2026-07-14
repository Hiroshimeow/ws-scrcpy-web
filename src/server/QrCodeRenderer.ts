import qrcode from 'qrcode-generator';

export async function renderQrSvg(payload: string): Promise<string> {
    const qr = qrcode(0, 'M');
    qr.addData(payload, 'Byte');
    qr.make();
    return qr.createSvgTag({ cellSize: 8, margin: 16, scalable: true });
}
