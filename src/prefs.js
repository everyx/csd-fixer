import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {
    RuleAxis,
    RuleDirection,
    buildRuleKey,
    buildRuleValue,
    parseRuleAxes,
    parseRuleKey,
    INSPECTOR_DBUS_NAME,
    INSPECTOR_DBUS_PATH,
} from './lib/detector.js';
import {
    getWindowRules,
    setWindowRules,
} from './lib/settings.js';

/** Decorations a single rule can name, in display order. */
const AXES = [RuleAxis.SHADOW, RuleAxis.CORNERS];

/** A freshly picked window starts by targeting both decorations. */
const PICK_DEFAULT_AXES = [RuleAxis.SHADOW, RuleAxis.CORNERS];

function axisLabel(axis) {
    return axis === RuleAxis.SHADOW ? _('Shadow') : _('Corners');
}

function describeAxes(axes) {
    return AXES.filter(axis => axes.has(axis)).map(axisLabel).join(' · ');
}

function otherDirection(direction) {
    return direction === RuleDirection.FORCE ? RuleDirection.SUPPRESS : RuleDirection.FORCE;
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

        // Picking hides the preferences window; the user can still close it while
        // the (deliberately modal) picker is up, in which case the D-Bus reply
        // arrives for a dead window. Everything touching the UI checks this.
        let windowAlive = true;
        window.connect('destroy', () => {
            windowAlive = false;
        });

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

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

        // Two independent rule groups. Suppression removes a decoration; forcing
        // adds one the automatic detection assumed was already drawn. A window
        // kind belongs to at most one group, which is also what the settings
        // layer enforces when it sanitizes the stored dictionaries.
        const groupMeta = [
            {
                direction: RuleDirection.SUPPRESS,
                title: _('Suppress Rules'),
                description: _('Windows CSD Fixer leaves alone. A switch turned on means that decoration is not drawn.'),
                buttonLabel: _('Suppress Window…'),
                buttonIcon: 'action-unavailable-symbolic',
                buttonTooltip: _('Click an on-screen window to stop decorating it'),
                emptyLabel: _('No Suppress Rules'),
            },
            {
                direction: RuleDirection.FORCE,
                title: _('Force Rules'),
                description: _('Windows CSD Fixer decorates even when detection assumes Mutter or the application already drew something. A switch turned on means that decoration is forced on.'),
                buttonLabel: _('Force Window…'),
                buttonIcon: 'starred-symbolic',
                buttonTooltip: _('Click an on-screen window to decorate it despite detection'),
                emptyLabel: _('No Force Rules'),
            },
        ];

        const views = [];
        const renderAll = () => {
            for (const view of views)
                renderGroupView(view);
        };

        // Rows are torn down from inside their own widgets' signal handlers, so
        // defer the rebuild to idle time rather than destroying the emitter.
        const scheduleRenderAll = () => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (windowAlive)
                    renderAll();
                return GLib.SOURCE_REMOVE;
            });
        };

        const writeRule = (direction, ruleKey, axes) => {
            const rules = getWindowRules(settings);
            if (axes.size === 0)
                delete rules[direction][ruleKey];
            else
                rules[direction][ruleKey] = buildRuleValue(axes);
            setWindowRules(settings, rules);
        };

        const renderGroupView = view => {
            for (const row of view.rows)
                view.group.remove(row);
            view.rows = [];

            const rules = getWindowRules(settings)[view.meta.direction];
            const entries = Object.entries(rules);

            if (entries.length === 0) {
                const emptyRow = new Adw.ActionRow({
                    title: view.meta.emptyLabel,
                    sensitive: false,
                });
                view.group.add(emptyRow);
                view.rows.push(emptyRow);
                return;
            }

            for (const [ruleKey, value] of entries)
                view.rows.push(buildRuleRow(view, ruleKey, value));
        };

        const buildRuleRow = (view, ruleKey, value) => {
            const {baseWmClass} = parseRuleKey(ruleKey);
            const appInfo = findAppInfoByWmClass(baseWmClass, installedApps);
            const activeAxes = parseRuleAxes(value) ?? new Set();

            const row = new Adw.ExpanderRow({
                title: appInfo?.name || baseWmClass || ruleKey,
                subtitle: ruleKey,
            });

            row.add_prefix(appInfo?.icon
                ? new Gtk.Image({gicon: appInfo.icon, pixel_size: 32})
                : new Gtk.Image({icon_name: 'window-new-symbolic', pixel_size: 24}));

            // Collapsed summary, so the row still says what it does before expanding.
            const summary = new Gtk.Label({
                label: describeAxes(activeAxes),
                css_classes: ['dim-label'],
                valign: Gtk.Align.CENTER,
            });
            row.add_suffix(summary);

            const deleteButton = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                css_classes: ['flat', 'destructive-action'],
                valign: Gtk.Align.CENTER,
                tooltip_text: _('Remove Rule'),
            });
            deleteButton.connect('clicked', () => {
                writeRule(view.meta.direction, ruleKey, new Set());
                scheduleRenderAll();
            });
            row.add_suffix(deleteButton);

            for (const axis of AXES) {
                const toggle = new Gtk.Switch({
                    active: activeAxes.has(axis),
                    valign: Gtk.Align.CENTER,
                });
                const switchRow = new Adw.ActionRow({title: axisLabel(axis)});
                switchRow.add_suffix(toggle);
                switchRow.activatable_widget = toggle;

                toggle.connect('notify::active', () => {
                    const axes = parseRuleAxes(
                        getWindowRules(settings)[view.meta.direction][ruleKey]
                    ) ?? new Set();

                    if (toggle.active)
                        axes.add(axis);
                    else
                        axes.delete(axis);

                    writeRule(view.meta.direction, ruleKey, axes);

                    if (axes.size === 0)
                        scheduleRenderAll();  // the rule is gone, so its row must go too
                    else
                        summary.label = describeAxes(axes);
                });

                row.add_row(switchRow);
            }

            return row;
        };

        const pickInto = direction => {
            window.set_visible(false);
            inspectWindow((err, props) => {
                if (!windowAlive)
                    return;

                window.set_visible(true);
                window.present();

                if (err) {
                    showError(window,
                        _('Window Inspection Failed'),
                        _('Could not connect to CSD Fixer extension. Please ensure the extension is enabled.'));
                    return;
                }

                const ruleKey = props?.wmClass
                    ? buildRuleKey(props.wmClass, {
                        clientType: props.clientType,
                        windowType: Number(props.windowType),
                        hasParent: props.hasParent === 'true',
                        allowsResize: props.allowsResize === 'true',
                        isAttachedDialog: props.isAttachedDialog === 'true',
                    })
                    : '';

                if (!ruleKey) {
                    showError(window,
                        _('Window Not Recognized'),
                        _('CSD Fixer could not identify this window, so no rule was created.'));
                    return;
                }

                const rules = getWindowRules(settings);
                // A kind lives in exactly one group: adding here removes it there.
                delete rules[otherDirection(direction)][ruleKey];
                rules[direction][ruleKey] = buildRuleValue(PICK_DEFAULT_AXES);
                setWindowRules(settings, rules);

                // Never claim success on a write the settings layer rejected.
                if (!Object.prototype.hasOwnProperty.call(getWindowRules(settings)[direction], ruleKey)) {
                    showError(window,
                        _('Rule Not Saved'),
                        _('CSD Fixer could not store a rule for this window.'));
                    return;
                }

                renderAll();
                window.add_toast(new Adw.Toast({
                    title: _('Added rule for "%s"').replace('%s', ruleKey),
                }));
            });
        };

        for (const meta of groupMeta) {
            const pickButton = new Gtk.Button({
                label: meta.buttonLabel,
                icon_name: meta.buttonIcon,
                tooltip_text: meta.buttonTooltip,
            });

            const group = new Adw.PreferencesGroup({
                title: meta.title,
                description: meta.description,
                header_suffix: pickButton,
            });
            page.add(group);

            const view = {meta, group, rows: []};
            views.push(view);

            pickButton.connect('clicked', () => pickInto(meta.direction));
        }

        renderAll();
    }
}
