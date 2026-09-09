import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {
    ExclusionTarget,
    parseRuleKey,
    sanitizeWindowRules,
    INSPECTOR_DBUS_NAME,
    INSPECTOR_DBUS_PATH,
} from './lib/detector.js';

function getRuleModes() {
    return [
        {id: ExclusionTarget.ALL, label: _('Disable all')},
        {id: ExclusionTarget.CLIP, label: _('Disable corners')},
        {id: ExclusionTarget.SHADOW, label: _('Disable shadow')},
    ];
}

/**
 * Enumerate installed desktop application metadata
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
    return result;
}

/**
 * Look up installed application metadata by wmClass
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
 * Read window-rules dictionary from GSettings
 */
function getWindowRules(settings) {
    try {
        const v = settings.get_value('window-rules');
        const raw = v ? v.deep_unpack() : {};
        return sanitizeWindowRules(raw);
    } catch {
        return {};
    }
}

/**
 * Save window-rules dictionary to GSettings
 */
function setWindowRules(settings, rules) {
    const variant = new GLib.Variant('a{ss}', rules);
    settings.set_value('window-rules', variant);
}

/**
 * D-Bus inspection helper to pick a window
 */
function inspectWindow(callback) {
    Gio.DBus.session.call(
        INSPECTOR_DBUS_NAME,
        INSPECTOR_DBUS_PATH,
        INSPECTOR_DBUS_NAME,
        'PickWindow',
        null,
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        (conn, res) => {
            try {
                const reply = conn.call_finish(res);
                const [props] = reply.deep_unpack();
                callback(null, props);
            } catch (e) {
                callback(e, null);
            }
        }
    );
}

function showError(parentWindow, heading, body) {
    if (Adw.AlertDialog) {
        const dialog = new Adw.AlertDialog({
            heading,
            body,
        });
        dialog.add_response('ok', _('OK'));
        dialog.present(parentWindow);
    } else {
        const dialog = new Adw.MessageDialog({
            heading,
            body,
            transient_for: parentWindow,
        });
        dialog.add_response('ok', _('OK'));
        dialog.present();
    }
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

        // Group 1: Display & rendering
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

        // Group 2: Application exclusion rules
        const inspectButton = new Gtk.Button({
            label: _('Inspect Window…'),
            icon_name: 'find-location-symbolic',
            tooltip_text: _('Click an on-screen window to automatically detect and add exclusion rule'),
        });

        const rulesGroup = new Adw.PreferencesGroup({
            title: _('Application Exclusion Rules'),
            description: _('Configure individual exclusions for specific windows (disable all, skip corners, or skip shadow)'),
            header_suffix: inspectButton,
        });
        page.add(rulesGroup);

        const refreshRulesList = () => {
            // Clear existing dynamic rows (keep group itself)
            if (rulesGroup._ruleRows) {
                for (const row of rulesGroup._ruleRows)
                    rulesGroup.remove(row);
            }
            rulesGroup._ruleRows = [];

            const rules = getWindowRules(settings);
            const entries = Object.entries(rules);
            const ruleModes = getRuleModes();
            const modeLabels = ruleModes.map(m => m.label);

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

            for (const [ruleKey, mode] of entries) {
                const {baseWmClass, specifier} = parseRuleKey(ruleKey);
                const appInfo = findAppInfoByWmClass(baseWmClass, installedApps);

                let title = appInfo ? appInfo.name : baseWmClass;
                let subtitle = appInfo ? `${ruleKey}` : _('Custom Identifier');

                if (specifier === 'dialog') {
                    title = appInfo
                        ? `${appInfo.name} (${_('Dialogs & Popups')})`
                        : `${baseWmClass} (${_('Dialogs & Popups')})`;
                    subtitle = `[${ruleKey}] · ${_('Child dialogs and transient windows')}`;
                } else if (specifier?.startsWith('title=')) {
                    const t = specifier.slice(6);
                    title = `${appInfo ? appInfo.name : baseWmClass} ("${t}")`;
                    subtitle = `[${ruleKey}] · ${_('Specific window title')}`;
                }

                const row = new Adw.ActionRow({
                    title,
                    subtitle,
                });

                // Icon
                if (appInfo?.icon) {
                    row.add_prefix(new Gtk.Image({
                        gicon: appInfo.icon,
                        pixel_size: 32,
                    }));
                } else {
                    row.add_prefix(new Gtk.Image({
                        icon_name: specifier === 'dialog' ? 'window-duplicate-symbolic' : 'window-new-symbolic',
                        pixel_size: 24,
                    }));
                }

                // Mode dropdown
                const modeModel = Gtk.StringList.new(modeLabels);
                let initialIndex = ruleModes.findIndex(m => m.id === mode);
                if (initialIndex < 0)
                    initialIndex = 0;

                const dropDown = new Gtk.DropDown({
                    model: modeModel,
                    selected: initialIndex,
                    valign: Gtk.Align.CENTER,
                });
                dropDown.connect('notify::selected', () => {
                    const newMode = ruleModes[dropDown.selected]?.id || ExclusionTarget.ALL;
                    const updated = getWindowRules(settings);
                    updated[ruleKey] = newMode;
                    setWindowRules(settings, updated);
                });
                row.add_suffix(dropDown);

                // Delete button
                const deleteButton = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    css_classes: ['flat', 'destructive-action'],
                    valign: Gtk.Align.CENTER,
                    tooltip_text: _('Remove Rule'),
                });
                deleteButton.connect('clicked', () => {
                    const updated = getWindowRules(settings);
                    delete updated[ruleKey];
                    setWindowRules(settings, updated);
                    refreshRulesList();
                });
                row.add_suffix(deleteButton);

                rulesGroup.add(row);
                rulesGroup._ruleRows.push(row);
            }
        };

        inspectButton.connect('clicked', () => {
            window.set_visible(false);

            inspectWindow((err, props) => {
                window.set_visible(true);
                window.present();

                if (err) {
                    showError(
                        window,
                        _('Window Inspection Failed'),
                        _('Could not connect to CSD Fixer extension. Please ensure the extension is enabled.')
                    );
                    return;
                }

                if (!props || !props.wmClass)
                    return;

                const isDialog = props.isDialog === 'true';
                const ruleKey = isDialog ? `${props.wmClass}:dialog` : props.wmClass;

                const currentRules = getWindowRules(settings);
                if (currentRules[ruleKey]) {
                    window.add_toast(new Adw.Toast({
                        title: _('Rule for "%s" already exists').replace('%s', ruleKey),
                    }));
                    return;
                }

                currentRules[ruleKey] = ExclusionTarget.ALL;
                setWindowRules(settings, currentRules);

                refreshRulesList();

                window.add_toast(new Adw.Toast({
                    title: _('Added rule for "%s"').replace('%s', ruleKey),
                }));
            });
        });

        // Initial render of rule list
        refreshRulesList();
    }
}

