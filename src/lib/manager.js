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
 *  - win.is_maximized()                  : 45–50 stable method (canonical C meta_window_is_maximized).
 *  - win.get_tile_match()                : 45–50 stable method (returns adjacent matching tile window).
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

import {
    evaluateWindowActions,
    isWindowMaximized,
    isWindowTiled,
    pickedRuleWouldChange,
} from './detector.js';
import {extractWindowProperties} from './pick.js';
import {getWindowRules, SETTINGS_KEY_SUPPRESS_RULES, SETTINGS_KEY_FORCE_RULES} from './settings.js';
import {resolveWindowIdentity} from './window.js';
import {styleForWindow} from './style.js';
import {RoundedClipEffect} from '../effects/clipEffect.js';
import {SdfShadowEffect} from '../effects/shadowEffect.js';
import {ShadowActor, SHADOW_PAD} from '../effects/shadowActor.js';

const CLIENT_TYPE_X11 = Meta.WindowClientType.X11;

export class Manager {
    /** @param {import('../extension.js').default} ext */
    constructor(ext) {
        this._ext = ext;
        this._settings = ext.getSettings();
        this._windows = new Map();  // Meta.Window -> decorations state
        this._signals = [];
        this._rules = null;         // cached {suppress, force}, invalidated on settings change
    }

    enable() {
        // Display-level events (global)
        const wm = global.windowManager;
        this._connect(this._signals, wm, 'switch-workspace', () => this._reconcile());
        this._connect(this._signals, global.display, 'window-created', (_, win) => this._trackWindow(win));
        this._connect(this._signals, global.display, 'grab-op-end', () => this._reconcile());
        // Window restacking (focus/raise/lower) -> shadow actor must be placed below window
        this._connect(this._signals, global.display, 'restacked', () => this._restackShadows());
        // Focus change (active <-> backdrop shadow depth transition)
        this._connect(this._signals, global.display, 'notify::focus-window', () => this._reconcileDebounced());

        // Accessibility style (high contrast swaps the shadow set and deepens the outline)
        this._connect(this._signals, St.Settings.get(), 'notify::high-contrast', () => this._reconcile());

        // Monitor changes (scale changes, plugging/unplugging displays, etc.)
        const monitorManager = global.backend?.get_monitor_manager?.();
        if (monitorManager)
            this._connect(this._signals, monitorManager, 'monitors-changed', () => this._reconcile());

        // GSettings changes -> full re-evaluation (only relevant core keys)
        this._settingsHandlerIds = [];
        for (const key of [SETTINGS_KEY_SUPPRESS_RULES, SETTINGS_KEY_FORCE_RULES, 'prefer-crisp-text']) {
            const id = this._settings.connect(`changed::${key}`, () => {
                this._rules = null;
                this._reconcile();
            });
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
            this._disconnectSignals(state.signals);
            this._undecorate(win);
        }
        this._windows.clear();
        this._disconnectSignals(this._signals);
        this._settingsHandlerIds?.forEach(id => this._settings.disconnect(id));
        this._settingsHandlerIds = [];
        this._rules = null;
    }

    // ---------- Internal ----------

    _disconnectSignals(signalsList) {
        if (!Array.isArray(signalsList))
            return;
        for (const [obj, id] of signalsList) {
            try {
                obj.disconnect(id);
            } catch {
                // Silently ignore if object is already destroyed
            }
        }
        signalsList.length = 0;
    }

    /**
     * Connects a signal and records the [object, id] handle in the specified array.
     *
     * Semantics & Error Handling:
     * - Global / Extension-level signals (safe = false, default):
     *   Core signals (e.g. global.display, wm) must succeed. Any failure indicates a fatal API
     *   mismatch and should bubble up immediately.
     * - Window / Actor-level signals (safe = true):
     *   Certain signals (e.g. highest-scale-monitor-changed) vary across Mutter versions (45-50),
     *   or the window/actor may unmanage concurrently during connection. Safe mode silently
     *   ignores failures to guarantee stability across different Mutter releases.
     *
     * @param {Array<[object, number]>} list - Target signal registration list
     * @param {object} obj - Object emitting signal
     * @param {string} signal - Signal name
     * @param {Function} handler - Signal callback
     * @param {boolean} [safe=false] - Whether to silently swallow connection errors
     */
    _connect(list, obj, signal, handler, safe = false) {
        try {
            list.push([obj, obj.connect(signal, handler)]);
        } catch (e) {
            if (!safe)
                throw e;
        }
    }

