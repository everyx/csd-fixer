/**
 * The picker's contract, shared by the two processes that use it.
 *
 * The extension serves it (inspector.js) and the prefs window calls it, so both
 * the D-Bus coordinates and the shape of the returned dictionary live here - in a
 * module the prefs process can import without pulling in shell-only code.
 *
 * Pure logic module: no shell globals, unit-testable.
 */

import {WindowType} from './mutterRules.generated.js';

import {
    CLIENT_TYPE_TOKEN_WAYLAND,
    CLIENT_TYPE_TOKEN_X11,
    buildRuleKey,
    boolString,
} from './rules.js';

/**
 * MetaWindowClientType (vendor/mutter/window.h). Values are stable across the
 * typelib (`Meta.WindowClientType`); defined here so the pure modules can classify
 * client types without importing Shell/Meta.
 */
export const WindowClientType = Object.freeze({
    WAYLAND: 0,
    X11: 1,
});
/**
 * D-Bus communication coordinates for the Window Inspector service.
 * Shared between the Shell extension process (InspectorService) and the
 * Preferences process (prefs.js). Kept in this pure JS module because prefs.js
 * runs in a separate Gtk process and cannot import inspector.js (which requires
 * Shell-only resource:///org/gnome/shell/ui/main.js).
 */
export const INSPECTOR_DBUS_NAME = 'org.gnome.Shell.Extensions.CsdFixer';
export const INSPECTOR_DBUS_PATH = '/org/gnome/Shell/Extensions/CsdFixer';
/**
 * Extracts the normalized inspection properties dictionary for the picker.
 * Values are strings because the dictionary crosses D-Bus as `a{ss}`; prefs.js
 * parses them back and feeds buildRuleKey(), which must yield exactly the key
 * the runtime matcher derives from Meta.Window state.
 *
 * Pure function: no Shell dependencies, unit-testable.
 *
 * @param {object} win - Window instance
 * @param {string|null} [wmClassOverride=null] - Pre-resolved app id; Shell-side fallback for windows without WM_CLASS
 * @returns {Record<string, string>}
 */
export function extractWindowProperties(win, wmClassOverride = null) {
    if (!win)
        return {};

    const wmClass = wmClassOverride ?? win.get_wm_class?.() ?? win.get_sandboxed_app_id?.() ?? '';
    const windowType = win.get_window_type?.() ?? WindowType.NORMAL;
    const isX11 = win.get_client_type?.() === WindowClientType.X11;

    return {
        wmClass,
        'clientType': isX11 ? CLIENT_TYPE_TOKEN_X11 : CLIENT_TYPE_TOKEN_WAYLAND,
        'windowType': String(windowType),
        'hasParent': boolString(win.get_transient_for?.()),
        'allowsResize': boolString(win.allows_resize?.()),
        'isAttachedDialog': boolString(win.is_attached_dialog?.()),
    };
}
/**
 * The rule key a window's property map produces (see extractWindowProperties).
 *
 * The picker and the runtime both key a window through here, so the key the
 * prefs window writes for a picked window is the key the runtime later looks up.
 *
 * @param {Record<string, string>} [properties={}]
 * @returns {string} Canonical rule key, or '' when the window has no identity
 */
export function buildRuleKeyFromProperties(properties = {}) {
    return buildRuleKey(properties.wmClass, {
        clientType: properties.clientType,
        windowType: Number(properties.windowType ?? WindowType.NORMAL),
        hasParent: properties.hasParent === 'true',
        allowsResize: properties.allowsResize === 'true',
        isAttachedDialog: properties.isAttachedDialog === 'true',
    });
}
