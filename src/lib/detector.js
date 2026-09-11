import {
    MUTTER_CSD_MIN_INSET_THRESHOLD,
    WindowType,
} from './mutterRules.generated.js';

export {WindowType};

/**
 * MetaWindowClientType (vendor/mutter/window.h). Values are stable across the
 * typelib (`Meta.WindowClientType`); defined here so the pure detector module
 * can classify client types without importing Shell/Meta.
 */
export const WindowClientType = Object.freeze({
    WAYLAND: 0,
    X11: 1,
});

/** Rule-key / D-Bus tokens for the client-type fingerprint field. */
export const CLIENT_TYPE_TOKEN_WAYLAND = 'wayland';
export const CLIENT_TYPE_TOKEN_X11 = 'x11';

/**
 * Window CSD detection: determines whether a window lacks self-drawn client-side decorations.
 *
 * Criteria strictly align with Mutter source code (meta-shadow-factory.c / meta-window-actor-x11.c):
 * 1. Window type: normal / dialog / modal dialog / utility (aligns with Mutter default_shadow_classes).
 * 2. State exclusions: fullscreen and maximized windows do not receive shadows (aligns with meta_window_is_maximized/fullscreen).
 * 3. Server-side decorations (SSD): if Mutter already provides a native frame/titlebar, skip (aligns with has_frame).
 * 4. Shadow extent threshold: Mutter defines the minimum normal window shadow radius as 8px (spread 21px).
 *    - Client side margin < 8px (e.g. 4px resize grip declared by WeChat/Chromium, or pure square 0px):
 *      Geometrically insufficient to contain a normal shadow; classified as lacking CSD shadows, requiring native decorations.
 *    - Client side margin >= 8px (e.g. GTK4/Adwaita extending 24~40px): classified as having true CSD shadow, skipped.
 *
 * Pure logic module: independent of shell global objects, unit-testable.
 */

/**
 * Computes window content margins (logical pixels) based on buffer and frame rectangles.
 *
 * bufferWidth/bufferHeight are physical pixels (buffer_rect),
 * frameWidth/frameHeight are logical pixels (frame_rect),
 * scale is the actor's geometry scale (buffer -> logical conversion).
 * Returns {w, h} (logical pixels, >= 0, representing two-sided total difference).
 */
export function computeInsets(bufferWidth, bufferHeight,
    frameWidth, frameHeight, scale) {
    return {
        w: Math.max(0, bufferWidth / scale - frameWidth),
        h: Math.max(0, bufferHeight / scale - frameHeight),
    };
}

/**
 * Determines whether a window needs decoration. Returns {apply, reason}.
 *
 * Parameters (read from Meta.Window/actor without side effects):
 *   bufferWidth/bufferHeight  physical pixels
 *   frameWidth/frameHeight    logical pixels
 *   scale                     geometry scale (>= 1)
 *   isMaximized/isFullscreen  boolean
 *   hasSsd                    whether native server-side decorations are present
 *   isX11                     whether the client connects via X11 / XWayland
 *   windowType                Meta.WindowType
 *   insetThreshold            single-side CSD shadow threshold (default: Mutter min radius 8px)
 */
