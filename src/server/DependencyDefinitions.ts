// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import os from 'os';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import path from 'path';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import { execFile } from 'child_process';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import { promisify } from 'util';
import { SERVER_VERSION } from '../common/Constants';

const execFileAsync = promisify(execFile);

export function getPlatform(): 'win32' | 'linux' {
    return os.platform() === 'win32' ? 'win32' : 'linux';
}

export function getArch(): 'x64' | 'arm64' {
    return os.arch() === 'arm64' ? 'arm64' : 'x64';
}

export interface DependencyDefinition {
    name: string;
    displayName: string;
    description: string;
    requiresRestart: boolean;
    pairedWith?: string;
    checkInstalled: (depsPath: string) => Promise<string | null>;
    checkLatest: () => Promise<string | null>;
    getDownloadUrl: (version: string) => string;
}

async function runVersionCommand(exe: string, args: string[], pattern: RegExp): Promise<string | null> {
    try {
        const { stdout } = await execFileAsync(exe, args, { timeout: 5000 });
        const match = stdout.match(pattern);
        return match ? match[1] : null;
    } catch {
        return null;
    }
}

export function getDependencyDefinitions(): DependencyDefinition[] {
    const platform = getPlatform();
    const arch = getArch();

    return [
        {
            name: 'nodejs',
            displayName: 'Node.js',
            description: 'JavaScript runtime that runs the ws-scrcpy-web server',
            requiresRestart: true,
            pairedWith: 'node-pty',
            checkInstalled: async (depsPath) => {
                const ext = platform === 'win32' ? '.exe' : '';
                const exe = path.join(depsPath, 'node', `node${ext}`);
                return runVersionCommand(exe, ['--version'], /v([\d.]+)/);
            },
            checkLatest: async () => {
                const res = await fetch('https://nodejs.org/dist/index.json');
                const releases = (await res.json()) as { version: string; lts: string | false }[];
                const lts = releases.find((r) => r.lts !== false);
                return lts ? lts.version.replace(/^v/, '') : null;
            },
            getDownloadUrl: (version) => {
                if (platform === 'win32') {
                    return `https://nodejs.org/dist/v${version}/node-v${version}-win-${arch}.zip`;
                }
                return `https://nodejs.org/dist/v${version}/node-v${version}-linux-${arch}.tar.gz`;
            },
        },
        {
            name: 'adb',
            displayName: 'ADB (Android Debug Bridge)',
            description: 'Communicates with Android devices (push, shell, tunnel)',
            requiresRestart: false,
            checkInstalled: async (depsPath) => {
                const ext = platform === 'win32' ? '.exe' : '';
                const exe = path.join(depsPath, 'adb', `adb${ext}`);
                return runVersionCommand(exe, ['--version'], /Version ([\d.]+)/);
            },
            checkLatest: async () => {
                const res = await fetch('https://dl.google.com/android/repository/repository2-3.xml');
                const xml = await res.text();
                const match = xml.match(
                    /path="platform-tools"[\s\S]*?<major>(\d+)<\/major>\s*<minor>(\d+)<\/minor>\s*<micro>(\d+)<\/micro>/,
                );
                return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
            },
            getDownloadUrl: (_version) => {
                if (platform === 'win32') {
                    return 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip';
                }
                return 'https://dl.google.com/android/repository/platform-tools-latest-linux.zip';
            },
        },
        {
            name: 'scrcpy-server',
            displayName: 'scrcpy-server',
            description: 'Runs on Android device to capture screen, audio, and accept input',
            requiresRestart: false,
            checkInstalled: async (_depsPath) => {
                return SERVER_VERSION;
            },
            checkLatest: async () => {
                const res = await fetch('https://api.github.com/repos/Genymobile/scrcpy/releases/latest', {
                    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ws-scrcpy-web' },
                });
                const data = (await res.json()) as { tag_name: string };
                return data.tag_name?.replace(/^v/, '') ?? null;
            },
            getDownloadUrl: (version) => {
                return `https://github.com/Genymobile/scrcpy/releases/download/v${version}/scrcpy-server-v${version}`;
            },
        },
    ];
}
