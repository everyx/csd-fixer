import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class CsdFixerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('常规'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        // 分组 1：显示与渲染
        const renderGroup = new Adw.PreferencesGroup({
            title: _('显示与渲染'),
            description: _('控制窗口装饰在不同屏幕缩放下的渲染行为'),
        });
        page.add(renderGroup);

        const crispRow = new Adw.SwitchRow({
            title: _('优先保证文字清晰'),
            subtitle: _('在分数缩放屏幕上免除圆角（保留阴影），消除离线贴图重采样带来的字体模糊与性能损耗'),
        });
        settings.bind('prefer-crisp-text', crispRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        renderGroup.add(crispRow);

        // 分组 2：兼容性与调试
        const compatGroup = new Adw.PreferencesGroup({
            title: _('兼容性与调试'),
            description: _('针对特定协议或排查问题的设置'),
        });
        page.add(compatGroup);

        const xwaylandRow = new Adw.SwitchRow({
            title: _('强制跳过 XWayland 窗口'),
            subtitle: _('跳过所有 X11/XWayland 窗口（默认关闭，由扩展基于阴影状态智能判定）'),
        });
        settings.bind('skip-xwayland', xwaylandRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        compatGroup.add(xwaylandRow);

        const debugRow = new Adw.SwitchRow({
            title: _('调试日志'),
            subtitle: _('在系统日志（journalctl）中输出窗口判定与装饰状态日志'),
        });
        settings.bind('debug', debugRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        compatGroup.add(debugRow);

        // 分组 3：窗口过滤（黑白名单）
        const filterGroup = new Adw.PreferencesGroup({
            title: _('窗口过滤'),
            description: _('按 wm_class 排除或限定装饰目标（多个以逗号分隔，点击对勾或回车保存）'),
        });
        page.add(filterGroup);

        const whitelistRow = new Adw.EntryRow({
            title: _('白名单（只处理列出的窗口）'),
            text: settings.get_strv('whitelist').join(', '),
            show_apply_button: true,
        });
        whitelistRow.connect('apply', () => {
            const list = whitelistRow.text.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
            settings.set_strv('whitelist', list);
        });
        filterGroup.add(whitelistRow);

        const blacklistRow = new Adw.EntryRow({
            title: _('黑名单（跳过不处理的窗口）'),
            text: settings.get_strv('blacklist').join(', '),
            show_apply_button: true,
        });
        blacklistRow.connect('apply', () => {
            const list = blacklistRow.text.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
            settings.set_strv('blacklist', list);
        });
        filterGroup.add(blacklistRow);
    }
}