export function shouldDecorate({
    bufferWidth, bufferHeight, frameWidth, frameHeight, scale = 1,
    isMaximized = false, isFullscreen = false,
    hasSsd = false,
    isX11 = false,
    windowType = WindowType.NORMAL,
    insetThreshold = MUTTER_CSD_MIN_INSET_THRESHOLD,
}) {
    // 1. Only decorate normal, dialog, and utility windows
    if (windowType !== WindowType.NORMAL && windowType !== WindowType.DIALOG &&
        windowType !== WindowType.MODAL_DIALOG && windowType !== WindowType.UTILITY)
        return {apply: false, reason: `window-type=${windowType}`};

    // 2. Maximized / fullscreen windows are excluded (matches Mutter has_shadow)
    if (isMaximized || isFullscreen)
        return {apply: false, reason: 'maximized/fullscreen'};

    // 3. Server-side decorated windows: Mutter manages shadows natively
    if (hasSsd)
        return {apply: false, reason: 'has-ssd-frame'};

    // 4. Core geometric criteria: matches Mutter shadow threshold.
    // A genuine client-side shadow reserves margin on every side; an oversized
    // margin on a single axis is instead a resize grip / partial decoration.
    // Require both axes to clear the threshold rather than either one.
    // Single-side margin = (physical buffer / scale - logical frame) / 2
    const {w, h} = computeInsets(bufferWidth, bufferHeight,
        frameWidth, frameHeight, scale);
    const sideW = w / 2;
    const sideH = h / 2;

    if (sideW >= insetThreshold && sideH >= insetThreshold)
        return {apply: false, reason: `has-csd(insets=${sideW.toFixed(1)}x${sideH.toFixed(1)} >= ${insetThreshold})`};

    // 5. X11 / XWayland windows without custom frame extents (insets === 0, e.g. WPS Office, Dida):
    // Mutter C core natively renders box shadows (meta-window-actor-x11.c:has_shadow).
    // Decorating causes duplicate shadows and breaks offscreen clip geometry.
    // Note: X11 windows that DO declare custom frame extents (e.g. WeChat 4px resize grip, sideW > 0)
    // cause Mutter to disable its native shadow (priv->has_custom_frame_extents == TRUE).
    // Those windows lack shadows entirely and MUST be decorated.
    if (isX11 && sideW <= 0 && sideH <= 0)
        return {apply: false, reason: 'x11-mutter-native-shadow'};

    return {apply: true, reason: `no-csd(insets=${sideW.toFixed(1)}x${sideH.toFixed(1)} < ${insetThreshold})`};
}

/**
 * Checks whether the scaling factor is fractional (non-integer).
 * Treats invalid scale or scale <= 0 as non-fractional (false).
 */
export function isFractionalScale(scale) {
    if (scale === null || scale === undefined || !Number.isFinite(scale) || scale <= 0)
        return false;
    return Math.abs(scale - Math.round(scale)) > 0.001;
}

/**
 * Determines whether a window should have rounded corner clipping applied.
 *
 * Rules:
 *   - If preferCrispText is false (default), always returns true (full rounded clipping).
 *   - If preferCrispText is true:
 *     - Fractional scale displays (1.25x, 1.33x, 1.5x, etc.) return false (bypasses FBO clipping for native sharpness).
 *     - Integer scale displays (1.0x, 2.0x, etc.) return true (FBO does not blur under integer scaling).
 */
export function shouldClipWindow({preferCrispText = false, scale = 1}) {
    if (!preferCrispText)
        return true;
    return !isFractionalScale(scale);
}

/**
 * Window exclusion rule mode enumeration.
 * Specifies decoration capabilities to exclude for a window.
 */
export const ExclusionTarget = {
    ALL: 'all',       // Completely disabled (no shadow, no corner clipping)
    CLIP: 'clip',     // Disable corner clipping (retains shadow)
    SHADOW: 'shadow', // Disable shadow (retains corner clipping)
};

export const RULE_MODE_ALIASES = {
    'disable-all': ExclusionTarget.ALL,
    'disable-clip': ExclusionTarget.CLIP,
    'disable-shadow': ExclusionTarget.SHADOW,
};

/**
 * Normalizes an exclusion rule mode to its canonical form ('all', 'clip', 'shadow').
 * Transparently maps legacy 'disable-*' modes for backward compatibility.
 *
 * @param {string} mode
 * @returns {'all'|'clip'|'shadow'|null}
 */
export function normalizeRuleMode(mode) {
    if (typeof mode !== 'string')
        return null;
    const lower = mode.toLowerCase();
    if (RULE_MODE_ALIASES[lower])
        return RULE_MODE_ALIASES[lower];
    if (lower === ExclusionTarget.ALL ||
        lower === ExclusionTarget.CLIP ||
        lower === ExclusionTarget.SHADOW)
        return lower;
    return null;
}

/**
 * Checks whether a window is maximized.
 *
 * @param {object} win - Meta.Window instance
 * @returns {boolean}
 */
export function isWindowMaximized(win) {
    return Boolean(win?.is_maximized?.());
}

