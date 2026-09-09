#!/usr/bin/env node
/**
 * tools/gen-locale.mjs
 *
 * 负责 gettext 多语言文件的编译、检查与提取。
 *
 * 用法：
 *   node tools/gen-locale.mjs          # 编译 po/*.po 到 src/locale/<lang>/LC_MESSAGES/<domain>.mo
 *   node tools/gen-locale.mjs --check  # 检查 mo 文件是否最新且与 po 一致
 *   node tools/gen-locale.mjs --extract # 重新提取 pot 并合并 po
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

    console.log(`[gen-locale] 提取源码文本到 ${potFile}...`);
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
        console.log(`[gen-locale] 合并更新 ${path.basename(poFile)}...`);
        execFileSync('msgmerge', ['--update', poFile, potFile]);
    }
    console.log('[gen-locale] 提取与合并完成');
    process.exit(0);
}

if (isCheck) {
    const poFiles = getPoFiles();
    if (poFiles.length === 0) {
        console.log('[gen-locale] 无 .po 文件需要检查');
        process.exit(0);
    }

    for (const poFile of poFiles) {
        const lang = path.basename(poFile, '.po');
        const moFile = path.join(srcLocaleDir, lang, 'LC_MESSAGES', `${domain}.mo`);
        if (!fs.existsSync(moFile)) {
            console.error(`[gen-locale] 缺少编译产物: ${moFile}，请运行 node tools/gen-locale.mjs`);
            process.exit(1);
        }

        const poMtime = fs.statSync(poFile).mtimeMs;
        const moMtime = fs.statSync(moFile).mtimeMs;
        if (poMtime > moMtime) {
            console.error(`[gen-locale] ${moFile} 落后于 ${poFile}，请运行 node tools/gen-locale.mjs 重新编译`);
            process.exit(1);
        }
    }

    console.log(`[gen-locale] OK: 所有 ${poFiles.length} 个语言包编译产物均有效且最新`);
    process.exit(0);
}

// 默认执行：编译所有 po 文件
const poFiles = getPoFiles();
if (poFiles.length === 0) {
    console.log('[gen-locale] 没有找到 po 文件');
    process.exit(0);
}

for (const poFile of poFiles) {
    const { lang, moFile } = compilePo(poFile);
    console.log(`[gen-locale] 编译 ${lang} -> ${path.relative(rootDir, moFile)}`);
}
console.log(`[gen-locale] 成功编译 ${poFiles.length} 个语言包`);
