/**
 * Manager - core extension state machine.
 *
 * Responsibilities:
 *   - Monitors window creation/destruction/state changes (idempotent: re-evaluates -> compares -> adds/removes effects)
 *   - Reads GSettings (corner radius, text clarity prioritization, window exclusion rules)
 *   - Attaches decoration effects to matching windows (effects/shadow modules)
 * Shell version compatibility matrix (45 → 50, verified via live GJS typelib and Mutter C source):
 *  - win.get_client_type()               : 45–50 stable method (returns Meta.WindowClientType).
 *  - win.decorated                       : 45–50 GObject property (boolean: whether window has frame/SSD).
 *  - win.is_client_decorated             : Non-existent on Meta.Window (GTK internal concept only).
 *  - global.display?.get_monitor_scale   : 45–50 display scale method, optional chaining for safety.
 *  - global.backend?.get_monitor_manager : 45–50 monitor manager, optional chaining for safety.
 *
 * Design constraints:
 *   - All window state evaluation delegates to detector.evaluateWindowActions (pure function, unit-testable)
 *   - enable/disable are idempotent; zero leftovers after disable (no signal leaks, no orphaned actors)
 */

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {evaluateWindowActions, isDialogWindow, sanitizeWindowRules} from './detector.js';
import {styleForWindow} from './style.js';
import {RoundedClipEffect} from '../effects/clipEffect.js';
import {SdfShadowEffect} from '../effects/shadowEffect.js';
import {ShadowActor, SHADOW_PAD} from '../effects/shadowActor.js';

export class Manager {
    /** @param {import('../extension.js').default} ext */
    constructor(ext) {
        this._ext = ext;
        this._settings = ext.getSettings();
        this._windows = new Map();  // Meta.Window -> decorations state
        this._signals = [];
    }

