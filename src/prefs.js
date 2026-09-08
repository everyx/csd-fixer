import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {RuleMode} from './lib/detector.js';

function getRuleModes() {
    return [
        {
            id: RuleMode.DISABLE_ALL,
            label: _('Disable all (no shadow, no rounded corners)'),
            shortLabel: _('Disable all'),
        },
        {
            id: RuleMode.DISABLE_CLIP,
            label: _('Shadow only (disable rounded corners)'),
            shortLabel: _('Shadow only'),
        },
        {
            id: RuleMode.DISABLE_SHADOW,
            label: _('Rounded corners only (disable shadow)'),
            shortLabel: _('Corners only'),
        },
    ];
}

/**
 * 枚举系统已安装的桌面应用程序信息
 */
function getInstalledApps() {
    const apps = Gio.AppInfo.get_all();
    const result = [];
    for (const app of apps) {
        if (!app.should_show())
            continue;

        const name = app.get_name() || '';
        const id = app.get_id() || '';
        const startupWmClass = app.get_startup_wm_class ? app.get_startup_wm_class() : null;
        const executable = app.get_executable ? app.get_executable() : null;
        const icon = app.get_icon();

        let wmClass = startupWmClass;
        if (!wmClass && id)
            wmClass = id.endsWith('.desktop') ? id.slice(0, -8) : id;
        if (!wmClass && executable)
            wmClass = executable.split('/').pop();

        result.push({
            app,
            name,
            id,
            wmClass: wmClass || id,
            icon,
        });
    }
    result.sort((a, b) => a.name.localeCompare(b.name));
    return result;
}

/**
 * 根据 wmClass 反查已安装应用元数据
 */
function findAppInfoByWmClass(wmClass, appsList) {
    if (!wmClass)
        return null;
    const lower = wmClass.toLowerCase();
    return appsList.find(a =>
        a.wmClass.toLowerCase() === lower ||
        a.id.toLowerCase() === lower ||
        (a.id.endsWith('.desktop') && a.id.slice(0, -8).toLowerCase() === lower) ||
        (a.app.get_startup_wm_class && a.app.get_startup_wm_class()?.toLowerCase() === lower)
    ) || null;
}

/**
 * 读取 GSettings 中的 window-rules 字典
 */
function getWindowRules(settings) {
    try {
        const v = settings.get_value('window-rules');
        return v ? v.deep_unpack() : {};
    } catch {
        return {};
    }
}

/**
 * 保存 window-rules 字典到 GSettings
 */
function setWindowRules(settings, rules) {
    const variant = new GLib.Variant('a{ss}', rules);
    settings.set_value('window-rules', variant);
}

/**
 * 弹出添加排除规则对话框
 */
function showAddRuleDialog(parentWindow, settings, installedApps, onRuleAdded) {
    const dialog = new Adw.Window({
        title: _('Add Application Exclusion Rule'),
        modal: true,
        transient_for: parentWindow,
        default_width: 460,
        default_height: 560,
    });

    const toolbarView = new Adw.ToolbarView();
    dialog.set_content(toolbarView);

    const headerBar = new Adw.HeaderBar({
        show_end_title_buttons: true,
    });
    toolbarView.add_top_bar(headerBar);

    const mainBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        margin_top: 12,
        margin_bottom: 12,
        margin_start: 12,
        margin_end: 12,
    });
    toolbarView.set_content(mainBox);

    // 1. 搜索框
    const searchEntry = new Gtk.SearchEntry({
        placeholder_text: _('Search installed applications…'),
    });
    mainBox.append(searchEntry);

    // 2. 应用选择列表（带滚动）
    const scrolled = new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
        min_content_height: 200,
        vexpand: true,
    });
    const listBox = new Gtk.ListBox({
        selection_mode: Gtk.SelectionMode.SINGLE,
        css_classes: ['boxed-list'],
    });
    scrolled.set_child(listBox);
    mainBox.append(scrolled);

    // 填充应用项
    for (const app of installedApps) {
        const row = new Adw.ActionRow({
            title: app.name,
            subtitle: app.wmClass,
            activatable: true,
        });
        if (app.icon) {
            const img = new Gtk.Image({
                gicon: app.icon,
                pixel_size: 32,
            });
            row.add_prefix(img);
        } else {
            const img = new Gtk.Image({
                icon_name: 'application-x-executable-symbolic',
                pixel_size: 24,
            });
            row.add_prefix(img);
        }
        row._appData = app;
        listBox.append(row);
    }

    // 搜索过滤逻辑
    listBox.set_filter_func(row => {
        const query = searchEntry.text.trim().toLowerCase();
        if (!query)
            return true;
        const app = row._appData;
        if (!app)
            return true;
        return (
            app.name.toLowerCase().includes(query) ||
            app.wmClass.toLowerCase().includes(query) ||
            app.id.toLowerCase().includes(query)
        );
    });
    searchEntry.connect('search-changed', () => listBox.invalidate_filter());

    // 3. 配置项表单
    const formGroup = new Adw.PreferencesGroup({
        title: _('Rule Parameters'),
    });
    mainBox.append(formGroup);

    const entryRow = new Adw.EntryRow({
        title: _('Window Identifier (wm_class)'),
        show_apply_button: false,
    });
    formGroup.add(entryRow);

    // 点击列表行自动填入 wmClass
    listBox.connect('row-activated', (_box, row) => {
        if (row._appData?.wmClass)
            entryRow.text = row._appData.wmClass;
    });

    const ruleModes = getRuleModes();
    const modeList = Gtk.StringList.new(ruleModes.map(m => m.label));
    const modeRow = new Adw.ComboRow({
        title: _('Exclusion Behavior'),
        model: modeList,
        selected: 0,
    });
    formGroup.add(modeRow);

    // 4. 添加按钮
    const addButton = new Gtk.Button({
        label: _('Add Rule'),
        css_classes: ['suggested-action', 'pill'],
        margin_top: 6,
    });
    addButton.connect('clicked', () => {
        const wmClass = entryRow.text.trim();
        if (!wmClass)
            return;

        const selectedIndex = modeRow.selected;
        const selectedMode = ruleModes[selectedIndex]?.id || RuleMode.DISABLE_ALL;

        const currentRules = getWindowRules(settings);
        currentRules[wmClass] = selectedMode;
        setWindowRules(settings, currentRules);

        onRuleAdded();
        dialog.close();
    });
    mainBox.append(addButton);

    dialog.present();
}