    _trackWindow(win) {
        if (this._windows.has(win))
            return;
        const state = {clip: null, shadow: null, shadowFx: null, idleId: null, signals: []};
        this._windows.set(win, state);

        // Window-level signals (position/size/focus/monitor changes -> idempotent re-evaluation)
        const windowSignals = [
            'position-changed', 'size-changed', 'notify::appears-focused',
            'notify::maximized-horizontally', 'notify::maximized-vertically',
            'notify::fullscreen', 'notify::main-monitor', 'highest-scale-monitor-changed',
        ];
        for (const sig of windowSignals)
            this._connect(state.signals, win, sig, () => this._reconcileDebounced(), true);

        this._connect(state.signals, win, 'unmanaging', () => this._forgetWindow(win), true);

        // Actor allocation changes (initial frame size 0 -> ready re-evaluation + size tracking)
        const actor = win.get_compositor_private();
        if (actor) {
            this._connect(state.signals, actor, 'notify::allocation', () => {
                // First frame ready: defer to idle so we don't mutate actor hierarchy during allocation pass
                if ((!state.clip && !state.shadow) && actor.width > 0 && actor.height > 0) {
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
            }, true);
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
            this._disconnectSignals(state.signals);
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
                state.shadow = new ShadowActor(actor, global.window_group);
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
        const style = this._styleOf(win);

        // The clip effect only earns its offscreen pass when there is something to
        // draw: a corner to round or an outline to paint. Tiled and maximized states
        // set radius 0 and no outline, so attaching it there is pure waste.
        const wantClip = actions.applyClip && (style.radius > 0 || Boolean(style.outline));
        this._syncClip(win, wantClip);
        this._syncShadow(win, actions.applyShadow);

        if (state.clip || state.shadow)
            this._applyStyle(win, style);
    }

    /** Full idempotent re-evaluation: synchronizes clip and shadow for each tracked window */
    _reconcile() {
        for (const [win] of this._windows)
            this._reconcileWindow(win);
    }

    /**
     * Rules are read once per reconcile batch rather than once per window, and
     * re-read only when the underlying settings keys change.
     */
    get _windowRules() {
        if (!this._rules)
            this._rules = getWindowRules(this._settings);
        return this._rules;
    }

    /** Re-orders all shadow actors below corresponding windows after restack */
    _restackShadows() {
        for (const [win, state] of this._windows) {
            if (!state.shadow)
                continue;
            const actor = win.get_compositor_private();
            if (!actor)
                continue;
            global.window_group.set_child_below_sibling(state.shadow.actor, actor);
        }
    }

    /** Reads full window state -> passes to detector.evaluateWindowActions */
    /**
     * Everything the decoration decision depends on, read from a live window.
     * Shared with ruleWouldChangeKind() so a rule is judged against the same
     * inputs the runtime will later apply it to.
     */
    _decorationInputs(win) {
        const b = win.get_buffer_rect();
        const f = win.get_frame_rect();
        const clientType = win.get_client_type?.();

        return {
            // Geometry & scale
            bufferWidth: b.width, bufferHeight: b.height,
            frameWidth: f.width, frameHeight: f.height,
            monitorScale: this._getMonitorScale(win),

            // Window state & type
            isMaximized: isWindowMaximized(win),
            isFullscreen: win.is_fullscreen(),
            hasSsd: Boolean(win.decorated),
            isX11: clientType === CLIENT_TYPE_X11,
            windowType: win.get_window_type(),
            hasParent: Boolean(win.get_transient_for?.()),
            isAttachedDialog: Boolean(win.is_attached_dialog?.()),
            allowsResize: Boolean(win.allows_resize?.()),
            hasTileMatch: Boolean(win.get_tile_match?.()),
            wmClass: resolveWindowIdentity(win),

            // Preferences & rules
            rules: this._windowRules,
            preferCrispText: this._settings.get_boolean('prefer-crisp-text'),
        };
    }

    _evaluateActions(win) {
        const actor = win.get_compositor_private();
        if (!actor)
            return {applyShadow: false, applyClip: false};

        return evaluateWindowActions(this._decorationInputs(win));
    }

    /**
     * Whether a rule for this window's kind would change what we draw, or null
     * when the window cannot be identified.
     */
    ruleWouldChangeKind(win, direction) {
        const inputs = this._decorationInputs(win);
        return pickedRuleWouldChange(extractWindowProperties(win, inputs.wmClass), inputs, direction);
    }

    _undecorate(win) {
        this._syncClip(win, false);
        this._syncShadow(win, false);
    }

    /** Reads window state -> styleForWindow */
    _styleOf(win) {
        const isMaximized = isWindowMaximized(win);
        const hasTileMatch = Boolean(win.get_tile_match?.());
        const isTiled = isWindowTiled(win, {isMaximized, hasTileMatch});

        return styleForWindow({
            focused: win.appears_focused,
            maximized: isMaximized,
            fullscreen: win.is_fullscreen(),
            tiled: isTiled,
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
}
