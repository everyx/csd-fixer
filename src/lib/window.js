/**
 * Shell-side window helpers.
 *
 * Exists separately from detector.js because resolving a window's application
 * identity in the absence of WM_CLASS requires Shell.WindowTracker, which is
 * only available in the Shell process (not in the pure, unit-tested detector
 * module nor in the Gtk preferences process).
 */

import Shell from 'gi://Shell';

/**
 * Resolves a stable application identifier for a window.
 *
 * Prefers WM_CLASS / sandboxed app id; falls back to Shell.WindowTracker for
 * windows that expose neither (some XWayland windows have no WM_CLASS). The
 * picker and the runtime rule matcher must use the same resolver, otherwise a
 * rule created for a picked window could never match it at runtime.
 *
 * @param {object} win - Meta.Window instance
 * @returns {string} App identifier, or '' if none can be resolved
 */
export function getEffectiveWmClass(win) {
    const direct = win?.get_wm_class?.() ?? win?.get_sandboxed_app_id?.();
    if (direct)
        return direct;

    try {
        return Shell.WindowTracker.get_default()?.get_window_app(win)?.get_id() ?? '';
    } catch {
        return '';
    }
}