export default class CsdFixerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const installedApps = getInstalledApps();

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        // 分组 1：显示与渲染
        const renderGroup = new Adw.PreferencesGroup({
            title: _('Display & Rendering'),
            description: _('Control window decoration behavior across screen scales'),
        });
        page.add(renderGroup);

        const crispRow = new Adw.SwitchRow({
            title: _('Prioritize Crisp Text'),
            subtitle: _('Skip rounded corners on fractional scale monitors (retaining shadow) to avoid text blur and resampling overhead'),
        });
        settings.bind('prefer-crisp-text', crispRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        renderGroup.add(crispRow);

        // 分组 2：应用排除规则（黑名单与细粒度控制）
        const addRuleButton = new Gtk.Button({
            label: _('Add Rule…'),
            icon_name: 'list-add-symbolic',
            css_classes: ['flat'],
        });

        const rulesGroup = new Adw.PreferencesGroup({
            title: _('Application Exclusion Rules'),
            description: _('Configure individual exclusions for specific windows (disable all, skip corners, or skip shadow)'),
            header_suffix: addRuleButton,
        });
        page.add(rulesGroup);

        const refreshRulesList = () => {
            // 清理已有的动态行（保留 group 本身）
            if (rulesGroup._ruleRows) {
                for (const row of rulesGroup._ruleRows)
                    rulesGroup.remove(row);
            }
            rulesGroup._ruleRows = [];

            const rules = getWindowRules(settings);
            const entries = Object.entries(rules);

            if (entries.length === 0) {
                const emptyRow = new Adw.ActionRow({
                    title: _('No Special Rules'),
                    subtitle: _('All normal windows without server-side decorations will have native shadow and rounded corners applied by default'),
                    sensitive: false,
                });
                rulesGroup.add(emptyRow);
                rulesGroup._ruleRows.push(emptyRow);
                return;
            }

            for (const [wmClass, mode] of entries) {
                const appInfo = findAppInfoByWmClass(wmClass, installedApps);
                const title = appInfo ? appInfo.name : wmClass;
                const subtitle = appInfo ? `${wmClass}` : _('Custom Identifier');

                const row = new Adw.ActionRow({
                    title,
                    subtitle,
                });

                // 图标
                if (appInfo?.icon) {
                    row.add_prefix(new Gtk.Image({
                        gicon: appInfo.icon,
                        pixel_size: 32,
                    }));
                } else {
                    row.add_prefix(new Gtk.Image({
                        icon_name: 'window-new-symbolic',
                        pixel_size: 24,
                    }));
                }

                // 下拉选择模式
                const ruleModes = getRuleModes();
                const shortLabels = ruleModes.map(m => m.shortLabel);
                const modeModel = Gtk.StringList.new(shortLabels);
                let initialIndex = ruleModes.findIndex(m => m.id === mode);
                if (initialIndex < 0)
                    initialIndex = 0;

                const dropDown = new Gtk.DropDown({
                    model: modeModel,
                    selected: initialIndex,
                    valign: Gtk.Align.CENTER,
                });
                dropDown.connect('notify::selected', () => {
                    const newMode = ruleModes[dropDown.selected]?.id || RuleMode.DISABLE_ALL;
                    const updated = getWindowRules(settings);
                    updated[wmClass] = newMode;
                    setWindowRules(settings, updated);
                });
                row.add_suffix(dropDown);

                // 删除按钮
                const deleteButton = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    css_classes: ['flat', 'destructive-action'],
                    valign: Gtk.Align.CENTER,
                    tooltip_text: _('Remove Rule'),
                });
                deleteButton.connect('clicked', () => {
                    const updated = getWindowRules(settings);
                    delete updated[wmClass];
                    setWindowRules(settings, updated);
                    refreshRulesList();
                });
                row.add_suffix(deleteButton);

                rulesGroup.add(row);
                rulesGroup._ruleRows.push(row);
            }
        };

        addRuleButton.connect('clicked', () => {
            showAddRuleDialog(window, settings, installedApps, refreshRulesList);
        });

        // 初始渲染规则列表
        refreshRulesList();
    }
}

