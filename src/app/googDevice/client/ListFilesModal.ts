import '../../../style/listfiles.css';
import Protocol from '../../../common/AdbProtocol';
import { ACTION } from '../../../common/Action';
import { ChannelCode } from '../../../common/ChannelCode';
import { Multiplexer } from '../../../packages/multiplexer/Multiplexer';
import { BinaryWriter } from '../../BinaryWriter';
import { Modal } from '../../ui/Modal';
import Util from '../../Util';
import { Entry } from '../Entry';
import { createFileIconForEntry } from './FileIconUtils';
import { AdbkitFilePushStream } from '../filePush/AdbkitFilePushStream';
import FilePushHandler, { type DragAndPushListener, type PushUpdateParams } from '../filePush/FilePushHandler';
import { ManagerClient } from '../../client/ManagerClient';
import { basename, resolve } from '../../pathUtils';

const TAG = '[ListFilesModal]';
const ICON_SIZE_KEY = 'file-browser-icon-size';
const DEFAULT_ICON_SIZE = 24;
const ICON_SIZES = [16, 20, 24, 28, 32];
const REMOVE_ROW_TIMEOUT = 2000;

type SortField = 'name' | 'size' | 'date';
type SortDir = 'asc' | 'desc';

type Download = {
    receivedBytes: number;
    entry?: Entry;
    progressEl?: HTMLElement;
    chunks: Uint8Array[];
    path: string;
    pathToLoadAfter: string;
};

type Upload = {
    row: HTMLElement;
    progressEl: HTMLElement;
    timeout: number | null;
};