/**
 * Checks whether a window is in a snap-tiled state.
 *
 * Design intent & dual-semantics of get_tile_match():
 * 1. Geometry layer (here in isWindowTiled):
 *    Determines whether a window should have flat square corners (radius: 0) and 1px border.
 *    Any snap-tiled window (whether single-axis half-tiled or snap-matched with a neighbor)
 *    must flatten its corners to prevent background leak against screen edges or split borders (Libadwaita alignment).
 * 2. Compositor layer (in evaluateWindowActions):
 *    Suppresses shadows ONLY when hasTileMatch is true (two windows tiled side-by-side touching).
 *    Single tiled windows without an adjacent neighbor retain their outer edge shadow.
 *
 * A window is considered tiled when:
 * 1. It is not fully maximized (neither fullscreen nor both axes maximized), AND
 * 2. Either it is half-tiled (single-axis maximized, hMax !== vMax), OR
 * 3. It is snap-tiled with an adjacent matching window (win.get_tile_match()).
 *
 * @param {object} win - Meta.Window instance
 * @param {object} [options={}]
 * @param {boolean} [options.isMaximized] - Precomputed maximization state
 * @param {boolean} [options.hasTileMatch] - Precomputed tile match state
 * @returns {boolean}
 */
export function isWindowTiled(win, options = {}) {
    if (!win)
        return false;
    const isMax = options.isMaximized ?? isWindowMaximized(win);
    if (isMax)
        return false;
    const hasMatch = options.hasTileMatch ?? Boolean(win.get_tile_match?.());
    const hMax = Boolean(win.maximized_horizontally);
    const vMax = Boolean(win.maximized_vertically);
    return (hMax !== vMax) || hasMatch;
}

/**
 * D-Bus communication coordinates for the Window Inspector service.
 * Shared between the Shell extension process (InspectorService) and the
 * Preferences process (prefs.js). Kept in this pure JS module because prefs.js
 * runs in a separate Gtk process and cannot import inspector.js (which requires
 * Shell-only resource:///org/gnome/shell/ui/main.js).
 */
export const INSPECTOR_DBUS_NAME = 'org.gnome.Shell.Extensions.CsdFixer';
export const INSPECTOR_DBUS_PATH = '/org/gnome/Shell/Extensions/CsdFixer';

function boolString(value) {
    return value ? 'true' : 'false';
}

/** Decodes a rule-key identity, tolerating keys that were never encoded. */
function decodeIdentity(token) {
    try {
        return decodeURIComponent(token);
    } catch {
        return token;
    }
}

/** Shell wraps windows it cannot attribute to an app in a per-window app object. */
const WINDOW_BACKED_APP_ID_PATTERN = /^window:\d+$/;

/**
 * Reports whether a Shell app id is a per-window placeholder rather than a real
 * application identity. It embeds a session-local sequence number, so it cannot
 * address anything across restarts.
 *
 * @param {string} appId
 * @returns {boolean}
 */
export function isWindowBackedAppId(appId) {
    return WINDOW_BACKED_APP_ID_PATTERN.test(appId);
}

/**
 * Picks the identity a rule should be keyed on, from the candidates gathered off
 * a window and its siblings.
 *
 * Pure so it can be unit-tested; gathering the candidates needs Shell APIs and
 * lives in window.js.
 *
 * @param {object} [candidates={}]
 * @param {string} [candidates.declared=''] - Identity the window declares itself
 * @param {string} [candidates.peer=''] - Identity declared by a sibling process window
 * @param {string} [candidates.tracked=''] - Shell.WindowTracker's app id
 * @param {number} [candidates.pid=-1] - Owning process id
 * @returns {string} Identity, or '' when nothing identifies the window
 */
export function chooseWindowIdentity({declared = '', peer = '', tracked = '', pid = -1} = {}) {
    if (declared)
        return declared;
    if (peer)
        return peer;
    if (tracked && !isWindowBackedAppId(tracked))
        return tracked;
    // Last resort: two windows of one process share it, but it changes when the
    // process restarts, so a rule built on it only lives as long as the session.
    return pid > 0 ? `pid-${pid}` : '';
}

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
 * Canonical window fingerprint: the stable structural attributes that define a
 * window "kind" for exclusion rules. The picker and the runtime matcher derive
 * keys from the same fields and compare them as canonical strings, so a rule
 * always targets exactly the kind of window the user picked.
 *
 * Field order is part of the format. There is deliberately no app-wide form:
 * an exclusion never generalizes to every window of an application.
 */
