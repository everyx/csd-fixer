import {
    MUTTER_CSD_MIN_INSET_THRESHOLD,
    WindowType,
} from './mutterRules.generated.js';

export {WindowType};

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

    // 4. Core geometric criteria: matches Mutter shadow threshold
    // Single-side margin = (physical buffer / scale - logical frame) / 2
    const {w, h} = computeInsets(bufferWidth, bufferHeight,
        frameWidth, frameHeight, scale);
    const sideW = w / 2;
    const sideH = h / 2;

    if (sideW >= insetThreshold || sideH >= insetThreshold)
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
 * Checks whether a window is maximized (horizontally and vertically).
 * Supports both Mutter method API (win.is_maximized()) and property fallback.
 *
 * @param {object} win - Meta.Window instance
 * @returns {boolean}
 */
export function isWindowMaximized(win) {
    if (!win)
        return false;
    if (typeof win.is_maximized === 'function')
        return Boolean(win.is_maximized());
    return Boolean(win.maximized_horizontally && win.maximized_vertically);
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
 * D-Bus interface identifiers for interactive window inspection.
 * Stored in pure module to avoid importing Shell/Clutter/Meta in prefs.js.
 */
export const INSPECTOR_DBUS_NAME = 'org.gnome.Shell.Extensions.CsdFixer';
export const INSPECTOR_DBUS_PATH = '/org/gnome/Shell/Extensions/CsdFixer';

/**
 * Determines whether a window acts as a dialog/transient window.
 * Benchmarked against Mutter's default_shadow_classes categorization.
 *
 * @param {object} [params={}]
 * @param {number} [params.windowType=WindowType.NORMAL] - Meta.WindowType
 * @param {boolean} [params.hasParent=false] - whether transient for another window
 * @param {boolean} [params.isAttachedDialog=false] - whether modal dialog attached to parent
 * @returns {boolean}
 */
export function isDialogWindow({
    windowType = WindowType.NORMAL,
    hasParent = false,
    isAttachedDialog = false,
} = {}) {
    return windowType === WindowType.DIALOG ||
           windowType === WindowType.MODAL_DIALOG ||
           hasParent ||
           isAttachedDialog;
}

export const NATIVE_PROP_PARENT = 'has_parent';
export const NATIVE_PROP_RESIZE = 'allows_resize';

export const NATIVE_RULE_PARENT = `${NATIVE_PROP_PARENT}=true`;
export const NATIVE_RULE_RESIZE_TRUE = `${NATIVE_PROP_RESIZE}=true`;
export const NATIVE_RULE_RESIZE_FALSE = `${NATIVE_PROP_RESIZE}=false`;

export const NATIVE_SPECIFIER_PREFIX = `${NATIVE_RULE_PARENT},${NATIVE_PROP_RESIZE}=`;

const NATIVE_SPECIFIERS_PATTERN = `${NATIVE_RULE_PARENT},${NATIVE_PROP_RESIZE}=(?:true|false)`;
export const VALID_RULE_KEY_PATTERN = new RegExp(
    `^[^\\s:]+(?::(?:dialog|title=.+|${NATIVE_SPECIFIERS_PATTERN}))?$`
);

/**
 * Builds a deterministic canonical rule key from window properties.
 * If window has no parent, returns the base wmClass.
 * If window has parent, returns `${wmClass}:has_parent=true,allows_resize=${allowsResize}`.
 *
 * @param {string} wmClass - Base window class
 * @param {object} [props={}]
 * @param {boolean} [props.hasParent=false]
 * @param {boolean} [props.allowsResize=true]
 * @returns {string} Canonical rule key
 */
export function buildRuleKey(wmClass, {hasParent = false, allowsResize = true} = {}) {
    if (!wmClass)
        return '';

    if (!hasParent)
        return wmClass;

    const resizeProp = allowsResize ? NATIVE_RULE_RESIZE_TRUE : NATIVE_RULE_RESIZE_FALSE;
    return `${wmClass}:${NATIVE_RULE_PARENT},${resizeProp}`;
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
 * Splits a rule key into base application wmClass, optional specifier, and parsed properties.
 * Strict whitelist-backed: returns empty result for invalid keys to ensure parser and validator consistency.
 *
 * E.g. "wechat:has_parent=true,allows_resize=false" -> { baseWmClass: "wechat", specifier: "...", properties: { has_parent: true, allows_resize: false } }
 *      "wechat:dialog" -> { baseWmClass: "wechat", specifier: "dialog", properties: null }
 *      "wechat" -> { baseWmClass: "wechat", specifier: null, properties: null }
 *
 * @param {string} key - Rule key string
 * @returns {{ baseWmClass: string, specifier: string|null, properties: Record<string, boolean>|null }}
 */
export function parseRuleKey(key) {
    if (!key || typeof key !== 'string' || !VALID_RULE_KEY_PATTERN.test(key))
        return {baseWmClass: '', specifier: null, properties: null};

    const colonIdx = key.indexOf(':');
    if (colonIdx === -1)
        return {baseWmClass: key, specifier: null, properties: null};

    const baseWmClass = key.slice(0, colonIdx);
    const specifier = key.slice(colonIdx + 1);

    let properties = null;
    if (specifier.startsWith(NATIVE_SPECIFIER_PREFIX)) {
        const resizeVal = specifier.slice(NATIVE_SPECIFIER_PREFIX.length) === 'true';
        properties = {
            [NATIVE_PROP_PARENT]: true,
            [NATIVE_PROP_RESIZE]: resizeVal,
        };
    }

    return {
        baseWmClass,
        specifier,
        properties,
    };
}

/**
 * Resolves the rule mode for a window based on composite static fingerprint.
 * Benchmarked against KWin's multi-criteria matching hierarchy (src/rules.cpp).
 *
 * Specificity precedence (most specific to least specific):
 * 1. Native property rule: `${wmClass}:has_parent=true,allows_resize=${allowsResize}`
 * 2. Exact title rule: `${wmClass}:title=${title}`
 * 3. Legacy dialog rule: `${wmClass}:dialog` (if window has parent or is dialog)
 * 4. Base application rule: `${wmClass}`
 *
 * Bidirectional case-insensitive matching:
 * Matches if either candidate or stored rule key differs only in casing
 * (e.g. wmClass 'WeChat' matches rule 'wechat', and wmClass 'wechat' matches rule 'WeChat:has_parent=true,allows_resize=false').
 *
 * @param {string} wmClass - Window WM_CLASS identifier
 * @param {Record<string, string>} [windowRules={}] - Active rules dictionary
 * @param {object} [options={}]
 * @param {boolean} [options.hasParent=false] - Whether window has parent (transient)
 * @param {boolean} [options.allowsResize=true] - Whether window allows resizing
 * @param {boolean} [options.isDialog=false] - Whether window acts as dialog/transient
 * @param {string|null} [options.title=null] - Window title
 * @returns {string|null} ExclusionTarget mode or null if no rule matched
 */
export function resolveRule(wmClass, windowRules = {}, options = {}) {
    if (!wmClass)
        return null;

    const {
        hasParent = false,
        allowsResize = true,
        isDialog = false,
        title = null,
    } = options;

    const candidates = [];

    // 1. Native property-based exact match for child windows
    if (hasParent)
        candidates.push(buildRuleKey(wmClass, {hasParent: true, allowsResize}));

    // 2. Exact title rule (legacy / escape-hatch support)
    if (title && typeof title === 'string' && title.trim().length > 0)
        candidates.push(`${wmClass}:title=${title.trim()}`);

    // 3. Dialog rule (backward compatibility with legacy :dialog rules)
    if (isDialog || hasParent)
        candidates.push(`${wmClass}:dialog`);

    // 4. Base application rule (fallback)
    candidates.push(wmClass);

    for (const cand of candidates) {
        if (Object.prototype.hasOwnProperty.call(windowRules, cand))
            return windowRules[cand];

        const lowerCand = cand.toLowerCase();
        for (const [key, val] of Object.entries(windowRules)) {
            if (key.toLowerCase() === lowerCand)
                return val;
        }
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
 * @property {string|null} [title=null] - Window title
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
    title = null,
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

    // 2. Rule evaluation (native properties & composite fingerprint matching)
    const isWinDialog = isDialogWindow({
        windowType,
        hasParent,
        isAttachedDialog,
    });
    const rule = resolveRule(wmClass, windowRules, {
        hasParent: Boolean(hasParent),
        allowsResize,
        isDialog: isWinDialog,
        title,
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