function formatSize(bytes: number): string {
    if (bytes === 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${(bytes / 1073741824).toFixed(1)} GB`;
}

function formatDate(date: Date): string {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    return `${months[date.getMonth()]} ${date.getDate()}`;
}

export class ListFilesModal extends Modal implements DragAndPushListener {
    private readonly udid: string;
    private readonly params: {
        hostname?: string;
        port?: number;
        secure?: boolean;
        pathname?: string;
    };

    private iconSize = DEFAULT_ICON_SIZE;
    private currentPath = '/data/local/tmp';
    private entries: Entry[] = [];
    private filteredEntries: Entry[] = [];
    private selectedPaths: Set<string> = new Set();
    private sortField: SortField = 'name';
    private sortDir: SortDir = 'asc';
    private filterText = '';

    // WebSocket state
    private multiplexer?: Multiplexer;
    private wsUrl = '';
    private channels: Set<Multiplexer> = new Set();
    private downloads: Map<Multiplexer, Download> = new Map();
    private uploads: Map<string, Upload> = new Map();
    private activeDownloads = 0;
    private activeUploads = 0;

    // Upload infrastructure
    private filePushHandler?: FilePushHandler;
    private enterCount = 0;

    // DOM references
    private breadcrumbBar?: HTMLElement;
    private filterInput?: HTMLInputElement;
    private headerCheck?: HTMLInputElement;
    private fileListBody?: HTMLElement;
    private footerUploadBtn?: HTMLButtonElement;
    private footerDeleteBtn?: HTMLButtonElement;
    private footerDownloadBtn?: HTMLButtonElement;
    private footerInfo?: HTMLElement;
    private dropZone?: HTMLElement;
    private uploadInput?: HTMLInputElement;

    constructor(
        udid: string,
        deviceLabel: string,
        params: {
            hostname?: string;
            port?: number;
            secure?: boolean;
            pathname?: string;
        },
    ) {
        super({ title: deviceLabel });
        this.dialog.classList.add('list-files-modal');

        this.udid = udid;
        this.params = params;

        // Add size picker button to header (left of X)
        const header = this.dialog.querySelector('.modal-header');
        const closeBtn = header?.querySelector('.modal-close');
        if (header && closeBtn) {
            const sizeBtn = document.createElement('button');
            sizeBtn.className = 'modal-close';
            sizeBtn.textContent = '\u229e'; // ⊞
            sizeBtn.title = 'icon size preference';
            sizeBtn.addEventListener('click', () => this.showSizePicker());
            header.insertBefore(sizeBtn, closeBtn);
        }

        // Check localStorage for saved size preference
        const savedSize = localStorage.getItem(ICON_SIZE_KEY);
        if (savedSize) {
            this.iconSize = parseInt(savedSize, 10);
            this.dialog.style.setProperty('--file-icon-size', `${this.iconSize}px`);
            this.initFileBrowser();
        } else {
            this.showSizePicker();
        }
    }

    // ── Modal overrides ──

    protected buildBody(_container: HTMLElement): void {
        // Empty — content is built after super() completes
    }

    protected buildFooter(): HTMLElement | null {
        const footer = document.createElement('div');
        footer.className = 'list-files-footer';

        // Left: action buttons
        const actions = document.createElement('div');
        actions.className = 'list-files-footer-actions';

        this.footerUploadBtn = document.createElement('button');
        this.footerUploadBtn.className = 'list-files-footer-btn';
        this.footerUploadBtn.textContent = 'upload';
        this.footerUploadBtn.addEventListener('click', () => this.triggerUpload());
        actions.appendChild(this.footerUploadBtn);

        this.footerDeleteBtn = document.createElement('button');
        this.footerDeleteBtn.className = 'list-files-footer-btn delete';
        this.footerDeleteBtn.textContent = 'delete';
        this.footerDeleteBtn.disabled = true;
        this.footerDeleteBtn.addEventListener('click', () => this.deleteSelected());
        actions.appendChild(this.footerDeleteBtn);

        this.footerDownloadBtn = document.createElement('button');
        this.footerDownloadBtn.className = 'list-files-footer-btn';
        this.footerDownloadBtn.textContent = 'download';
        this.footerDownloadBtn.disabled = true;
        this.footerDownloadBtn.addEventListener('click', () => this.downloadSelected());
        actions.appendChild(this.footerDownloadBtn);

        footer.appendChild(actions);

        // Right: info
        this.footerInfo = document.createElement('span');
        this.footerInfo.className = 'list-files-footer-info';
        footer.appendChild(this.footerInfo);

        // Hidden file input for upload button
        this.uploadInput = document.createElement('input');
        this.uploadInput.type = 'file';
        this.uploadInput.multiple = true;
        this.uploadInput.style.display = 'none';
        this.uploadInput.addEventListener('change', () => this.handleUploadInput());
        footer.appendChild(this.uploadInput);

        return footer;
    }

    protected onEscapeKey(_event: Event): void {
        if (this.confirmClose()) this.close();
    }

    protected onBackdropClick(_event: MouseEvent): void {
        if (this.confirmClose()) this.close();
    }

    protected onCloseButtonClick(): void {
        if (this.confirmClose()) this.close();
    }

    protected onBeforeClose(): void {
        // Clean up upload handler
        if (this.filePushHandler) {
            this.filePushHandler.release();
            this.filePushHandler = undefined;
        }

        // Close all open channels
        this.channels.forEach((ch) => {
            if (ch.readyState === ch.OPEN || ch.readyState === ch.CONNECTING) {
                ch.close();
            }
        });
        this.channels.clear();
        this.downloads.clear();
        this.uploads.clear();
    }

    // ── Transfer confirmation ──

    private hasActiveTransfers(): boolean {
        return this.activeDownloads > 0 || this.activeUploads > 0;
    }

    private confirmClose(): boolean {
        if (this.hasActiveTransfers()) {
            return confirm('transfers in progress \u2014 close anyway?');
        }
        return true;
    }

    // ── Size picker ──

    private showSizePicker(): void {
        this.bodyEl.innerHTML = '';

        const picker = document.createElement('div');
        picker.className = 'list-files-size-picker';

        const heading = document.createElement('h3');
        heading.textContent = 'icon size';
        picker.appendChild(heading);

        const options = document.createElement('div');
        options.className = 'list-files-size-options';

        let selectedSize = this.iconSize;

        ICON_SIZES.forEach((size) => {
            const opt = document.createElement('div');
            opt.className = 'list-files-size-option';
            if (size === selectedSize) opt.classList.add('selected');

            const preview = document.createElement('div');
            preview.innerHTML =
                '<svg viewBox="0 0 24 24" style="fill:currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6z"/></svg>';
            const svg = preview.querySelector('svg') as SVGElement;
            svg.style.width = `${size}px`;
            svg.style.height = `${size}px`;
            opt.appendChild(preview);

            const label = document.createElement('div');
            label.className = 'size-label';
            label.textContent = `${size}px`;
            opt.appendChild(label);

            opt.addEventListener('click', () => {
                options.querySelectorAll('.list-files-size-option').forEach((el) => el.classList.remove('selected'));
                opt.classList.add('selected');
                selectedSize = size;
            });

            options.appendChild(opt);
        });

        picker.appendChild(options);

        // Controls row
        const controls = document.createElement('div');
        controls.className = 'list-files-size-picker-controls';

        const saveLabel = document.createElement('label');
        const saveCheck = document.createElement('input');
        saveCheck.type = 'checkbox';
        saveCheck.checked = true;
        saveLabel.appendChild(saveCheck);
        saveLabel.appendChild(document.createTextNode(' save preference'));
        controls.appendChild(saveLabel);

        const okBtn = document.createElement('button');
        okBtn.className = 'list-files-footer-btn';
        okBtn.textContent = 'ok';
        okBtn.addEventListener('click', () => {
            this.iconSize = selectedSize;
            this.dialog.style.setProperty('--file-icon-size', `${this.iconSize}px`);
            if (saveCheck.checked) {
                localStorage.setItem(ICON_SIZE_KEY, String(this.iconSize));
            }
            this.initFileBrowser();
        });
        controls.appendChild(okBtn);

        picker.appendChild(controls);

        const note = document.createElement('div');
        note.className = 'list-files-size-picker-note';
        note.textContent = 'clear browser storage to reset';
        picker.appendChild(note);

        this.bodyEl.appendChild(picker);
    }

    // ── File browser initialization ──

    private initFileBrowser(): void {
        this.bodyEl.innerHTML = '';

        // Breadcrumb bar
        this.breadcrumbBar = document.createElement('div');
        this.breadcrumbBar.className = 'list-files-breadcrumbs';
        this.bodyEl.appendChild(this.breadcrumbBar);

        // Column headers
        const headerRow = document.createElement('div');
        headerRow.className = 'list-files-header';

        this.headerCheck = document.createElement('input');
        this.headerCheck.type = 'checkbox';
        this.headerCheck.className = 'list-files-header-check';
        this.headerCheck.addEventListener('change', () => this.toggleSelectAll());
        headerRow.appendChild(this.headerCheck);

        // Spacer for icon column
        const iconSpacer = document.createElement('span');
        iconSpacer.style.width = 'var(--file-icon-size, 24px)';
        iconSpacer.style.flexShrink = '0';
        headerRow.appendChild(iconSpacer);

        const nameHeader = document.createElement('span');
        nameHeader.className = 'list-files-header-name';
        nameHeader.textContent = 'name';
        nameHeader.addEventListener('click', () => this.toggleSort('name'));
        headerRow.appendChild(nameHeader);

        const sizeHeader = document.createElement('span');
        sizeHeader.className = 'list-files-header-size';
        sizeHeader.textContent = 'size';
        sizeHeader.addEventListener('click', () => this.toggleSort('size'));
        headerRow.appendChild(sizeHeader);

        const dateHeader = document.createElement('span');
        dateHeader.className = 'list-files-header-date';
        dateHeader.textContent = 'date';
        dateHeader.addEventListener('click', () => this.toggleSort('date'));
        headerRow.appendChild(dateHeader);

        // Spacer for actions column
        const actionsSpacer = document.createElement('span');
        actionsSpacer.style.width = '56px';
        actionsSpacer.style.flexShrink = '0';
        headerRow.appendChild(actionsSpacer);

        this.bodyEl.appendChild(headerRow);

        // Scrollable file list
        this.fileListBody = document.createElement('div');
        this.fileListBody.className = 'list-files-body';
        this.bodyEl.appendChild(this.fileListBody);

        // Drop zone overlay (hidden by default)
        this.dropZone = document.createElement('div');
        this.dropZone.className = 'list-files-dropzone';
        this.dropZone.textContent = 'drop files here';
        this.dropZone.style.display = 'none';
        this.bodyEl.appendChild(this.dropZone);

        // Set up drag-and-drop on the body element
        this.bodyEl.style.position = 'relative';

        // Connect WebSocket and load initial directory
        this.connectAndLoad();
    }

    // ── WebSocket connection ──

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

    private connectAndLoad(): void {
        this.wsUrl = this.buildWebSocketUrl();

        // Get or create a multiplexer
        let mux = ManagerClient.sockets.get(this.wsUrl);
        if (!mux) {
            const ws = new WebSocket(this.wsUrl);
            ws.addEventListener('close', () => {
                ManagerClient.sockets.delete(this.wsUrl);
            });
            const newMux = Multiplexer.wrap(ws);
            newMux.on('empty', () => {
                newMux.close();
            });
            ManagerClient.sockets.set(this.wsUrl, newMux);
            mux = newMux;
        }
        this.multiplexer = mux;

        // Set up upload handler (needs the multiplexer for AdbkitFilePushStream)
        // AdbkitFilePushStream expects a FileListingClient-like object with getPath()
        // We pass `this` which implements the required interface
        const pushStream = new AdbkitFilePushStream(this.multiplexer, this as any);
        this.filePushHandler = new FilePushHandler(this.bodyEl, pushStream);
        this.filePushHandler.addEventListener(this);

        // Show loading, then load directory
        this.showLoading();

        // If multiplexer is already open, load immediately
        if (this.multiplexer.readyState === this.multiplexer.OPEN) {
            this.loadDirectory(this.currentPath);
        } else {
            // Wait for the underlying WebSocket to open
            const onOpen = (): void => {
                this.multiplexer?.removeEventListener('open', onOpen);
                this.loadDirectory(this.currentPath);
            };
            this.multiplexer.addEventListener('open', onOpen);
        }
    }

    // Required by AdbkitFilePushStream (duck-typed as FileListingClient)
    public getPath(): string {
        return this.currentPath;
    }

    // ── Directory listing protocol ──

    private getChannelInitData(): Uint8Array {
        const serial = Util.stringToUtf8ByteArray(this.udid);
        return new BinaryWriter(4 + 4 + serial.byteLength)
            .writeString(ChannelCode.FSLS)
            .writeUInt32LE(serial.length)
            .writeBytes(serial)
            .toUint8Array();
    }

    private loadDirectory(path: string): void {
        if (!this.multiplexer || this.multiplexer.readyState !== this.multiplexer.OPEN) {
            return;
        }
        this.showLoading();
        this.entries = [];
        this.selectedPaths.clear();
        this.filterText = '';
        if (this.filterInput) this.filterInput.value = '';

        // Use STAT first to determine if it's a dir
        this.sendCommand(Protocol.STAT, path, undefined, '');
    }

    private downloadFile(path: string, entry: Entry): void {
        if (!this.multiplexer || this.multiplexer.readyState !== this.multiplexer.OPEN) {
            return;
        }
        this.activeDownloads++;
        this.sendCommand(Protocol.RECV, path, entry, '');
    }

    private sendCommand(cmd: string, path: string, entry?: Entry, pathToLoadAfter = ''): void {
        if (!this.multiplexer) return;

        // Create channel with FSLS init data
        const initData = this.getChannelInitData();
        const channel = this.multiplexer.createChannel(initData);
        this.channels.add(channel);

        // Build command payload
        const pathBytes = new TextEncoder().encode(path);
        const cmdBytes = new TextEncoder().encode(cmd);
        const payload = new BinaryWriter(cmdBytes.length + 4 + pathBytes.length)
            .writeBytes(cmdBytes)
            .writeUInt32LE(pathBytes.length)
            .writeBytes(pathBytes)
            .toUint8Array();

        const download: Download = {
            receivedBytes: 0,
            path,
            entry,
            chunks: [],
            pathToLoadAfter,
        };
        this.downloads.set(channel, download);

        const onMessage = (event: MessageEvent): void => {
            this.handleReply(channel, event);
        };
        const onClose = (): void => {
            this.channels.delete(channel);
            this.downloads.delete(channel);
            channel.removeEventListener('message', onMessage);
            channel.removeEventListener('close', onClose);
        };
        channel.addEventListener('message', onMessage);
        channel.addEventListener('close', onClose);

        // Send the command on the channel
        channel.send(payload);
    }

    private requireClean = false;
    private requestedPath = '';
    private pendingEntries: Entry[] = [];

    private handleReply(channel: Multiplexer, e: MessageEvent): void {
        const data = new Uint8Array(e.data);
        const reply = new TextDecoder('ascii').decode(data.subarray(0, 4));

        switch (reply) {
            case Protocol.DENT: {
                const stat = data.subarray(4);
                const statView = new DataView(stat.buffer, stat.byteOffset);
                const mode = statView.getUint32(0, true);
                const size = statView.getUint32(4, true);
                const mtime = statView.getUint32(8, true);
                const namelen = statView.getUint32(12, true);
                const name = Util.utf8ByteArrayToString(stat.subarray(16, 16 + namelen));
                const entry = new Entry(name, mode, size, mtime);
                // Skip '.' and '..'
                if (name !== '.' && name !== '..') {
                    this.pendingEntries.push(entry);
                }
                return;
            }
            case Protocol.DONE: {
                const download = this.downloads.get(channel);
                if (download && download.entry && download.entry.isFile()) {
                    // File download complete
                    this.finishFileDownload(channel);
                } else {
                    // Directory listing complete
                    this.entries = this.pendingEntries.slice();
                    this.pendingEntries = [];
                    this.currentPath = download?.path ?? this.currentPath;
                    this.applyFilterAndSort();
                    this.renderBreadcrumbs();
                    this.renderFileList();
                    this.updateFooterInfo();
                }
                return;
            }
            case Protocol.STAT: {
                const download = this.downloads.get(channel);
                if (!download) return;

                const stat = data.subarray(4);
                const statView = new DataView(stat.buffer, stat.byteOffset);
                const mode = statView.getUint32(0, true);
                const size = statView.getUint32(4, true);
                const mtime = statView.getUint32(8, true);
                const nameString = basename(download.path);

                if (mode === 0) {
                    console.error(TAG, `no entity "${download.path}"`);
                    // Fall back to /data/local/tmp
                    this.channels.delete(channel);
                    this.downloads.delete(channel);
                    this.loadDirectory('/data/local/tmp');
                    return;
                }

                const entry = new Entry(nameString, mode, size, mtime);
                if (entry.isDirectory()) {
                    // It's a directory — send LIST
                    this.channels.delete(channel);
                    this.downloads.delete(channel);
                    this.sendCommand(Protocol.LIST, download.path, entry, '');
                } else if (entry.isFile()) {
                    // It's a file — download it
                    this.channels.delete(channel);
                    this.downloads.delete(channel);
                    this.downloadFile(download.path, entry);
                }
                break;
            }
            case Protocol.FAIL: {
                const dataView = new DataView(data.buffer, data.byteOffset);
                const length = dataView.getUint32(4, true);
                const message = Util.utf8ByteArrayToString(data.subarray(8, 8 + length));
                console.error(TAG, `FAIL: ${message}`);
                return;
            }
            case Protocol.DATA: {
                const download = this.downloads.get(channel);
                if (!download) return;

                download.chunks.push(data.subarray(4));
                download.receivedBytes += data.length - 4;

                // Update progress bar in the file row
                if (download.entry) {
                    const rowEl = this.fileListBody?.querySelector(
                        `[data-path="${CSS.escape(download.path)}"]`,
                    ) as HTMLElement;
                    if (rowEl) {
                        let progressEl = rowEl.querySelector('.list-files-progress') as HTMLElement;
                        if (!progressEl) {
                            progressEl = document.createElement('div');
                            progressEl.className = 'list-files-progress';
                            rowEl.appendChild(progressEl);
                        }
                        const percent = (download.receivedBytes * 100) / download.entry.size;
                        progressEl.style.width = `${percent}%`;
                    }
                }
                return;
            }
            default:
                console.error(TAG, `unexpected reply "${reply}"`);
        }
    }

    private finishFileDownload(channel: Multiplexer): void {
        const download = this.downloads.get(channel);
        if (!download) return;
        this.downloads.delete(channel);
        this.activeDownloads--;

        // Clean progress bar
        if (download.entry) {
            const rowEl = this.fileListBody?.querySelector(
                `[data-path="${CSS.escape(download.path)}"]`,
            ) as HTMLElement;
            if (rowEl) {
                const progressEl = rowEl.querySelector('.list-files-progress') as HTMLElement;
                if (progressEl) {
                    progressEl.classList.add('finished');
                    setTimeout(() => progressEl.remove(), 300);
                }
            }
        }

        const name = download.entry?.name ?? basename(download.path);
        const file = new File(download.chunks, name, { type: 'application/octet-stream' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(file);
        a.download = name;
        a.click();
        URL.revokeObjectURL(a.href);

        this.updateFooterState();
    }

    // ── Sorting and filtering ──

    private applyFilterAndSort(): void {
        let filtered = this.entries;

        // Apply filter
        if (this.filterText) {
            const lower = this.filterText.toLowerCase();
            filtered = filtered.filter((e) => e.name.toLowerCase().includes(lower));
        }

        // Sort: directories always first
        filtered.sort((a, b) => {
            const aIsDir = a.isDirectory() ? 0 : 1;
            const bIsDir = b.isDirectory() ? 0 : 1;
            if (aIsDir !== bIsDir) return aIsDir - bIsDir;

            const dir = this.sortDir === 'asc' ? 1 : -1;
            switch (this.sortField) {
                case 'name':
                    return a.name.localeCompare(b.name) * dir;
                case 'size':
                    return (a.size - b.size) * dir;
                case 'date':
                    return (a.mtime.getTime() - b.mtime.getTime()) * dir;
                default:
                    return 0;
            }
        });

        this.filteredEntries = filtered;
    }

    private toggleSort(field: SortField): void {
        if (this.sortField === field) {
            this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
            this.sortField = field;
            this.sortDir = 'asc';
        }
        this.applyFilterAndSort();
        this.renderFileList();
        this.updateSortArrows();
    }

    private updateSortArrows(): void {
        const headerRow = this.bodyEl.querySelector('.list-files-header');
        if (!headerRow) return;
        headerRow.querySelectorAll('.list-files-sort-arrow').forEach((el) => el.remove());

        const selector =
            this.sortField === 'name'
                ? '.list-files-header-name'
                : this.sortField === 'size'
                  ? '.list-files-header-size'
                  : '.list-files-header-date';
        const headerEl = headerRow.querySelector(selector);
        if (headerEl) {
            const arrow = document.createElement('span');
            arrow.className = 'list-files-sort-arrow';
            arrow.textContent = this.sortDir === 'asc' ? ' \u25b2' : ' \u25bc';
            headerEl.appendChild(arrow);
        }
    }

    // ── Breadcrumbs ──

    private renderBreadcrumbs(): void {
        if (!this.breadcrumbBar) return;
        this.breadcrumbBar.innerHTML = '';

        const parts = this.currentPath.split('/').filter(Boolean);

        // Root segment
        const rootSeg = document.createElement('span');
        rootSeg.className = 'list-files-breadcrumb-segment';
        rootSeg.textContent = '/';
        rootSeg.addEventListener('click', () => this.loadDirectory('/'));
        this.breadcrumbBar.appendChild(rootSeg);

        parts.forEach((part, i) => {
            const sep = document.createElement('span');
            sep.className = 'list-files-breadcrumb-separator';
            sep.textContent = '/';
            this.breadcrumbBar!.appendChild(sep);

            const isLast = i === parts.length - 1;
            const seg = document.createElement('span');
            if (isLast) {
                seg.className = 'list-files-breadcrumb-current';
                seg.textContent = part;
            } else {
                seg.className = 'list-files-breadcrumb-segment';
                seg.textContent = part;
                const targetPath = '/' + parts.slice(0, i + 1).join('/');
                seg.addEventListener('click', () => this.loadDirectory(targetPath));
            }
            this.breadcrumbBar!.appendChild(seg);
        });

        // Filter input (right side)
        const filterWrap = document.createElement('span');
        filterWrap.className = 'list-files-filter';
        this.filterInput = document.createElement('input');
        this.filterInput.type = 'text';
        this.filterInput.placeholder = 'filter...';
        this.filterInput.value = this.filterText;
        this.filterInput.addEventListener('input', () => {
            this.filterText = this.filterInput?.value ?? '';
            this.applyFilterAndSort();
            this.renderFileList();
            this.updateFooterInfo();
        });
        filterWrap.appendChild(this.filterInput);
        this.breadcrumbBar.appendChild(filterWrap);
    }

    // ── File list rendering ──

    private renderFileList(): void {
        if (!this.fileListBody) return;
        this.fileListBody.innerHTML = '';

        if (this.filteredEntries.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'list-files-loading';
            empty.textContent = this.filterText ? 'no matching files' : 'empty directory';
            this.fileListBody.appendChild(empty);
            return;
        }

        this.filteredEntries.forEach((entry) => {
            const row = this.createFileRow(entry);
            this.fileListBody!.appendChild(row);
        });

        this.updateHeaderCheck();
        this.updateSortArrows();
    }

    private createFileRow(entry: Entry): HTMLElement {
        const row = document.createElement('div');
        row.className = 'list-files-row';
        const entryPath = resolve(this.currentPath, entry.name);
        row.setAttribute('data-path', entryPath);

        if (entry.isDirectory()) {
            row.classList.add('directory');
        }

        if (this.selectedPaths.has(entryPath)) {
            row.classList.add('selected');
        }

        // Checkbox
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'list-files-row-check';
        check.checked = this.selectedPaths.has(entryPath);
        check.addEventListener('change', (e) => {
            e.stopPropagation();
            if (check.checked) {
                this.selectedPaths.add(entryPath);
                row.classList.add('selected');
            } else {
                this.selectedPaths.delete(entryPath);
                row.classList.remove('selected');
            }
            this.updateHeaderCheck();
            this.updateFooterState();
        });
        check.addEventListener('click', (e) => e.stopPropagation());
        row.appendChild(check);

        // Icon
        const icon = createFileIconForEntry(entry.name, entry.isDirectory(), entry.isSymbolicLink());
        row.appendChild(icon);

        // Name
        const nameSpan = document.createElement('span');
        nameSpan.className = 'list-files-row-name';
        nameSpan.textContent = entry.name;
        row.appendChild(nameSpan);

        // Size
        const sizeSpan = document.createElement('span');
        sizeSpan.className = 'list-files-row-size';
        sizeSpan.textContent = entry.isDirectory() ? '' : formatSize(entry.size);
        row.appendChild(sizeSpan);

        // Date
        const dateSpan = document.createElement('span');
        dateSpan.className = 'list-files-row-date';
        dateSpan.textContent = formatDate(entry.mtime);
        row.appendChild(dateSpan);

        // Hover actions
        const actions = document.createElement('div');
        actions.className = 'list-files-row-actions';

        if (entry.isFile()) {
            const dlBtn = document.createElement('button');
            dlBtn.className = 'list-files-action-btn list-files-action-download';
            dlBtn.textContent = '\u2b07'; // ⬇
            dlBtn.title = 'download';
            dlBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.downloadFile(entryPath, entry);
            });
            actions.appendChild(dlBtn);
        }

        const delBtn = document.createElement('button');
        delBtn.className = 'list-files-action-btn list-files-action-delete';
        delBtn.textContent = '\u2715'; // ✕
        delBtn.title = 'delete';
        delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm(`delete "${entry.name}"?`)) {
                this.deleteFiles([entryPath]);
            }
        });
        actions.appendChild(delBtn);

        row.appendChild(actions);

        // Row click: navigate into directories
        row.addEventListener('click', () => {
            if (entry.isDirectory()) {
                this.loadDirectory(entryPath);
            }
        });

        return row;
    }

    private showLoading(): void {
        if (!this.fileListBody) return;
        this.fileListBody.innerHTML = '';
        const loading = document.createElement('div');
        loading.className = 'list-files-loading';
        loading.textContent = 'loading...';
        this.fileListBody.appendChild(loading);
    }

    // ── Selection ──

    private toggleSelectAll(): void {
        if (!this.headerCheck) return;
        const selectAll = this.headerCheck.checked;

        if (selectAll) {
            this.filteredEntries.forEach((entry) => {
                this.selectedPaths.add(resolve(this.currentPath, entry.name));
            });
        } else {
            this.selectedPaths.clear();
        }

        // Update all visible checkboxes
        this.fileListBody?.querySelectorAll('.list-files-row').forEach((row) => {
            const check = row.querySelector('.list-files-row-check') as HTMLInputElement;
            if (check) check.checked = selectAll;
            row.classList.toggle('selected', selectAll);
        });

        this.updateFooterState();
    }

    private updateHeaderCheck(): void {
        if (!this.headerCheck) return;
        const total = this.filteredEntries.length;
        const selected = this.selectedPaths.size;
        this.headerCheck.checked = total > 0 && selected === total;
        this.headerCheck.indeterminate = selected > 0 && selected < total;
    }

    // ── Footer state ──

    private updateFooterState(): void {
        const hasSelection = this.selectedPaths.size > 0;
        const hasFileSelection = this.filteredEntries.some(
            (e) => e.isFile() && this.selectedPaths.has(resolve(this.currentPath, e.name)),
        );

        if (this.footerDeleteBtn) this.footerDeleteBtn.disabled = !hasSelection;
        if (this.footerDownloadBtn) this.footerDownloadBtn.disabled = !hasFileSelection;

        this.updateFooterInfo();
    }

    private updateFooterInfo(): void {
        if (!this.footerInfo) return;

        const selectedCount = this.selectedPaths.size;
        const totalCount = this.filteredEntries.length;

        if (selectedCount > 0) {
            this.footerInfo.textContent = `${selectedCount} selected / ${totalCount} items`;
        } else {
            this.footerInfo.textContent = `${totalCount} items`;
        }
    }

    // ── Download ──

    private downloadSelected(): void {
        this.filteredEntries.forEach((entry) => {
            if (entry.isFile()) {
                const path = resolve(this.currentPath, entry.name);
                if (this.selectedPaths.has(path)) {
                    this.downloadFile(path, entry);
                }
            }
        });
    }

    // ── Upload ──

    private triggerUpload(): void {
        this.uploadInput?.click();
    }

    private handleUploadInput(): void {
        if (!this.uploadInput?.files) return;
        const files = Array.from(this.uploadInput.files);
        if (files.length === 0) return;

        // Use the FilePushHandler directly
        if (this.filePushHandler) {
            this.filePushHandler.onFilesDrop(files);
        }

        // Reset input so the same file can be uploaded again
        this.uploadInput.value = '';
    }

    // DragAndPushListener interface
    public onDragEnter(): boolean {
        if (this.enterCount === 0 && this.dropZone) {
            this.dropZone.style.display = 'flex';
        }
        this.enterCount++;
        return true;
    }

    public onDragLeave(): boolean {
        this.enterCount--;
        if (this.enterCount < 0) this.enterCount = 0;
        if (this.enterCount === 0 && this.dropZone) {
            this.dropZone.style.display = 'none';
        }
        return true;
    }

    public onDrop(): boolean {
        this.enterCount = 0;
        if (this.dropZone) this.dropZone.style.display = 'none';
        return true;
    }

    public onFilePushUpdate(data: PushUpdateParams): void {
        const { fileName, progress, error, message, finished } = data;
        let upload = this.uploads.get(fileName);

        if (!upload) {
            // Create an upload row in the file list
            const row = document.createElement('div');
            row.className = 'list-files-row';
            row.id = `upload-${fileName}`;

            const spacer = document.createElement('input');
            spacer.type = 'checkbox';
            spacer.className = 'list-files-row-check';
            spacer.disabled = true;
            row.appendChild(spacer);

            const icon = createFileIconForEntry(fileName, false, false);
            row.appendChild(icon);

            const nameSpan = document.createElement('span');
            nameSpan.className = 'list-files-row-name';
            nameSpan.textContent = `${fileName}: ${message}`;
            row.appendChild(nameSpan);

            const progressEl = document.createElement('div');
            progressEl.className = 'list-files-progress';
            row.appendChild(progressEl);

            upload = { row, progressEl, timeout: null };
            this.uploads.set(fileName, upload);
            this.activeUploads++;

            // Insert at top of file list
            if (this.fileListBody) {
                this.fileListBody.insertBefore(row, this.fileListBody.firstChild);
            }
        }

        const { row, progressEl } = upload;
        const nameSpan = row.querySelector('.list-files-row-name');

        if (error) {
            this.uploads.delete(fileName);
            this.activeUploads--;
            progressEl.style.width = '100%';
            progressEl.classList.add('error');
            if (nameSpan) nameSpan.textContent = `${fileName}: ${message}`;
            if (!upload.timeout) {
                upload.timeout = window.setTimeout(() => {
                    row.remove();
                    this.loadDirectory(this.currentPath);
                }, REMOVE_ROW_TIMEOUT);
            }
        } else {
            if (nameSpan) nameSpan.textContent = `${fileName}: ${message}`;
            progressEl.style.width = `${progress}%`;
        }

        if (finished && !error) {
            this.uploads.delete(fileName);
            this.activeUploads--;
            // Reload directory to show the new file
            this.loadDirectory(this.currentPath);
        }
    }

    public onError(error: string | Error): void {
        console.error(TAG, 'upload error:', error);
    }

    // ── Delete ──

    private deleteSelected(): void {
        const paths = Array.from(this.selectedPaths);
        if (paths.length === 0) return;
        const count = paths.length;
        if (!confirm(`delete ${count} item${count > 1 ? 's' : ''}?`)) return;
        this.deleteFiles(paths);
    }

    private async deleteFiles(paths: string[]): Promise<void> {
        try {
            const resp = await fetch('/api/devices/files/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ udid: this.udid, paths }),
            });
            const result = await resp.json();
            if (!result.success && result.errors) {
                const errorMsg = result.errors.join('\n');
                console.error(TAG, 'delete errors:', errorMsg);
                // Show error briefly in footer
                if (this.footerInfo) {
                    this.footerInfo.textContent = `delete failed: ${result.errors[0]}`;
                    setTimeout(() => this.updateFooterInfo(), 10000);
                }
            }
        } catch (err) {
            console.error(TAG, 'delete request failed:', err);
            if (this.footerInfo) {
                this.footerInfo.textContent = 'delete request failed';
                setTimeout(() => this.updateFooterInfo(), 10000);
            }
        }
        // Reload current directory
        this.loadDirectory(this.currentPath);
    }
}