const FP_CLIENT_TYPE = 'client_type';
const FP_WINDOW_TYPE = 'window_type';
const FP_HAS_PARENT = 'has_parent';
const FP_ALLOWS_RESIZE = 'allows_resize';
const FP_ATTACHED_DIALOG = 'attached_dialog';

const FINGERPRINT_SPECIFIER_PATTERN = [
    `${FP_CLIENT_TYPE}=(?:${CLIENT_TYPE_TOKEN_WAYLAND}|${CLIENT_TYPE_TOKEN_X11})`,
    `${FP_WINDOW_TYPE}=\\d+`,
    `${FP_HAS_PARENT}=(?:true|false)`,
    `${FP_ALLOWS_RESIZE}=(?:true|false)`,
    `${FP_ATTACHED_DIALOG}=(?:true|false)`,
].join(',');

export const VALID_RULE_KEY_PATTERN = new RegExp(
    `^[^\\s:]+:${FINGERPRINT_SPECIFIER_PATTERN}$`
);

/**
 * Builds the canonical rule key (application + window-kind fingerprint).
 *
 * @param {string} wmClass - Base window class / app id
 * @param {object} [props={}]
 * @param {string} [props.clientType='wayland'] - 'wayland' | 'x11'
 * @param {number} [props.windowType=WindowType.NORMAL] - Meta.WindowType
 * @param {boolean} [props.hasParent=false] - transient child window
 * @param {boolean} [props.allowsResize=true] - resizable
 * @param {boolean} [props.isAttachedDialog=false] - modal dialog attached to parent
 * @returns {string} Canonical rule key, or '' when wmClass is missing
 */
export function buildRuleKey(wmClass, {
    clientType = CLIENT_TYPE_TOKEN_WAYLAND,
    windowType = WindowType.NORMAL,
    hasParent = false,
    allowsResize = true,
    isAttachedDialog = false,
} = {}) {
    if (!wmClass)
        return '';

    const specifier = [
        `${FP_CLIENT_TYPE}=${clientType}`,
        `${FP_WINDOW_TYPE}=${windowType}`,
        `${FP_HAS_PARENT}=${boolString(hasParent)}`,
        `${FP_ALLOWS_RESIZE}=${boolString(allowsResize)}`,
        `${FP_ATTACHED_DIALOG}=${boolString(isAttachedDialog)}`,
    ].join(',');

    // The key grammar reserves ':' and whitespace as delimiters, so encode the
    // identity instead of assuming it is already key-safe. Realistic identities
    // (WM_CLASS, Flatpak id, reverse-DNS app id) pass through byte-for-byte;
    // only exotic ones are escaped, and parseRuleKey() decodes them back.
    return `${encodeURIComponent(wmClass)}:${specifier}`;
}

/**
 * Validates and sanitizes a window rules dictionary from settings.
 * Discards malformed keys and drops case-colliding duplicate keys to ensure determinism.
 *
 * @param {Record<string, string>} [rawRules={}]
 * @returns {Record<string, string>}
 */
export function sanitizeWindowRules(rawRules = {}) {
    if (!rawRules || typeof rawRules !== 'object')
        return {};

    const clean = {};
    const seenLowerKeys = new Map();

    for (const [key, val] of Object.entries(rawRules)) {
        if (typeof val !== 'string')
            continue;

        if (!VALID_RULE_KEY_PATTERN.test(key)) {
            console.warn(`[csd-fixer] Dropping invalid window rule key: "${key}"`);
            continue;
        }

        const normalizedMode = normalizeRuleMode(val);
        if (!normalizedMode) {
            console.warn(`[csd-fixer] Dropping window rule with invalid mode: "${val}" for key "${key}"`);
            continue;
        }

        const lowerKey = key.toLowerCase();
        if (seenLowerKeys.has(lowerKey)) {
            const existingKey = seenLowerKeys.get(lowerKey);
            console.warn(`[csd-fixer] Dropping case-colliding window rule key "${key}" (conflicts with "${existingKey}")`);
            continue;
        }

        seenLowerKeys.set(lowerKey, key);
        clean[key] = normalizedMode;
    }

    return clean;
}

