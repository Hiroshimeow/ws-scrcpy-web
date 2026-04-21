// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import { execFileSync } from 'child_process';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as crypto from 'crypto';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as fs from 'fs';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as path from 'path';

/**
 * Build a tarball named {key}.tar.gz whose contents are everything under
 * `srcDir`, mirroring the matrix workflow's output format (archive has a
 * single top-level dir named after the key; resolver extracts with
 * --strip-components=1).
 *
 * Returns the tarball path and its SHA256 hash.
 */
export function buildFixtureTarball(srcDir: string, key: string, outDir: string): { tarPath: string; sha256: string } {
    fs.mkdirSync(outDir, { recursive: true });
    const stagingDir = path.join(outDir, '_staging');
    const keyDir = path.join(stagingDir, key);
    fs.mkdirSync(keyDir, { recursive: true });
    fs.cpSync(srcDir, keyDir, { recursive: true });

    const tarPath = path.join(outDir, `${key}.tar.gz`);
    execFileSync('tar', ['-czf', tarPath, '-C', stagingDir, key], { stdio: 'inherit' });
    fs.rmSync(stagingDir, { recursive: true, force: true });

    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(tarPath));
    return { tarPath, sha256: hash.digest('hex') };
}
