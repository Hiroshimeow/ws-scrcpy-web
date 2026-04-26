import { describe, expect, it } from 'vitest';
import {
    bumpCargoToml,
    bumpChangelog,
    bumpPackageJson,
    formatToday,
    validateSemver,
} from '../bump-version.mjs';

describe('validateSemver', () => {
    it('accepts plain semver', () => {
        expect(() => validateSemver('0.1.0')).not.toThrow();
        expect(() => validateSemver('1.2.3')).not.toThrow();
        expect(() => validateSemver('0.0.0')).not.toThrow();
    });

    it('accepts prerelease', () => {
        expect(() => validateSemver('0.1.0-pre.1')).not.toThrow();
        expect(() => validateSemver('1.0.0-beta.3')).not.toThrow();
    });

    it('accepts prerelease with build metadata', () => {
        expect(() => validateSemver('1.0.0-beta.3+build.4')).not.toThrow();
    });

    it('rejects v-prefix', () => {
        expect(() => validateSemver('v0.1.0')).toThrow(/Invalid semver/);
    });

    it('rejects partial versions', () => {
        expect(() => validateSemver('1.0')).toThrow(/Invalid semver/);
        expect(() => validateSemver('1')).toThrow(/Invalid semver/);
    });

    it('rejects non-string', () => {
        expect(() => validateSemver(undefined)).toThrow(/Invalid semver/);
        expect(() => validateSemver(null)).toThrow(/Invalid semver/);
        expect(() => validateSemver(123)).toThrow(/Invalid semver/);
    });
});

describe('bumpPackageJson', () => {
    it('replaces the top-level version field', () => {
        const input = '{\n  "name": "x",\n  "version": "1.0.0",\n  "other": 1\n}';
        const out = bumpPackageJson(input, '0.1.0');
        expect(out).toContain('"version": "0.1.0"');
        expect(out).not.toContain('"version": "1.0.0"');
    });

    it('preserves surrounding formatting', () => {
        const input = '{\n  "version": "1.2.3"\n}';
        const out = bumpPackageJson(input, '4.5.6');
        expect(out).toBe('{\n  "version": "4.5.6"\n}');
    });

    it('throws if no version field', () => {
        expect(() => bumpPackageJson('{}', '0.1.0')).toThrow(/no "version" field/);
    });
});

describe('bumpCargoToml', () => {
    const sampleCargo = `[workspace]
resolver = "2"
members = ["launcher", "tray"]

[workspace.package]
version = "0.0.0"
edition = "2021"

[workspace.dependencies]
serde = { version = "1.0" }
`;

    it('replaces the workspace.package version', () => {
        const out = bumpCargoToml(sampleCargo, '0.1.0');
        expect(out).toContain('version = "0.1.0"');
        expect(out).not.toContain('version = "0.0.0"');
    });

    it('does NOT touch dependency versions', () => {
        const out = bumpCargoToml(sampleCargo, '0.1.0');
        // serde dep version still "1.0"
        expect(out).toContain('serde = { version = "1.0" }');
    });

    it('throws if no workspace.package version found', () => {
        const noWorkspace = '[package]\nversion = "0.1.0"\n';
        expect(() => bumpCargoToml(noWorkspace, '0.2.0')).toThrow(/\[workspace\.package\]/);
    });
});

describe('bumpChangelog', () => {
    const sampleChangelog = `# Changelog

## [Unreleased]

### Added
- some new thing

## [0.0.1] - 2026-01-01

### Added
- initial
`;

    it('inserts new release header before the next section', () => {
        const out = bumpChangelog(sampleChangelog, '0.1.0', '2026-04-26');
        expect(out).toContain('## [Unreleased]');
        expect(out).toContain('## [0.1.0] - 2026-04-26');
        expect(out).toContain('## [0.0.1] - 2026-01-01');
        // Order: [Unreleased] -> [0.1.0] -> [0.0.1]
        const idxUnreleased = out.indexOf('## [Unreleased]');
        const idxNew = out.indexOf('## [0.1.0]');
        const idxOld = out.indexOf('## [0.0.1]');
        expect(idxUnreleased).toBeLessThan(idxNew);
        expect(idxNew).toBeLessThan(idxOld);
    });

    it('preserves [Unreleased] content above the new heading', () => {
        const out = bumpChangelog(sampleChangelog, '0.1.0', '2026-04-26');
        // The "some new thing" entry should still appear under [Unreleased]
        const unreleasedSection = out.slice(
            out.indexOf('## [Unreleased]'),
            out.indexOf('## [0.1.0]'),
        );
        expect(unreleasedSection).toContain('some new thing');
    });

    it('throws if [Unreleased] section is missing', () => {
        const noUnreleased = '# Changelog\n\n## [0.0.1] - 2026-01-01\n';
        expect(() => bumpChangelog(noUnreleased, '0.1.0')).toThrow(/Unreleased/);
    });

    it('throws if a section for the target version already exists', () => {
        const dup = '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-04-01\n';
        expect(() => bumpChangelog(dup, '0.1.0')).toThrow(/already has a section for \[0\.1\.0\]/);
    });

    it('handles a changelog with only [Unreleased] (no prior release)', () => {
        const empty = '# Changelog\n\n## [Unreleased]\n';
        const out = bumpChangelog(empty, '0.1.0', '2026-04-26');
        expect(out).toContain('## [0.1.0] - 2026-04-26');
    });
});

describe('formatToday', () => {
    it('zero-pads month and day', () => {
        expect(formatToday(new Date(2026, 0, 5))).toBe('2026-01-05');
    });

    it('uses 4-digit year', () => {
        expect(formatToday(new Date(2026, 11, 31))).toBe('2026-12-31');
    });
});