/**
 * Splits a rule key into base application wmClass, its fingerprint specifier,
 * and the parsed property values. Strict: invalid keys yield an empty result so
 * parser and validator can never disagree.
 *
 * E.g. "wechat:client_type=wayland,window_type=0,has_parent=false,allows_resize=true,attached_dialog=false"
 *   -> { baseWmClass: "wechat", specifier: "client_type=...", properties: {client_type:'wayland', window_type:0, ...} }
 *
 * @param {string} key - Rule key string
 * @returns {{ baseWmClass: string, specifier: string|null, properties: Record<string, string|number|boolean>|null }}
 */
export function parseRuleKey(key) {
    if (!key || typeof key !== 'string' || !VALID_RULE_KEY_PATTERN.test(key))
        return {baseWmClass: '', specifier: null, properties: null};

    const colonIdx = key.indexOf(':');
    const baseWmClass = decodeIdentity(key.slice(0, colonIdx));
    const specifier = key.slice(colonIdx + 1);

    const properties = {};
    for (const pair of specifier.split(',')) {
        const eqIdx = pair.indexOf('=');
        const propName = pair.slice(0, eqIdx);
        const rawValue = pair.slice(eqIdx + 1);

        if (propName === FP_WINDOW_TYPE)
            properties[propName] = Number(rawValue);
        else if (propName === FP_CLIENT_TYPE)
            properties[propName] = rawValue;
        else
            properties[propName] = rawValue === 'true';
    }

    return {baseWmClass, specifier, properties};
}

/**
 * Resolves the exclusion mode for a window by matching its canonical window-kind
 * fingerprint against the stored rules. There is no specificity hierarchy and no
 * app-wide fallback: a rule applies if and only if the window kind matches,
 * so an exclusion can never silently spread to other windows of the app.
 *
 * wmClass comparison is case-insensitive (both directions); the fingerprint
 * must match exactly.
 *
 * @param {string} wmClass - Window WM_CLASS / app id
 * @param {Record<string, string>} [windowRules={}] - Active rules dictionary
 * @param {object} [options={}]
 * @param {string} [options.clientType='wayland'] - 'wayland' | 'x11'
 * @param {number} [options.windowType=WindowType.NORMAL] - Meta.WindowType
 * @param {boolean} [options.hasParent=false] - Whether window has parent (transient)
 * @param {boolean} [options.allowsResize=true] - Whether window allows resizing
 * @param {boolean} [options.isAttachedDialog=false] - Whether modal dialog attached to parent
 * @returns {string|null} ExclusionTarget mode or null if no rule matched
 */
export function resolveRule(wmClass, windowRules = {}, options = {}) {
    if (!wmClass)
        return null;

    const {
        clientType = CLIENT_TYPE_TOKEN_WAYLAND,
        windowType = WindowType.NORMAL,
        hasParent = false,
        allowsResize = true,
        isAttachedDialog = false,
    } = options;

    const key = buildRuleKey(wmClass, {
        clientType,
        windowType,
        hasParent,
        allowsResize,
        isAttachedDialog,
    });
    if (!key)
        return null;

    if (Object.prototype.hasOwnProperty.call(windowRules, key))
        return windowRules[key];

    const lowerKey = key.toLowerCase();
    for (const [storedKey, val] of Object.entries(windowRules)) {
        if (storedKey.toLowerCase() === lowerKey)
            return val;
    }

    return null;
}

