/**
 * Shell-side window helpers.
 *
 * Separated from detector.js because gathering identity candidates needs
 * Shell.WindowTracker and the live window list, neither of which exists in the
 * pure, unit-tested detector module nor in the Gtk preferences process. The
 * decision itself (which candidate wins) is pure and lives in detector.js.
 */

import Shell from 'gi://Shell';

import {chooseWindowIdentity} from './rules.js';

/**
 * Reads what a window declares about its own application identity, most
 * authoritative source first.
 *
 * @param {object} win - Meta.Window instance
 * @returns {string} '' when the window declares nothing usable
 */
function readDeclaredIdentity(win) {
    return win?.get_wm_class?.() ??
        win?.get_sandboxed_app_id?.() ??
        win?.get_gtk_application_id?.() ??
        '';
}

/** Every mapped window, used to find a sibling of the same process. */
function listWindows() {
    const actors = global.get_window_actors?.() ?? [];
    return actors.map(a => a.meta_window ?? a.metaWindow).filter(Boolean);
}

/**
 * Resolves a stable application identity for a window.
 *
 * Windows that declare nothing (notably some XWayland ones) are identified from
 * a sibling of the same process: a popup shares its parent application, so the
 * main window's WM_CLASS describes both. Resolving through siblings keeps the
 * identity stable across restarts without reading /proc or guessing toolkits.
 *
 * The picker and the runtime rule matcher must use this same resolver, otherwise
 * a rule created for a picked window could never match it at runtime.
 *
 * @param {object} win - Meta.Window instance
 * @returns {string} Identity, or '' when the window cannot be identified at all
 */
export function resolveWindowIdentity(win) {
    const declared = readDeclaredIdentity(win);
    if (declared)
        return declared;

    const pid = win?.get_pid?.() ?? -1;
    let peer = '';
    if (pid > 0) {
        for (const candidate of listWindows()) {
            if (candidate === win || candidate?.get_pid?.() !== pid)
                continue;
            peer = readDeclaredIdentity(candidate);
            if (peer)
                break;
        }
    }

    let tracked = '';
    try {
        tracked = Shell.WindowTracker.get_default()?.get_window_app(win)?.get_id?.() ?? '';
    } catch {
        // WindowTracker is unusable while the session is tearing down.
    }

    return chooseWindowIdentity({declared, peer, tracked, pid});
}
