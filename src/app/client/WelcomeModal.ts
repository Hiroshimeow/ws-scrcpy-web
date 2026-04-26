import { Modal } from '../ui/Modal';

export type WelcomeChoice = 'service' | 'on-demand';

export interface WelcomeModalOptions {
    webPort: number;
    portWasAutoShifted: boolean;
    onDecision: (choice: WelcomeChoice) => void;
}

export class WelcomeModal extends Modal {
    private opts!: WelcomeModalOptions;
    private yesBtn!: HTMLButtonElement;
    private noBtn!: HTMLButtonElement;

    constructor(options: WelcomeModalOptions) {
        super({ title: 'Welcome to ws-scrcpy-web' });
        this.opts = options;
        this.dialog.classList.add('welcome-modal');
        // Defer body/footer fill past class-field init phase (ES2022 useDefineForClassFields).
        queueMicrotask(() => {
            this.fillBody(this.bodyEl);
        });
    }

    protected buildBody(_container: HTMLElement): void {
        // Body content is rendered by fillBody() from the constructor via queueMicrotask
        // so that this.opts and any subclass fields are initialized before they're read.
    }

    private fillBody(container: HTMLElement): void {
        const intro = document.createElement('p');
        intro.style.cssText = 'margin: 0 0 8px;';
        intro.appendChild(document.createTextNode('server is running on '));
        const link = document.createElement('a');
        const url = `http://localhost:${this.opts.webPort}`;
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = url;
        link.style.cssText = 'color: #5b9aff;';
        intro.appendChild(link);
        container.appendChild(intro);

        if (this.opts.portWasAutoShifted) {
            const shifted = document.createElement('p');
            shifted.style.cssText = 'margin: 0 0 8px; color: var(--text-color-light); font-size: 13px;';
            shifted.textContent =
                `default port 8000 was in use; we auto-picked ${this.opts.webPort}. ` +
                'change anytime in settings.';
            container.appendChild(shifted);
        } else {
            const note = document.createElement('p');
            note.style.cssText = 'margin: 0 0 8px; color: var(--text-color-light); font-size: 13px;';
            note.textContent = 'you can change the port anytime in settings.';
            container.appendChild(note);
        }

        const divider = document.createElement('hr');
        divider.style.cssText =
            'border: none; border-top: 1px solid rgba(255,255,255,0.08); margin: 16px 0;';
        container.appendChild(divider);

        const heading = document.createElement('p');
        heading.style.cssText = 'margin: 0 0 8px; font-weight: 600; font-size: 14px;';
        heading.textContent = 'run as a windows service?';
        container.appendChild(heading);

        const desc = document.createElement('p');
        desc.style.cssText = 'margin: 0 0 8px;';
        desc.textContent =
            'recommended for always-on access (headless servers, multi-user setups). ' +
            'the server starts with windows and runs in the background.';
        container.appendChild(desc);

        const later = document.createElement('p');
        later.style.cssText = 'margin: 0 0 16px; color: var(--text-color-light); font-size: 13px;';
        later.textContent = 'you can change this later in settings.';
        container.appendChild(later);

        const buttons = document.createElement('div');
        buttons.style.cssText = 'display: flex; gap: 12px; justify-content: flex-end; flex-wrap: wrap;';

        this.yesBtn = document.createElement('button');
        this.yesBtn.textContent = 'yes, install service';
        this.yesBtn.style.cssText =
            'border: 0.5px solid var(--text-color, #ddd); border-radius: 6px; ' +
            'background: transparent; color: #5b9aff; padding: 8px 16px; cursor: pointer;';
        this.yesBtn.addEventListener('click', () => this.choose('service'));
        buttons.appendChild(this.yesBtn);

        this.noBtn = document.createElement('button');
        this.noBtn.textContent = 'no, run on demand';
        this.noBtn.style.cssText =
            'border: 0.5px solid var(--text-color, #ddd); border-radius: 6px; ' +
            'background: transparent; color: #5b9aff; padding: 8px 16px; cursor: pointer;';
        this.noBtn.addEventListener('click', () => this.choose('on-demand'));
        buttons.appendChild(this.noBtn);

        container.appendChild(buttons);
    }

    private choose(choice: WelcomeChoice): void {
        this.opts.onDecision(choice);
        this.close();
    }

    /** No-op: Modal base shows the dialog from its constructor. Provided for caller ergonomics. */
    public show(): void {
        if (!this.dialog.open) {
            this.dialog.showModal();
        }
    }
}