/**
 * @typedef {object} WindowEvaluationParams
 * @property {number} bufferWidth - Physical buffer width
 * @property {number} bufferHeight - Physical buffer height
 * @property {number} frameWidth - Logical frame width
 * @property {number} frameHeight - Logical frame height
 * @property {number} [scale=1] - Geometry scale factor
 * @property {number} [geometryScale=scale] - Window buffer geometry scale
 * @property {number} [monitorScale=scale] - Display physical scale factor
 * @property {boolean} [isMaximized=false] - Whether window is maximized
 * @property {boolean} [isFullscreen=false] - Whether window is fullscreen
 * @property {boolean} [hasSsd=false] - Whether native server-side decorations exist
 * @property {boolean} [isX11=false] - Whether client is X11 / XWayland
 * @property {number} [windowType=WindowType.NORMAL] - Wayland/Meta window type
 * @property {boolean} [hasParent=false] - Whether window has transient parent
 * @property {boolean} [isAttachedDialog=false] - Whether modal dialog attached to parent
 * @property {boolean} [allowsResize=true] - Whether window allows resizing
 * @property {boolean} [hasTileMatch=false] - Whether window is snap-tiled with an adjacent matching window
 * @property {string} [wmClass] - Window WM_CLASS / app ID
 * @property {Record<string, string>} [windowRules={}] - Exclusion rules
 * @property {boolean} [preferCrispText=false] - Subpixel crisp text setting
 * @property {number} [insetThreshold] - Mutter CSD minimum margin threshold
 */

/**
 * Evaluates decoration actions based on geometric criteria and exclusion rules.
 *
 * @param {WindowEvaluationParams} params
 * @returns {{ applyShadow: boolean, applyClip: boolean, reason: string }}
 */
export function evaluateWindowActions({
    bufferWidth, bufferHeight, frameWidth, frameHeight,
    scale = 1,
    geometryScale = scale,
    monitorScale = scale,
    isMaximized = false, isFullscreen = false,
    hasSsd = false,
    isX11 = false,
    windowType = WindowType.NORMAL,
    hasParent = false,
    isAttachedDialog = false,
    allowsResize = true,
    hasTileMatch = false,
    wmClass,
    windowRules = {},
    preferCrispText = false,
    insetThreshold = MUTTER_CSD_MIN_INSET_THRESHOLD,
}) {
    // 1. Base geometric criteria (whether window lacks CSD)
    // Note on X11 / XWayland precedence:
    // shouldDecorate suppresses decorations on X11 windows that lack custom frame extents (insets <= 0)
    // because Mutter's C core natively renders their shadows (meta-window-actor-x11.c:has_shadow).
    // X11 windows declaring custom frame extents (e.g. resize grips) lack native shadows and are decorated.
    // Rule matching is intentionally executed AFTER base criteria: custom rules cannot force decorations
    // onto standard X11 windows, preventing duplicate shadow rendering.
    const base = shouldDecorate({
        bufferWidth, bufferHeight, frameWidth, frameHeight,
        scale: geometryScale,
        isMaximized, isFullscreen,
        hasSsd,
        isX11,
        windowType,
        insetThreshold,
    });

    if (!base.apply) {
        return {
            applyShadow: false,
            applyClip: false,
            reason: base.reason,
        };
    }

    // 2. Rule evaluation: exact window-kind fingerprint match
    const rule = resolveRule(wmClass, windowRules, {
        clientType: isX11 ? CLIENT_TYPE_TOKEN_X11 : CLIENT_TYPE_TOKEN_WAYLAND,
        windowType,
        hasParent: Boolean(hasParent),
        allowsResize,
        isAttachedDialog,
    });
    const canonicalRule = normalizeRuleMode(rule);

    if (canonicalRule === ExclusionTarget.ALL) {
        return {
            applyShadow: false,
            applyClip: false,
            reason: `disabled-by-rule(${wmClass}:all)`,
        };
    }

    // 3. Shadow and clip evaluation
    // Snap-tiled window shadow suppression:
    // Emulates Mutter C core (meta-window-actor-x11.c:392) for Wayland clients without CSD:
    // "If we have two snap-tiled windows, we don't want the shadow to obstruct the other window."
    // Suppresses shadow when two windows are snap-tiled adjacent to each other.
    const applyShadow = canonicalRule !== ExclusionTarget.SHADOW && !hasTileMatch;
    const applyClip = canonicalRule === ExclusionTarget.CLIP
        ? false
        : shouldClipWindow({preferCrispText, scale: monitorScale});

    let reason = canonicalRule ? `rule-applied(${wmClass}:${canonicalRule})` : base.reason;
    if (hasTileMatch && !applyShadow && canonicalRule !== ExclusionTarget.SHADOW)
        reason = `tile-match(suppress-shadow,${reason})`;

    return {
        applyShadow,
        applyClip,
        reason,
    };
}