    enable() {
        // Display-level events (global)
        const wm = global.windowManager;
        this._connect(wm, 'switch-workspace', () => this._reconcile());
        this._connect(global.display, 'window-created', (_, win) => this._trackWindow(win));
        this._connect(global.display, 'grab-op-end', () => this._reconcile());
        // Window restacking (focus/raise/lower) -> shadow actor must be placed below window
        this._connect(global.display, 'restacked', () => this._restackShadows());
        // Focus change (active <-> backdrop shadow depth transition)
        this._connect(global.display, 'notify::focus-window', () => this._reconcileDebounced());

        // Monitor changes (scale changes, plugging/unplugging displays, etc.)
        const monitorManager = global.backend?.get_monitor_manager?.();
        if (monitorManager)
            this._connect(monitorManager, 'monitors-changed', () => this._reconcile());

        // GSettings changes -> full re-evaluation (only relevant core keys)
        this._settingsHandlerIds = [];
        for (const key of ['window-rules', 'prefer-crisp-text']) {
            const id = this._settings.connect(`changed::${key}`, () => this._reconcile());
            this._settingsHandlerIds.push(id);
        }

        // Pre-existing windows (extension enabled mid-session)
        for (const win of global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null))
            this._trackWindow(win);
        this._reconcile();
    }

    disable() {
        if (this._reconcileTimeout) {
            GLib.Source.remove(this._reconcileTimeout);
            this._reconcileTimeout = null;
        }
        for (const [win, state] of this._windows) {
            if (state.idleId) {
                GLib.Source.remove(state.idleId);
                state.idleId = null;
            }
            this._undecorate(win);
        }
        this._windows.clear();
        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        this._signals = [];
        this._settingsHandlerIds?.forEach(id => this._settings.disconnect(id));
        this._settingsHandlerIds = [];
    }

    // ---------- Internal ----------

    _connect(obj, signal, handler) {
        this._signals.push([obj, obj.connect(signal, handler)]);
    }

    _trackWindow(win) {
        if (this._windows.has(win))
            return;
        this._windows.set(win, {clip: null, shadow: null, shadowFx: null, idleId: null, signals: []});
        // Window-level signals (position/size/focus/monitor changes -> idempotent re-evaluation)
        const windowSignals = [
            'position-changed', 'size-changed', 'notify::appears-focused',
            'notify::maximized-horizontally', 'notify::maximized-vertically',
            'notify::fullscreen', 'notify::main-monitor', 'highest-scale-monitor-changed',
            'notify::title',
        ];
        for (const sig of windowSignals) {
            try {
                this._windows.get(win).signals.push([win, win.connect(sig, () => this._reconcileDebounced())]);
            } catch {
                // Silently ignore if Mutter version lacks certain signals
            }
        }
        this._windows.get(win).signals.push([win, win.connect('unmanaging', () => this._forgetWindow(win))]);
        // Actor allocation changes (initial frame size 0 -> ready re-evaluation + size tracking)
        const actor = win.get_compositor_private();
        if (actor) {
            this._windows.get(win).signals.push([actor, actor.connect('notify::allocation', () => {
                const state = this._windows.get(win);
                // First frame ready: defer to idle so we don't mutate actor hierarchy during allocation pass
                if (state && (!state.clip && !state.shadow) && actor.width > 0 && actor.height > 0) {
                    if (state.idleId)
                        GLib.Source.remove(state.idleId);
                    state.idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                        state.idleId = null;
                        this._reconcileWindow(win);
                        return GLib.SOURCE_REMOVE;
                    });
                } else {
                    this._reconcileDebounced();
                }
            })]);
        }
        if (actor && actor.width > 0 && actor.height > 0)
            this._reconcileWindow(win);
        else
            this._reconcileDebounced();
    }

    _forgetWindow(win) {
        const state = this._windows.get(win);
        if (state) {
            if (state.idleId) {
                GLib.Source.remove(state.idleId);
                state.idleId = null;
            }
            for (const [obj, id] of state.signals)
                obj.disconnect(id);
            // Retain clipEffect and shadowActor to fade naturally with windowActor on close
        }
        this._windows.delete(win);
    }

    _reconcileDebounced() {
        if (this._reconcileTimeout)
            return;
        this._reconcileTimeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 50, () => {
                this._reconcileTimeout = null;
                this._reconcile();
                return GLib.SOURCE_REMOVE;
            });
    }

    _getWindowRules() {
        try {
            const v = this._settings.get_value('window-rules');
            const raw = v ? v.deep_unpack() : {};
            return sanitizeWindowRules(raw);
        } catch {
            return {};
        }
    }

    /** Gets physical/logical scale factor for window's monitor (supports fractional scale 1.25, 1.333, etc.) */
    _getMonitorScale(win) {
        const monitor = win.get_monitor();
        if (monitor < 0)
            return 1;
        if (typeof global.display?.get_monitor_scale === 'function')
            return global.display.get_monitor_scale(monitor);
        return 1;
    }

    /** Dynamically synchronize window clipEffect */
    _syncClip(win, wantClip) {
        const state = this._windows.get(win);
        if (!state)
            return;
        const actor = win.get_compositor_private();
        if (!actor)
            return;

        const hasClip = Boolean(state.clip);
        if (wantClip !== hasClip) {
            if (wantClip) {
                state.clip = new RoundedClipEffect();
                actor.add_effect(state.clip);
            } else {
                actor.remove_effect(state.clip);
                state.clip = null;
            }
        }
    }

    /** Dynamically synchronize window shadowActor */
    _syncShadow(win, wantShadow) {
        const state = this._windows.get(win);
        if (!state)
            return;
        const actor = win.get_compositor_private();
        if (!actor)
            return;

        const hasShadow = Boolean(state.shadow);
        if (wantShadow !== hasShadow) {
            if (wantShadow) {
                state.shadowFx = new SdfShadowEffect();
                state.shadow = new ShadowActor(actor, this._windowGroup);
                state.shadow.actor.add_effect(state.shadowFx);
                state.shadow.onRelayout((w, h) => {
                    const style = this._styleOf(win);
                    this._applyStyle(win, style, w, h);
                });
                state.shadow.relayout();
            } else {
                state.shadow.destroy();
                state.shadow = null;
                state.shadowFx = null;
            }
        }
    }

    /** Idempotent re-evaluation and decoration sync for a single window */
    _reconcileWindow(win) {
        const state = this._windows.get(win);
        if (!state)
            return;
        const actor = win.get_compositor_private();
        if (!actor || actor.width === 0 || actor.height === 0)
            return;

        const actions = this._evaluateActions(win);
        this._syncClip(win, actions.applyClip);
        this._syncShadow(win, actions.applyShadow);

        if (state.clip || state.shadow)
            this._updateStyle(win);
    }

    /** Full idempotent re-evaluation: synchronizes clip and shadow for each tracked window */
    _reconcile() {
        for (const [win] of this._windows)
            this._reconcileWindow(win);
    }

    get _windowGroup() {
        return global.window_group ?? global.windowGroup;
    }

    /** Re-orders all shadow actors below corresponding windows after restack */
    _restackShadows() {
        for (const [win, state] of this._windows) {
            if (!state.shadow)
                continue;
            const actor = win.get_compositor_private();
            if (!actor)
                continue;
            this._windowGroup.set_child_below_sibling(state.shadow.actor, actor);
        }
    }

    /** Reads full window state -> passes to detector.evaluateWindowActions */
    _evaluateActions(win) {
        const actor = win.get_compositor_private();
        if (!actor)
            return {applyShadow: false, applyClip: false};

        const b = win.get_buffer_rect();
        const f = win.get_frame_rect();
        const hasSsd = Boolean(win.decorated);
        const isX11 = win.get_client_type?.() === 1 ||
                      (Meta?.WindowClientType && win.get_client_type?.() === Meta.WindowClientType.X11);
        const wmClass = win.get_wm_class();
        const geometryScale = actor.get_geometry_scale?.() ?? 1;
        const monitorScale = this._getMonitorScale(win);
        const hasParent = Boolean(win.get_transient_for?.());
        const isAttachedDialog = Boolean(win.is_attached_dialog?.());
        const windowType = win.get_window_type();
        const isDialog = isDialogWindow({windowType, hasParent, isAttachedDialog});
        const title = win.get_title?.() ?? null;

        return evaluateWindowActions({
            // Geometry & scale
            bufferWidth: b.width, bufferHeight: b.height,
            frameWidth: f.width, frameHeight: f.height,
            geometryScale,
            monitorScale,

            // Window state & type
            isMaximized: win.maximized_horizontally && win.maximized_vertically,
            isFullscreen: win.is_fullscreen(),
            hasSsd,
            isX11,
            windowType,
            isDialog,
            hasParent,
            title,
            wmClass,

            // Preferences & rules
            windowRules: this._getWindowRules(),
            preferCrispText: this._settings.get_boolean('prefer-crisp-text'),
        });
    }

    _undecorate(win) {
        this._syncClip(win, false);
        this._syncShadow(win, false);
    }

    /** Reads window state -> styleForWindow */
    _styleOf(win) {
        const hMax = win.maximized_horizontally;
        const vMax = win.maximized_vertically;
        return styleForWindow({
            focused: win.appears_focused,
            maximized: hMax && vMax,
            fullscreen: win.is_fullscreen(),
            tiled: hMax !== vMax,  // Half-tile = single-axis maximized (mutter tiling)
            highContrast: St.Settings.get().high_contrast,
        });
    }

    /** Applies style -> shader uniforms; optionally accepts new w/h on size change */
    _applyStyle(win, style, wOverride, hOverride) {
        const state = this._windows.get(win);
        const actor = win.get_compositor_private();
        if (!state || !actor)
            return;

        const w = wOverride ?? actor.width;
        const h = hOverride ?? actor.height;
        if (state.clip)
            state.clip.setParams(w, h, style.radius, style.outline);
        if (state.shadowFx) {
            // If corner clipping is skipped (square corners), sync shadow radius to 0 to fit square outline
            const shadowRadius = state.clip ? style.radius : 0;
            state.shadowFx.setParams(w, h, shadowRadius, SHADOW_PAD, style.shadows);
        }
    }

    _updateStyle(win) {
        this._applyStyle(win, this._styleOf(win));
    }
}
