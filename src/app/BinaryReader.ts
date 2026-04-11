// src/app/BinaryReader.ts

export class BinaryReader {
    private view: DataView;
    private pos: number;

    constructor(data: Uint8Array, offset = 0) {
        this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        this.pos = offset;
    }

    readUInt8(): number {
        const v = this.view.getUint8(this.pos);
        this.pos += 1;
        return v;
    }

    readInt8(): number {
        const v = this.view.getInt8(this.pos);
        this.pos += 1;
        return v;
    }

    readUInt16BE(): number {
        const v = this.view.getUint16(this.pos);
        this.pos += 2;
        return v;
    }

    readInt16BE(): number {
        const v = this.view.getInt16(this.pos);
        this.pos += 2;
        return v;
    }

    readUInt32BE(): number {
        const v = this.view.getUint32(this.pos);
        this.pos += 4;
        return v;
    }

    readInt32BE(): number {
        const v = this.view.getInt32(this.pos);
        this.pos += 4;
        return v;
    }

    readUInt32LE(): number {
        const v = this.view.getUint32(this.pos, true);
        this.pos += 4;
        return v;
    }

    readBigUInt64BE(): bigint {
        const v = this.view.getBigUint64(this.pos);
        this.pos += 8;
        return v;
    }

    readBytes(length: number): Uint8Array {
        const data = new Uint8Array(this.view.buffer, this.view.byteOffset + this.pos, length);
        this.pos += length;
        return data;
    }

    readString(length: number): string {
        const bytes = this.readBytes(length);
        return new TextDecoder().decode(bytes);
    }

    get offset(): number {
        return this.pos;
    }

    get remaining(): number {
        return this.view.byteLength - this.pos;
    }
}
