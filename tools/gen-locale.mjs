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

import { execFileSync } from 'child_process';
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

if (isExtract) {
    const potFile = path.join(poDir, `${domain}.pot`);
    const potFilesList = path.join(poDir, 'POTFILES.in');

    fs.mkdirSync(poDir, { recursive: true });

    console.log(`[gen-locale] Extracting source strings to ${potFile}...`);
    execFileSync('xgettext', [
        `--default-domain=${domain}`,
        '--output=' + potFile,
        '--language=JavaScript',
        '--keyword=_',
        '--keyword=N_',
        '--from-code=UTF-8',
        '--files-from=' + potFilesList,
        '--add-comments',
    ], { cwd: rootDir });

    const poFiles = getPoFiles();
    for (const poFile of poFiles) {
        console.log(`[gen-locale] Merging updates for ${path.basename(poFile)}...`);
        execFileSync('msgmerge', ['--update', poFile, potFile]);
    }
    console.log('[gen-locale] Extraction and merge completed');
    process.exit(0);
}

if (isCheck) {
    const poFiles = getPoFiles();
    if (poFiles.length === 0) {
        console.log('[gen-locale] No .po files to check');
        process.exit(0);
    }

    for (const poFile of poFiles) {
        const lang = path.basename(poFile, '.po');
        const moFile = path.join(srcLocaleDir, lang, 'LC_MESSAGES', `${domain}.mo`);
        if (!fs.existsSync(moFile)) {
            console.error(`[gen-locale] Missing compiled file: ${moFile}, please run node tools/gen-locale.mjs`);
            process.exit(1);
        }

        const poMtime = fs.statSync(poFile).mtimeMs;
        const moMtime = fs.statSync(moFile).mtimeMs;
        if (poMtime > moMtime) {
            console.error(`[gen-locale] ${moFile} is older than ${poFile}, please run node tools/gen-locale.mjs to recompile`);
            process.exit(1);
        }
    }

    console.log(`[gen-locale] OK: All ${poFiles.length} locale MO files are valid and up to date`);
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

