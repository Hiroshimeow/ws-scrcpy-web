import type { ParamsStreamScrcpy } from '../../../types/ParamsStreamScrcpy';
import type BasePlayer from '../../player/BasePlayer';
import type VideoSettings from '../../VideoSettings';
import { Modal } from '../../ui/Modal';
import { StreamClientScrcpy } from './StreamClientScrcpy';

export class ConnectModal extends Modal {
    private stopStream?: () => void;

    constructor(
        params: ParamsStreamScrcpy,
        player: BasePlayer,
        fitToScreen: boolean,
        videoSettings: VideoSettings,
        deviceLabel: string,
    ) {
        super({ title: deviceLabel });
        this.dialog.classList.add('connect-modal');

        const { stop } = StreamClientScrcpy.start(
            params, player, fitToScreen, videoSettings,
            this.bodyEl,
            () => this.close(),
        );
        this.stopStream = stop;
    }

    protected buildBody(_container: HTMLElement): void {
        // Empty — StreamClientScrcpy populates the container after super() completes
    }

    protected onEscapeKey(_event: Event): void {
        // Block — UHID keyboard capture needs Escape
    }

    protected onBackdropClick(_event: MouseEvent): void {
        // Block — protect stream from accidental close
    }

    protected onBeforeClose(): void {
        this.stopStream?.();
    }
}
