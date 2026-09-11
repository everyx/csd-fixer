import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {WindowType} from './lib/mutterRules.generated.js';
import {
    RuleAxis,
    RuleDirection,
    RULE_AXIS_ORDER,
    buildRuleValue,
    parseRuleAxes,
    parseRuleKey,
    lookupRuleKey,
    withRule,
} from './lib/rules.js';
import {
    INSPECTOR_DBUS_NAME,
    INSPECTOR_DBUS_PATH,
    buildRuleKeyFromProperties,
} from './lib/pick.js';
import {
    getWindowRules,
    setWindowRules,
} from './lib/settings.js';

/** Decorations a single rule can name, in display order. */
const AXES = RULE_AXIS_ORDER;

function axisLabel(axis) {
    return axis === RuleAxis.SHADOW ? _('Shadow') : _('Corners');
}

function describeAxes(axes) {
    return AXES.filter(axis => axes.has(axis)).map(axisLabel).join(' · ');
}

// The nouns are thunks because this table is built while the module loads, before
// the prefs process has bound the gettext domain - a plain _() here would capture
// the untranslated string.
const WINDOW_TYPE_NOUNS = new Map([
    [WindowType.DIALOG, () => _('dialog')],
    [WindowType.MODAL_DIALOG, () => _('modal dialog')],
    [WindowType.UTILITY, () => _('utility window')],
]);

function windowTypeNoun(windowType) {
    return (WINDOW_TYPE_NOUNS.get(windowType) ?? (() => _('window')))();
}

/**
 * Describes what windows a rule matches, as a sentence.
 *
 * A rule is an exact conjunction of the five structural attributes, so all of
 * them have to be named: naming only the unusual ones would hide part of what
 * the rule matches. The two parent-related attributes fold into one phrase,
 * because an attached dialog always has a parent and so they cannot vary
 * independently.
 */
function windowKindSentence(properties) {
    if (!properties)
        return '';

    const size = properties.allows_resize === false ? _('Fixed-size') : _('Resizable');
    const server = properties.client_type === 'x11' ? _('X11') : _('Wayland');

    let parent;
    if (!properties.has_parent)
        parent = _('with no parent');
    else if (properties.attached_dialog)
        parent = _('attached to its parent');
    else
        parent = _('with a parent');

    // The template is the translatable unit, so a language can reorder the
    // sentence; each fragment above is translated on its own.
    return _('{size} {server} {type}, {parent}')
        .replace('{size}', size)
        .replace('{server}', server)
        .replace('{type}', windowTypeNoun(properties.window_type))
        .replace('{parent}', parent);
}

function otherDirection(direction) {
    return direction === RuleDirection.FORCE ? RuleDirection.SUPPRESS : RuleDirection.FORCE;
}

/**
 * Adw group and row labels are parsed as Pango markup, and both translated text
 * and application names can contain '&' or '<'. Escape them so they stay literal;
 * Adw.Toast and Adw.AlertDialog take plain text and must not be escaped. A bare
 * Gtk.Label defaults to use-markup=FALSE, so it takes raw text as well.
 */
function asMarkup(text) {
    return GLib.markup_escape_text(String(text), -1);
}

