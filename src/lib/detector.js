import {
    MUTTER_CSD_MIN_INSET_THRESHOLD,
} from './mutterRules.generated.js';

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

    // 4. X11 / XWayland windows: Mutter C core natively renders box shadows
    // (meta-window-actor-x11.c:has_shadow). Decorating causes duplicate shadows and breaks offscreen clip geometry.
    if (isX11)
        return {apply: false, reason: 'x11-mutter-native-shadow'};

    // 5. Core geometric criteria: matches Mutter shadow threshold
    // Single-side margin = (physical buffer / scale - logical frame) / 2
    const {w, h} = computeInsets(bufferWidth, bufferHeight,
        frameWidth, frameHeight, scale);
    const sideW = w / 2;
    const sideH = h / 2;

    if (sideW < insetThreshold && sideH < insetThreshold)
        return {apply: true, reason: `no-csd(insets=${sideW.toFixed(1)}x${sideH.toFixed(1)} < ${insetThreshold})`};

    return {apply: false, reason: `has-csd(insets=${sideW.toFixed(1)}x${sideH.toFixed(1)} >= ${insetThreshold})`};
}

/**
 * Wayland window type constants (Meta.WindowType, mutter src/meta/common.h).
 */
export const WindowType = {
    NORMAL: 0,
    DESKTOP: 1,
    DOCK: 2,
    DIALOG: 3,
    MODAL_DIALOG: 4,
    TOOLBAR: 5,
    MENU: 6,
    UTILITY: 7,
    SPLASHSCREEN: 8,
};

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
 * Window rule mode enumeration.
 */
export const RuleMode = {
    DISABLE_ALL: 'disable-all',       // Completely disabled (no shadow, no corner clipping)
    DISABLE_CLIP: 'disable-clip',     // Disable corner clipping (retains shadow)
    DISABLE_SHADOW: 'disable-shadow', // Disable shadow (retains corner clipping)
};

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

export const VALID_RULE_KEY_PATTERN = /^[^\s:]+(?::(?:dialog|title=.+))?$/;

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
        if (typeof key !== 'string' || typeof val !== 'string')
            continue;

        if (!VALID_RULE_KEY_PATTERN.test(key)) {
            console.warn(`[csd-fixer] Dropping invalid window rule key: "${key}"`);
            continue;
        }

        const lowerKey = key.toLowerCase();
        if (seenLowerKeys.has(lowerKey)) {
            const existingKey = seenLowerKeys.get(lowerKey);
            console.warn(`[csd-fixer] Dropping case-colliding window rule key "${key}" (conflicts with "${existingKey}")`);
            continue;
        }

        seenLowerKeys.set(lowerKey, key);
        clean[key] = val;
    }

    return clean;
}

/**
 * Splits a rule key into base application wmClass and optional specifier.
 * E.g. "wechat:dialog" -> { baseWmClass: "wechat", specifier: "dialog" }
 *      "wechat" -> { baseWmClass: "wechat", specifier: null }
 */
export function parseRuleKey(key) {
    if (!key)
        return {baseWmClass: '', specifier: null};
    const colonIdx = key.indexOf(':');
    if (colonIdx === -1)
        return {baseWmClass: key, specifier: null};
    return {
        baseWmClass: key.slice(0, colonIdx),
        specifier: key.slice(colonIdx + 1),
    };
}

/**
 * Resolves the rule mode for a window based on composite static fingerprint.
 * Benchmarked against KWin's multi-criteria matching hierarchy (src/rules.cpp).
 *
 * Specificity precedence (most specific to least specific):
 * 1. Exact title rule: `${wmClass}:title=${title}`
 * 2. Window type rule: `${wmClass}:dialog` (if window is a dialog or transient child)
 * 3. Base application rule: `${wmClass}`
 *
 * Bidirectional case-insensitive matching:
 * Matches if either candidate or stored rule key differs only in casing
 * (e.g. wmClass 'WeChat' matches rule 'wechat', and wmClass 'wechat' matches rule 'WeChat:dialog').
 *
 * @param {string} wmClass - Window WM_CLASS identifier
 * @param {Record<string, string>} [windowRules={}] - Active rules dictionary
 * @param {object} [options={}]
 * @param {boolean} [options.isDialog=false] - Whether window acts as dialog/transient
 * @param {string|null} [options.title=null] - Window title
 * @returns {string|null} RuleMode or null if no rule matched
 */
export function resolveRule(wmClass, windowRules = {}, options = {}) {
    if (!wmClass)
        return null;

    const {isDialog = false, title = null} = options;

    const candidates = [];
    if (title && typeof title === 'string' && title.trim().length > 0)
        candidates.push(`${wmClass}:title=${title.trim()}`);
    if (isDialog)
        candidates.push(`${wmClass}:dialog`);
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
 * @property {boolean} [isDialog=false] - Whether window is a dialog
 * @property {boolean} [hasParent=false] - Whether window has transient parent
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
    isDialog = false,
    hasParent = false,
    title = null,
    wmClass,
    windowRules = {},
    preferCrispText = false,
    insetThreshold = MUTTER_CSD_MIN_INSET_THRESHOLD,
}) {
    // 1. Base geometric criteria (whether window lacks CSD)
    // Note on X11 / XWayland precedence:
    // Step 1 inside shouldDecorate unconditionally rejects X11 windows (x11-mutter-native-shadow)
    // because Mutter's C core natively renders shadows for X11 frames.
    // Rule matching is intentionally executed AFTER base criteria: custom rules cannot and
    // should not force decorations onto X11 windows, preventing duplicate shadow rendering.
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

    // 2. Rule evaluation (composite fingerprint matching)
    const isWinDialog = isDialogWindow({
        windowType,
        hasParent: Boolean(isDialog || hasParent),
    });
    const rule = resolveRule(wmClass, windowRules, {isDialog: isWinDialog, title});

    if (rule === RuleMode.DISABLE_ALL) {
        return {
            applyShadow: false,
            applyClip: false,
            reason: `disabled-by-rule(${wmClass}:disable-all)`,
        };
    }

    const applyShadow = rule !== RuleMode.DISABLE_SHADOW;
    const applyClip = rule === RuleMode.DISABLE_CLIP
        ? false
        : shouldClipWindow({preferCrispText, scale: monitorScale});

    return {
        applyShadow,
        applyClip,
        reason: rule ? `rule-applied(${wmClass}:${rule})` : base.reason,
    };
}

