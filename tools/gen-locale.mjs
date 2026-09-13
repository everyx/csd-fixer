#!/usr/bin/env node
/**
 * tools/gen-locale.mjs
 *
 * Compiles, checks, and extracts gettext translation files.
 *
 * Usage:
 *   node tools/gen-locale.mjs          # Compiles po/*.po to src/locale/<lang>/LC_MESSAGES/<domain>.mo
 *   node tools/gen-locale.mjs --check  # Verifies that mo files are up to date and consistent with po files
 *   node tools/gen-locale.mjs --extract # Re-extracts pot from source and updates po files
 */

import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const poDir = path.join(rootDir, 'po');
const srcLocaleDir = path.join(rootDir, 'src', 'locale');
const metadataPath = path.join(rootDir, 'src', 'metadata.json');

const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
const domain = metadata['gettext-domain'] || metadata['uuid'];

const args = process.argv.slice(2);
const isCheck = args.includes('--check');
const isExtract = args.includes('--extract');

function getPoFiles() {
    if (!fs.existsSync(poDir))
        return [];
    return fs.readdirSync(poDir)
        .filter(f => f.endsWith('.po'))
        .map(f => path.join(poDir, f));
}

function compilePo(poFile) {
    const lang = path.basename(poFile, '.po');
    const outDir = path.join(srcLocaleDir, lang, 'LC_MESSAGES');
    const moFile = path.join(outDir, `${domain}.mo`);

    fs.mkdirSync(outDir, { recursive: true });
    execFileSync('msgfmt', [poFile, '-o', moFile]);
    return { lang, moFile };
}

const potFilesList = path.join(poDir, 'POTFILES.in');
const XGETTEXT_ARGS = [
    `--default-domain=${domain}`,
    '--language=JavaScript',
    '--keyword=_',
    '--keyword=N_',
    '--from-code=UTF-8',
    '--files-from=' + potFilesList,
    '--add-comments',
];

if (isExtract) {
    const potFile = path.join(poDir, `${domain}.pot`);

    fs.mkdirSync(poDir, { recursive: true });

    console.log(`[gen-locale] Extracting source strings to ${potFile}...`);
    execFileSync('xgettext', [...XGETTEXT_ARGS, '--output=' + potFile], { cwd: rootDir });

    const poFiles = getPoFiles();
    for (const poFile of poFiles) {
        console.log(`[gen-locale] Merging updates for ${path.basename(poFile)}...`);
        // The catalogues are tracked in git, which is the backup. msgmerge keeps
        // its own copy as <file>~, which only ever adds untracked clutter for a
        // broad `git add po` to pick up by accident.
        execFileSync('msgmerge', ['--update', '--backup=none', poFile, potFile]);
        execFileSync('msgattrib', ['--no-obsolete', '-o', poFile, poFile]);
    }
    console.log('[gen-locale] Extraction and merge completed');
    process.exit(0);
}

if (isCheck) {
    const potFile = path.join(poDir, `${domain}.pot`);

    if (!fs.existsSync(potFile)) {
        console.error(`[gen-locale] --check failed: template file ${potFile} not found`);
        process.exit(1);
    }

    // 1. Verify that po/window-nativizer.pot matches current source code exactly
    const diskPot = fs.readFileSync(potFile, 'utf8');
    let freshPot = '';
    try {
        freshPot = execFileSync('xgettext', [...XGETTEXT_ARGS, '--output=-'], { cwd: rootDir, encoding: 'utf8' });
    } catch (e) {
        console.error('[gen-locale] --check failed: error extracting strings with xgettext:', e.message);
        process.exit(1);
    }

    const normalizePot = content => content
        .split('\n')
        .filter(l => !l.startsWith('"POT-Creation-Date:'))
        .join('\n')
        .trim();

    if (normalizePot(diskPot) !== normalizePot(freshPot)) {
        console.error(`[gen-locale] --check failed: ${path.basename(potFile)} is out of sync with source code.`);
        console.error('[gen-locale] Strings in source files have been changed, added, or removed.');
        console.error('[gen-locale] Please run "pnpm run update-po" and commit the updated translation files.');
        process.exit(1);
    }

    // 2. Verify all .po catalogs for syntax and completeness
    const poFiles = getPoFiles();
    if (poFiles.length === 0) {
        console.log('[gen-locale] No .po files to check');
        process.exit(0);
    }

    for (const poFile of poFiles) {
        const basename = path.basename(poFile);
        try {
            execFileSync('msgfmt', ['--check', '-o', '/dev/null', poFile]);
        } catch {
            console.error(`[gen-locale] --check failed: syntax error in ${basename}`);
            process.exit(1);
        }

        const statsResult = spawnSync('msgfmt', ['--statistics', '-o', '/dev/null', poFile]);
        const stats = statsResult.stderr ? statsResult.stderr.toString().trim() : '';
        if (stats.includes('fuzzy') || stats.includes('untranslated')) {
            console.error(`[gen-locale] --check failed: ${basename} has incomplete translations: ${stats}`);
            console.error('[gen-locale] Please complete translations and run "pnpm run compile-locales".');
            process.exit(1);
        }
    }

    console.log(`[gen-locale] OK: Template ${path.basename(potFile)} is synchronized with source code, and all ${poFiles.length} PO files are complete and valid`);
    process.exit(0);
}

// Default execution: compile all po files
const poFiles = getPoFiles();
if (poFiles.length === 0) {
    console.log('[gen-locale] No po files found');
    process.exit(0);
}

for (const poFile of poFiles) {
    const { lang, moFile } = compilePo(poFile);
    console.log(`[gen-locale] Compiling ${lang} -> ${path.relative(rootDir, moFile)}`);
}
console.log(`[gen-locale] Successfully compiled ${poFiles.length} locale(s)`);