/** 'org.gnome.Nautilus.desktop' -> 'org.gnome.Nautilus' */
function stripDesktopSuffix(id) {
    return id.endsWith('.desktop') ? id.slice(0, -8) : id;
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
            wmClass = stripDesktopSuffix(id);
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
        (a.id.endsWith('.desktop') && stripDesktopSuffix(a.id).toLowerCase() === lower) ||
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
            title: asMarkup(_('Display & Rendering')),
            description: asMarkup(_('Control window decoration behavior across screen scales')),
        });
        page.add(renderGroup);

        const crispRow = new Adw.SwitchRow({
            title: asMarkup(_('Prioritize Crisp Text')),
            subtitle: asMarkup(_('Skip rounded corners on fractional scale monitors (retaining shadow) to avoid text blur and resampling overhead')),
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
                description: _('Turn a decoration on to suppress it for these windows.'),
                buttonTooltip: _('Leave a window undecorated'),
                emptyHint: _('Use the button above to leave a window undecorated.'),
            },
            {
                direction: RuleDirection.FORCE,
                title: _('Force Rules'),
                description: _('Turn a decoration on to force it for these windows.'),
                buttonTooltip: _('Decorate a window anyway'),
                emptyHint: _('Use the button above to decorate a window anyway.'),
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

            // A count saves opening a group just to see whether it holds anything.
            view.group.title = entries.length > 0
                ? `${asMarkup(view.meta.title)} <span size="small" alpha="55%">· ${entries.length}</span>`
                : asMarkup(view.meta.title);

            if (entries.length === 0) {
                const emptyRow = new Adw.ActionRow({
                    title: asMarkup(view.meta.emptyHint),
                    sensitive: false,
                });
                view.group.add(emptyRow);
                view.rows.push(emptyRow);
                return;
            }

            for (const [ruleKey, value] of entries) {
                const row = buildRuleRow(view, ruleKey, value);
                view.group.add(row);
                view.rows.push(row);
            }
        };

        const buildRuleRow = (view, ruleKey, value) => {
            const {baseWmClass, properties} = parseRuleKey(ruleKey);
            const appInfo = findAppInfoByWmClass(baseWmClass, installedApps);
            const name = appInfo?.name || baseWmClass || ruleKey;
            const activeAxes = parseRuleAxes(value) ?? new Set();

            const row = new Adw.ExpanderRow({
                title: asMarkup(name),
                subtitle: asMarkup(windowKindSentence(properties)),
                subtitle_lines: 2,
                tooltip_text: ruleKey,
            });

            row.add_prefix(appInfo?.icon
                ? new Gtk.Image({gicon: appInfo.icon, pixel_size: 32})
                : new Gtk.Image({icon_name: 'window-new-symbolic', pixel_size: 24}));

            // AdwExpanderRow.add_suffix() *prepends* (gtk_box_prepend in
            // adw-expander-row.c), so these two calls read in reverse of how the
            // widgets end up: delete first, summary second, giving
            // "[summary] [delete] [expand arrow]".
            const deleteButton = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                css_classes: ['flat', 'destructive-action'],
                valign: Gtk.Align.CENTER,
                margin_start: 6,
                tooltip_text: _('Remove Rule'),
            });
            deleteButton.connect('clicked', () => {
                writeRule(view.meta.direction, ruleKey, new Set());
                scheduleRenderAll();
            });
            row.add_suffix(deleteButton);

            // Which decorations the rule touches, next to the buttons.
            const summary = new Gtk.Label({
                label: describeAxes(activeAxes),
                css_classes: ['dim-label'],
                valign: Gtk.Align.CENTER,
                margin_start: 12,
            });
            row.add_suffix(summary);

            // One switch per decoration: a whole row is the hit target, and the
            // label is associated for free, which a bare switch beside a label
            // would not be.
            for (const axis of AXES) {
                const toggle = new Adw.SwitchRow({
                    title: asMarkup(axisLabel(axis)),
                    active: activeAxes.has(axis),
                });

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

                row.add_row(toggle);
            }

            return row;
        };

        const pickInto = meta => {
            const {direction} = meta;
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

                // An empty result is how the inspector reports a cancelled pick
                // (Escape, right-click) and one abandoned because the extension was
                // being disabled. Neither is a failure, so say nothing.
                if (!props || Object.keys(props).length === 0)
                    return;

                const ruleKey = buildRuleKeyFromProperties(props);

                if (!ruleKey) {
                    window.add_toast(new Adw.Toast({
                        title: _('No rule added: this window could not be identified.'),
                    }));
                    return;
                }

                // The extension judged this against the same evaluator that will
                // later apply the rule: if it changes nothing, say so instead of
                // adding a row that misrepresents what it does. Nothing needs
                // deciding here, so it is a toast and not a dialog - the outcome
                // is simply "no rule", and no acknowledgement is owed. An absent
                // answer means an extension too old to judge, and the rule goes
                // in.
                if (props[`${direction}Effect`] === 'false') {
                    window.add_toast(new Adw.Toast({
                        title: _('No rule added: it would have no effect on a window of this kind.'),
                    }));
                    return;
                }

                const rules = getWindowRules(settings);
                const otherGroup = otherDirection(direction);

                // The settings layer treats keys that differ only in case as the
                // same window kind, and so must this: the same app can report its
                // identity with a different case from one window to the next.
                const existing = lookupRuleKey(rules[otherGroup], ruleKey);
                const moved = Boolean(existing);

                // A kind lives in exactly one group: adding here removes it there.
                setWindowRules(settings, withRule(rules, direction, ruleKey, AXES));

                // Never claim success on a write the settings layer rejected.
                if (!lookupRuleKey(getWindowRules(settings)[direction], ruleKey)) {
                    window.add_toast(new Adw.Toast({
                        title: _('No rule added: the rule could not be saved.'),
                    }));
                    return;
                }

                renderAll();

                // The new row is visible straight away, so only a move needs
                // saying: that row just disappeared from the other group.
                if (moved)
                    window.add_toast(new Adw.Toast({title: _('Moved to %s').replace('%s', meta.title)}));
            });
        };

        for (const meta of groupMeta) {
            const pickButton = new Gtk.Button({
                icon_name: 'find-location-symbolic',
                tooltip_text: meta.buttonTooltip,
                valign: Gtk.Align.CENTER,
                margin_start: 18,
            });

            const group = new Adw.PreferencesGroup({
                title: asMarkup(meta.title),
                description: asMarkup(meta.description),
                header_suffix: pickButton,
            });
            page.add(group);

            const view = {meta, group, rows: []};
            views.push(view);

            pickButton.connect('clicked', () => pickInto(meta));
        }

        renderAll();
    }
}
