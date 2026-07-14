import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { normalizeReverseSockets } from '../ScrcpyConnection';

describe('reverse tunnel socket layout', () => {
    it('inserts a synthetic disabled-audio socket when audio is off', () => {
        const video = new net.Socket();
        const control = new net.Socket();

        const sockets = normalizeReverseSockets([video, control], false);

        expect(sockets[0]).toBe(video);
        expect(sockets[2]).toBe(control);
        expect(sockets[1]).not.toBe(video);
        expect(sockets[1]).not.toBe(control);
        expect(sockets[1]!.read(4)).toEqual(Buffer.alloc(4));
    });

    it('keeps video, audio and control sockets unchanged when audio is on', () => {
        const video = new net.Socket();
        const audio = new net.Socket();
        const control = new net.Socket();

        expect(normalizeReverseSockets([video, audio, control], true)).toEqual([video, audio, control]);
    });
});
