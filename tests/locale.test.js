/**
 * i18n multilingual unit tests:
 * Verifies integrity of gettext translation files (pot, po, mo) and consistency with metadata.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

function readFile(filePath) {
    const file = Gio.File.new_for_path(filePath);
    const [ok, contents] = file.load_contents(null);
    if (!ok)
        throw new Error(`Failed to read ${filePath}`);
    return new TextDecoder('utf-8').decode(contents);
}

function fileExists(filePath) {
    return Gio.File.new_for_path(filePath).query_exists(null);
}

function getFileSize(filePath) {
    const file = Gio.File.new_for_path(filePath);
    const info = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
    return info.get_size();
}

describe('i18n multilingual support', () => {
    const rootDir = GLib.get_current_dir();
    const poDir = GLib.build_filenamev([rootDir, 'po']);
    const srcLocaleDir = GLib.build_filenamev([rootDir, 'src', 'locale']);
    const metadataPath = GLib.build_filenamev([rootDir, 'src', 'metadata.json']);

    it('metadata.json declares correct gettext-domain', () => {
        const metadata = JSON.parse(readFile(metadataPath));
        expect(metadata['gettext-domain']).toBe('csd-fixer');
    });

    it('template file csd-fixer.pot contains core preference UI keys', () => {
        const potFile = GLib.build_filenamev([poDir, 'csd-fixer.pot']);
        expect(fileExists(potFile)).toBeTrue();

        const potContent = readFile(potFile);
        expect(potContent).toContain('Prioritize Crisp Text');
        expect(potContent).toContain('Suppress Rules');
        expect(potContent).toContain('Force Rules');
        expect(potContent).toContain('Suppress Window…');
        expect(potContent).toContain('Force Window…');
        expect(potContent).toContain('msgid "Shadow"');
        expect(potContent).toContain('msgid "Corners"');
    });

    it('zh_CN.po contains complete Simplified Chinese translations', () => {
        const poFile = GLib.build_filenamev([poDir, 'zh_CN.po']);
        expect(fileExists(poFile)).toBeTrue();

        const poContent = readFile(poFile);
        expect(poContent).toContain('优先保证文字清晰');
        expect(poContent).toContain('屏蔽规则');
        expect(poContent).toContain('强制规则');
        expect(poContent).toContain('屏蔽窗口…');
        expect(poContent).toContain('强制窗口…');
        expect(poContent).toContain('阴影');
        expect(poContent).toContain('圆角');
        expect(poContent).toContain('暂无屏蔽规则');
        expect(poContent).toContain('暂无强制规则');
    });

    it('zh_TW.po contains complete Traditional Chinese translations', () => {
        const poFile = GLib.build_filenamev([poDir, 'zh_TW.po']);
        expect(fileExists(poFile)).toBeTrue();

        const poContent = readFile(poFile);
        expect(poContent).toContain('屏蔽規則');
        expect(poContent).toContain('強制規則');
        expect(poContent).toContain('屏蔽視窗…');
        expect(poContent).toContain('強制視窗…');
        expect(poContent).toContain('陰影');
        expect(poContent).toContain('圓角');
        expect(poContent).toContain('尚無屏蔽規則');
        expect(poContent).toContain('尚無強制規則');
    });

    it('compiled .mo binary catalogs are valid and non-empty', () => {
        const zhCnMo = GLib.build_filenamev([srcLocaleDir, 'zh_CN', 'LC_MESSAGES', 'csd-fixer.mo']);
        const zhTwMo = GLib.build_filenamev([srcLocaleDir, 'zh_TW', 'LC_MESSAGES', 'csd-fixer.mo']);

        expect(fileExists(zhCnMo)).toBeTrue();
        expect(getFileSize(zhCnMo)).toBeGreaterThan(100);

        expect(fileExists(zhTwMo)).toBeTrue();
        expect(getFileSize(zhTwMo)).toBeGreaterThan(100);
    });
});
