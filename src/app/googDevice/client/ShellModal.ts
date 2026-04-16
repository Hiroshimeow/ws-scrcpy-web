import '@xterm/xterm/css/xterm.css';
import '../../../style/dialog.css';
import { AttachAddon } from '@xterm/addon-attach';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { ACTION } from '../../../common/Action';
import { ChannelCode } from '../../../common/ChannelCode';
import type { MessageXtermClient } from '../../../types/MessageXtermClient';
import { Multiplexer } from '../../../packages/multiplexer/Multiplexer';
import { ManagerClient } from '../../client/ManagerClient';

const TAG = '[ShellModal]';

export class ShellModal {
    private readonly background: HTMLDivElement;
    private term?: Terminal;
    private fitAddon?: FitAddon;
    private ws?: Multiplexer;
    private readonly resizeHandler: () => void;

    constructor(
        private readonly udid: string,
        private readonly deviceName: string,
        private readonly params: {
            hostname?: string;
            port?: number;
            secure?: boolean;
            pathname?: string;
        },
    ) {
        // Build the modal DOM
        this.background = document.createElement('div');
        this.background.className = 'dialog-background';

        const container = document.createElement('div');
        container.className = 'dialog-container shell-modal';

        // Header
        const header = document.createElement('div');
        header.className = 'dialog-header';

        const title = document.createElement('span');
        title.className = 'dialog-title';
        title.textContent = this.deviceName;

        const closeBtn = document.createElement('button');
        closeBtn.className = 'close-btn';
        closeBtn.textContent = '\u00d7';
        closeBtn.addEventListener('click', () => this.close());

        header.appendChild(title);
        header.appendChild(closeBtn);

        // Body
        const body = document.createElement('div');
        body.className = 'dialog-body';

        const terminalContainer = document.createElement('div');
        terminalContainer.className = 'terminal-container';
        body.appendChild(terminalContainer);

        container.appendChild(header);
        container.appendChild(body);
        this.background.appendChild(container);

        // Store resize handler reference so we can remove it later
        this.resizeHandler = () => {
            if (this.fitAddon) {
                this.fitAddon.fit();
            }
        };

        document.body.appendChild(this.background);

        // Start connection
        this.connect(terminalContainer);
    }

    private buildWebSocketUrl(): string {
        const { hostname, port, secure, pathname } = this.params;
        let urlString: string;
        if (typeof hostname === 'string' && typeof port === 'number') {
            const protocol = secure ? 'wss:' : 'ws:';
            urlString = `${protocol}//${hostname}:${port}${pathname ?? location.pathname}`;
        } else {
            const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            urlString = `${protocol}//${location.host}${pathname ?? location.pathname}`;
        }
        const url = new URL(urlString);
        url.searchParams.set('action', ACTION.MULTIPLEX);
        return url.toString();
    }

    private connect(terminalContainer: HTMLElement): void {
        const url = this.buildWebSocketUrl();

        // Get or create a multiplexer for this URL
        let multiplexer = ManagerClient.sockets.get(url);
        if (!multiplexer) {
            const ws = new WebSocket(url);
            ws.addEventListener('close', () => {
                ManagerClient.sockets.delete(url);
            });
            const newMultiplexer = Multiplexer.wrap(ws);
            newMultiplexer.on('empty', () => {
                newMultiplexer.close();
            });
            ManagerClient.sockets.set(url, newMultiplexer);
            multiplexer = newMultiplexer;
        }

        // Create a channel for the shell
        const channelData = new TextEncoder().encode(ChannelCode.SHEL);
        this.ws = multiplexer.createChannel(channelData);

        this.ws.addEventListener('open', () => {
            this.initTerminal(terminalContainer);
            this.startShell();
        });

        this.ws.addEventListener('close', (event: CloseEvent) => {
            console.log(TAG, `Connection closed: ${event.reason}`);
            if (this.term) {
                this.term.dispose();
                this.term = undefined;
            }
        });
    }

    private initTerminal(container: HTMLElement): void {
        if (!this.ws) {
            return;
        }
        this.term = new Terminal();
        this.term.loadAddon(new AttachAddon(this.ws));
        this.fitAddon = new FitAddon();
        this.term.loadAddon(this.fitAddon);
        this.term.open(container);
        this.fitAddon.fit();
        this.term.focus();

        window.addEventListener('resize', this.resizeHandler);
    }

    private startShell(): void {
        if (!this.ws || this.ws.readyState !== this.ws.OPEN || !this.fitAddon) {
            return;
        }
        const dims = this.fitAddon.proposeDimensions();
        const rows = dims?.rows ?? 24;
        const cols = dims?.cols ?? 80;
        const message: MessageXtermClient = {
            id: 1,
            type: 'shell',
            data: {
                type: 'start',
                rows,
                cols,
                udid: this.udid,
            },
        };
        this.ws.send(JSON.stringify(message));
    }

    public close(): void {
        // Send stop message
        if (this.ws && this.ws.readyState === this.ws.OPEN) {
            const message: MessageXtermClient = {
                id: 1,
                type: 'shell',
                data: {
                    type: 'stop',
                    udid: this.udid,
                },
            };
            this.ws.send(JSON.stringify(message));
            this.ws.close();
        }
        this.ws = undefined;

        // Dispose terminal
        if (this.term) {
            this.term.dispose();
            this.term = undefined;
        }
        this.fitAddon = undefined;

        // Remove resize listener
        window.removeEventListener('resize', this.resizeHandler);

        // Remove modal from DOM
        if (this.background.parentElement) {
            this.background.parentElement.removeChild(this.background);
        }
    }
}
