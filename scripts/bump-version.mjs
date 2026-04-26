#!/usr/bin/env node
// scripts/bump-version.mjs
//
// Bump the project version in lockstep across:
//   - package.json     (npm package version)
//   - Cargo.toml       (workspace.package.version, propagated to launcher + tray)
//   - CHANGELOG.md     ([Unreleased] -> [<version>] - YYYY-MM-DD; new [Unreleased] block left empty)
//
// Usage:
//   node scripts/bump-version.mjs <new-version>
//   npm run version:bump <new-version>
//
// Validates the new version is well-formed semver before touching any files.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

// Liberal semver regex: major.minor.patch with optional prerelease and build metadata.
// Examples: 0.1.0, 0.1.0-pre.1, 1.0.0-beta.3+build.4
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

export function validateSemver(v) {
    if (typeof v !== 'string' || !SEMVER_RE.test(v)) {
        throw new Error(`Invalid semver: "${v}"`);
    }
}

export function bumpPackageJson(content, newVersion) {
    const updated = content.replace(/("version"\s*:\s*")[^"]+(")/, `$1${newVersion}$2`);
    if (updated === content) {
        throw new Error('package.json: no "version" field found to update');
    }
    return updated;
}

export function bumpCargoToml(content, newVersion) {
    // Match the version field within [workspace.package]. Non-greedy so we
    // stop at the FIRST `version = "..."` after `[workspace.package]`.
    const re = /(\[workspace\.package\][\s\S]*?\nversion\s*=\s*")[^"]+(")/;
    const updated = content.replace(re, `$1${newVersion}$2`);
    if (updated === content) {
        throw new Error('Cargo.toml: [workspace.package] version field not found');
    }
    return updated;
}

export function formatToday(now = new Date()) {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

export function bumpChangelog(content, newVersion, today = formatToday()) {
    if (content.includes(`## [${newVersion}]`)) {
        throw new Error(`CHANGELOG.md already has a section for [${newVersion}]`);
    }

    const lines = content.split(/\r?\n/);
    const unreleasedIdx = lines.findIndex((l) => l.trim() === '## [Unreleased]');
    if (unreleasedIdx === -1) {
        throw new Error('CHANGELOG.md does not contain "## [Unreleased]" section');
    }

    // Find the next `## ` heading after [Unreleased]; insert the new release
    // header just before it (or at EOF if none).
    let nextHeadingIdx = lines.length;
    for (let i = unreleasedIdx + 1; i < lines.length; i++) {
        if (lines[i].startsWith('## ')) {
            nextHeadingIdx = i;
            break;
        }
    }

    const newHeading = `## [${newVersion}] - ${today}`;
    lines.splice(nextHeadingIdx, 0, newHeading, '');
    return lines.join('\n');
}

async function main() {
    const newVersion = process.argv[2];
    if (!newVersion) {
        console.error('Usage: node scripts/bump-version.mjs <new-version>');
        process.exit(1);
    }
    validateSemver(newVersion);

    const today = formatToday();
    const pkgPath = join(REPO_ROOT, 'package.json');
    const cargoPath = join(REPO_ROOT, 'Cargo.toml');
    const changelogPath = join(REPO_ROOT, 'CHANGELOG.md');

    const pkg = readFileSync(pkgPath, 'utf8');
    const cargo = readFileSync(cargoPath, 'utf8');
    const changelog = readFileSync(changelogPath, 'utf8');

    // Compute first (so any failure leaves all files untouched).
    const newPkg = bumpPackageJson(pkg, newVersion);
    const newCargo = bumpCargoToml(cargo, newVersion);
    const newChangelog = bumpChangelog(changelog, newVersion, today);

    writeFileSync(pkgPath, newPkg);
    writeFileSync(cargoPath, newCargo);
    writeFileSync(changelogPath, newChangelog);

    console.log(`Bumped to v${newVersion}`);
    console.log('  package.json     OK');
    console.log('  Cargo.toml       OK');
    console.log(`  CHANGELOG.md     OK ([${newVersion}] - ${today})`);
}

// Run main when invoked as the entry script (not when imported by tests).
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/bump-version.mjs')) {
    main().catch((e) => {
        console.error(`Error: ${e.message}`);
        process.exit(1);
    });
}
