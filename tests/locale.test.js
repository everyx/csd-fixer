/**
 * 多语言 i18n 单元测试：
 * 验证 gettext 翻译文件（pot, po, mo）的完整性与 metadata 配置一致性。
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

describe('i18n 多语言支持', () => {
    const rootDir = GLib.get_current_dir();
    const poDir = GLib.build_filenamev([rootDir, 'po']);
    const srcLocaleDir = GLib.build_filenamev([rootDir, 'src', 'locale']);
    const metadataPath = GLib.build_filenamev([rootDir, 'src', 'metadata.json']);

    it('metadata.json 声明了正确的 gettext-domain', () => {
        const metadata = JSON.parse(readFile(metadataPath));
        expect(metadata['gettext-domain']).toBe('csd-fixer');
    });

    it('模板文件 csd-fixer.pot 包含核心首选项 UI 键', () => {
        const potFile = GLib.build_filenamev([poDir, 'csd-fixer.pot']);
        expect(fileExists(potFile)).toBeTrue();

        const potContent = readFile(potFile);
        expect(potContent).toContain('Prioritize Crisp Text');
        expect(potContent).toContain('Application Exclusion Rules');
        expect(potContent).toContain('Add Application Exclusion Rule');
        expect(potContent).toContain('Disable all (no shadow, no rounded corners)');
        expect(potContent).toContain('Shadow only (disable rounded corners)');
        expect(potContent).toContain('Rounded corners only (disable shadow)');
    });

    it('zh_CN.po 包含完整的简体中文翻译', () => {
        const poFile = GLib.build_filenamev([poDir, 'zh_CN.po']);
        expect(fileExists(poFile)).toBeTrue();

        const poContent = readFile(poFile);
        expect(poContent).toContain('优先保证文字清晰');
        expect(poContent).toContain('应用排除规则');
        expect(poContent).toContain('添加应用排除规则');
        expect(poContent).toContain('全部禁用（不加阴影，不裁圆角）');
        expect(poContent).toContain('仅阴影（禁用圆角裁切）');
        expect(poContent).toContain('仅圆角（禁用阴影添加）');
    });

    it('zh_TW.po 包含完整的繁体中文翻译', () => {
        const poFile = GLib.build_filenamev([poDir, 'zh_TW.po']);
        expect(fileExists(poFile)).toBeTrue();

        const poContent = readFile(poFile);
        expect(poContent).toContain('全部停用（不加陰影，不修圓角）');
        expect(poContent).toContain('僅陰影（停用圓角修邊）');
        expect(poContent).toContain('僅圓角（停用陰影效果）');
    });

    it('编译生成的 .mo 二进制语言包有效且非空', () => {
        const zhCnMo = GLib.build_filenamev([srcLocaleDir, 'zh_CN', 'LC_MESSAGES', 'csd-fixer.mo']);
        const zhTwMo = GLib.build_filenamev([srcLocaleDir, 'zh_TW', 'LC_MESSAGES', 'csd-fixer.mo']);

        expect(fileExists(zhCnMo)).toBeTrue();
        expect(getFileSize(zhCnMo)).toBeGreaterThan(100);

        expect(fileExists(zhTwMo)).toBeTrue();
        expect(getFileSize(zhTwMo)).toBeGreaterThan(100);
    });
});
