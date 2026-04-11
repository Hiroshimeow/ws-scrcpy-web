import Protocol from '../../../common/AdbProtocol';
import type { Multiplexer } from '../../../packages/multiplexer/Multiplexer';
import { BinaryReader } from '../../BinaryReader';
import { CommandControlMessage, FilePushState } from '../../controlMessage/CommandControlMessage';
import { join } from '../../pathUtils';
import type { FileListingClient } from '../client/FileListingClient';
import FilePushHandler from './FilePushHandler';
import { FilePushResponseStatus } from './FilePushResponseStatus';
import { FilePushStream } from './FilePushStream';

export class AdbkitFilePushStream extends FilePushStream {
    private channels: Map<number, Multiplexer> = new Map();
    constructor(
        private readonly socket: Multiplexer,
        private readonly fileListingClient: FileListingClient,
    ) {
        super();
    }
    public hasConnection(): boolean {
        return this.socket.readyState === this.socket.OPEN;
    }

    public isAllowedFile(): boolean {
        return true;
    }

    public getChannel(id: number): Multiplexer | undefined {
        const channel = this.channels.get(id);
        let code: FilePushResponseStatus = FilePushResponseStatus.NO_ERROR;
        if (!channel) {
            code = FilePushResponseStatus.ERROR_UNKNOWN_ID;
        }
        if (code) {
            this.emit('response', { id, code });
            return;
        }
        return channel;
    }

    public sendEventAppend({ id, chunk }: { id: number; chunk: Uint8Array }): void {
        const appendParams = { id, chunk, state: FilePushState.APPEND };
        const channel = this.getChannel(id);
        if (!channel) {
            return;
        }
        channel.send(CommandControlMessage.createPushFileCommand(appendParams).toUint8Array());
    }

    public sendEventFinish({ id }: { id: number }): void {
        const finishParams = { id, state: FilePushState.FINISH };
        const channel = this.getChannel(id);
        if (!channel) {
            return;
        }
        channel.send(CommandControlMessage.createPushFileCommand(finishParams).toUint8Array());
    }

    public sendEventNew({ id }: { id: number }): void {
        let pushId = id;
        const newParams = { id, state: FilePushState.NEW };
        const channel = this.socket.createChannel(new TextEncoder().encode(Protocol.SEND));
        const onMessage = (event: MessageEvent): void => {
            const reader = new BinaryReader(new Uint8Array(event.data as ArrayBuffer));
            const id = reader.readInt16BE();
            const code = reader.readInt8();
            if (code === FilePushResponseStatus.NEW_PUSH_ID) {
                this.channels.set(id, channel);
                pushId = id;
            }
            this.emit('response', { id, code });
        };
        const onClose = (event: CloseEvent): void => {
            if (!event.wasClean) {
                const code = 4000 - event.code;
                // this.emit('response', { id: pushId, code });
                this.emit('error', {
                    id: pushId,
                    error: new Error(FilePushHandler.getErrorMessage(code, event.reason)),
                });
            }
            channel.removeEventListener('message', onMessage);
            channel.removeEventListener('close', onClose);
        };
        channel.addEventListener('message', onMessage);
        channel.addEventListener('close', onClose);
        channel.send(CommandControlMessage.createPushFileCommand(newParams).toUint8Array());
    }

    public sendEventStart({ id, fileName, fileSize }: { id: number; fileName: string; fileSize: number }): void {
        const filePath = join(this.fileListingClient.getPath(), fileName);
        const startParams = { id, fileName: filePath, fileSize, state: FilePushState.START };
        const channel = this.getChannel(id);
        if (!channel) {
            return;
        }
        channel.send(CommandControlMessage.createPushFileCommand(startParams).toUint8Array());
    }

    public release(): void {
        this.channels.forEach((channel) => {
            channel.close();
        });
    }
}
