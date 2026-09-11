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
 * Window decoration detection and the window-rule model.
 *
 * Decoration is decided per axis (shadow, corners), in four layers:
 * 1. Structural eligibility - window type, maximized/fullscreen, server-side
 *    decorations. These are facts about the window; no rule may override them.
 * 2. Inferred baseline - whether the client already draws a shadow (content
 *    margins) or, for X11, whether Mutter draws one itself. Both axes answer
 *    alike here, because every case is about the window as a whole.
 * 3. User rules - 'suppress-rules' / 'force-rules' move the axes they name and
 *    leave the others to the baseline. This is the only layer that may turn an
 *    axis back on.
 * 4. State modifiers - snap-tiled windows lose the shadow (matches Mutter, so
 *    the shadow does not obstruct the neighbour), and corner clipping is skipped
 *    under fractional scaling when the user prefers crisp text.
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
 * Whether the extension is allowed to decorate this window at all.
 *
 * These are structural facts, not guesses: a menu is never a window we decorate,
 * a maximized window has no decoration to add, and a server-decorated window
 * already has one. A user rule must never override them.
 *
 * @param {object} [params={}]
 * @param {number} [params.windowType=WindowType.NORMAL] - Meta.WindowType
 * @param {boolean} [params.isMaximized=false]
 * @param {boolean} [params.isFullscreen=false]
 * @param {boolean} [params.hasSsd=false] - Mutter already draws frame/titlebar
 * @returns {{eligible: boolean, reason: string}}
 */
export function checkDecorationEligibility({
    windowType = WindowType.NORMAL,
    isMaximized = false, isFullscreen = false,
    hasSsd = false,
} = {}) {
    // Only normal, dialog, modal and utility windows are ours to decorate.
    if (windowType !== WindowType.NORMAL && windowType !== WindowType.DIALOG &&
        windowType !== WindowType.MODAL_DIALOG && windowType !== WindowType.UTILITY)
        return {eligible: false, reason: `window-type=${windowType}`};

    // Maximized / fullscreen: libadwaita gives them square corners and no shadow.
    if (isMaximized || isFullscreen)
        return {eligible: false, reason: 'maximized/fullscreen'};

    // Server-side decorations: Mutter already drew the whole decoration.
    if (hasSsd)
        return {eligible: false, reason: 'has-ssd-frame'};

    return {eligible: true, reason: ''};
}

/**
 * The decoration we would apply with no user rule, answered per axis.
 *
 * Both axes answer the same today, because each reason below is about the window
 * as a whole. They are returned separately because a `force` rule may flip one
 * axis while leaving the other to this baseline.
 *
 * The X11 case also covers corners, not only the shadow: Mutter's generated
 * shadow follows the window's square frame and cannot be removed from JS, so
 * rounding the contents alone would leave square shadow corners poking out past
 * the rounded content. That is a visual-consistency call rather than a hard
 * fact, which is exactly why a `force` rule is allowed to override it.
 *
 * @param {object} params
 * @param {boolean} [params.isX11=false]
 * @param {number} params.sideW - per-side content margin, logical px
 * @param {number} params.sideH - per-side content margin, logical px
 * @param {number} [params.insetThreshold]
 * @returns {{shadow: boolean, corners: boolean, reason: string}}
 */
export function inferDecorationBaseline({
    isX11 = false,
    sideW, sideH,
    insetThreshold = MUTTER_CSD_MIN_INSET_THRESHOLD,
}) {
    // A genuine client-side shadow reserves margin on every side; an oversized
    // margin on a single axis is instead a resize grip or partial decoration.
    if (sideW >= insetThreshold && sideH >= insetThreshold)
        return {shadow: false, corners: false, reason: `has-csd(insets=${sideW.toFixed(1)}x${sideH.toFixed(1)} >= ${insetThreshold})`};

    // X11 / XWayland without custom frame extents (e.g. WPS Office, Dida):
    // Mutter C core renders box shadows itself (meta-window-actor-x11.c:has_shadow).
    // Decorating causes duplicate shadows and breaks offscreen clip geometry.
    // X11 windows that DO declare custom frame extents (e.g. the WeChat 4px resize
    // grip) make Mutter drop its native shadow (has_custom_frame_extents), so those
    // lack any shadow and must be decorated.
    if (isX11 && sideW <= 0 && sideH <= 0)
        return {shadow: false, corners: false, reason: 'x11-mutter-native-shadow'};

    return {shadow: true, corners: true, reason: `no-csd(insets=${sideW.toFixed(1)}x${sideH.toFixed(1)} < ${insetThreshold})`};
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
 * The two decorations this extension paints. They are independent: a window can
 * have either, both, or neither, and a rule may name one without the other.
 */
export const RuleAxis = Object.freeze({
    SHADOW: 'shadow',
    CORNERS: 'corners',
});

/** Which way a rule moves the axes it names. */
export const RuleDirection = Object.freeze({
    SUPPRESS: 'suppress',
    FORCE: 'force',
});

const RULE_AXIS_ORDER = [RuleAxis.SHADOW, RuleAxis.CORNERS];
// Parenthesised: a bare `a|b` would let the `^` bind to the first alternative only.
const RULE_AXIS_PATTERN = `(?:${RULE_AXIS_ORDER.join('|')})`;

/** A rule value names one or both axes, in canonical order. */
export const VALID_RULE_VALUE_PATTERN = new RegExp(
    `^${RULE_AXIS_PATTERN}(?:,${RULE_AXIS_PATTERN})?$`
);

/**
 * Parses a rule value into the set of axes it names.
 *
 * @param {string} value
 * @returns {Set<string>|null} null when the value is not a valid axis list
 */
export function parseRuleAxes(value) {
    if (typeof value !== 'string' || !VALID_RULE_VALUE_PATTERN.test(value))
        return null;
    return new Set(value.split(','));
}

/**
 * Renders axes back into the canonical rule value (declaration order fixed).
 *
 * @param {Iterable<string>} axes
 * @returns {string} '' when no known axis is named
 */
export function buildRuleValue(axes) {
    const named = new Set(axes);
    return RULE_AXIS_ORDER.filter(axis => named.has(axis)).join(',');
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
 * Validates and sanitizes both rule groups read from settings.
 *
 * Drops malformed keys and values and drops case-colliding duplicate keys so the
 * result is deterministic. It also enforces the invariant the two groups rely
 * on: a window kind belongs to at most one of them. On collision the suppression
 * wins, because under-decorating is visible and reversible while the double
 * decoration a stray force rule can cause is neither.
 *
 * @param {{suppress?: Record<string, string>, force?: Record<string, string>}} [raw={}]
 * @returns {{suppress: Record<string, string>, force: Record<string, string>}}
 */
export function sanitizeWindowRules({suppress = {}, force = {}} = {}) {
    const clean = {
        suppress: sanitizeRuleGroup(suppress, RuleDirection.SUPPRESS),
        force: sanitizeRuleGroup(force, RuleDirection.FORCE),
    };

    for (const key of Object.keys(clean.force)) {
        const colliding = lookupRuleKey(clean.suppress, key);
        if (!colliding)
            continue;
        console.warn(`[csd-fixer] "${key}" is in both rule groups; keeping the suppression`);
        delete clean.force[key];
    }

    return clean;
}

function sanitizeRuleGroup(rawRules, direction) {
    if (!rawRules || typeof rawRules !== 'object')
        return {};

    const clean = {};
    const seenLowerKeys = new Map();

    for (const [key, value] of Object.entries(rawRules)) {
        if (!VALID_RULE_KEY_PATTERN.test(key)) {
            console.warn(`[csd-fixer] Dropping invalid ${direction} rule key: "${key}"`);
            continue;
        }

        const axes = parseRuleAxes(value);
        if (!axes) {
            console.warn(`[csd-fixer] Dropping ${direction} rule with invalid value: "${value}" for key "${key}"`);
            continue;
        }

        const lowerKey = key.toLowerCase();
        if (seenLowerKeys.has(lowerKey)) {
            const existingKey = seenLowerKeys.get(lowerKey);
            console.warn(`[csd-fixer] Dropping case-colliding ${direction} rule key "${key}" (conflicts with "${existingKey}")`);
            continue;
        }

        seenLowerKeys.set(lowerKey, key);
        clean[key] = buildRuleValue(axes);
    }

    return clean;
}

/** Case-insensitive key lookup, because WM_CLASS casing varies between toolkits. */
function lookupRuleKey(group, key) {
    if (Object.prototype.hasOwnProperty.call(group, key))
        return key;

    const lowerKey = key.toLowerCase();
    return Object.keys(group).find(storedKey => storedKey.toLowerCase() === lowerKey) ?? null;
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
 * Resolves the rule that applies to a window, by matching its canonical
 * window-kind fingerprint against both rule groups.
 *
 * There is no specificity hierarchy and no app-wide fallback: a rule applies if
 * and only if the window kind matches, so it can never silently spread to other
 * windows of the same application. Suppressions are checked first, matching the
 * conflict rule enforced by sanitizeWindowRules().
 *
 * wmClass comparison is case-insensitive (both directions); the fingerprint must
 * match exactly.
 *
 * @param {string} wmClass - Window identity (WM_CLASS / app id / resolver result)
 * @param {{suppress?: Record<string, string>, force?: Record<string, string>}} [rules={}]
 * @param {object} [options={}]
 * @param {string} [options.clientType='wayland'] - 'wayland' | 'x11'
 * @param {number} [options.windowType=WindowType.NORMAL] - Meta.WindowType
 * @param {boolean} [options.hasParent=false] - Whether window has parent (transient)
 * @param {boolean} [options.allowsResize=true] - Whether window allows resizing
 * @param {boolean} [options.isAttachedDialog=false] - Whether modal dialog attached to parent
 * @returns {{direction: string, axes: Set<string>}|null} null when no rule matched
 */
export function resolveRule(wmClass, {suppress = {}, force = {}} = {}, options = {}) {
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

    const suppressedKey = lookupRuleKey(suppress, key);
    if (suppressedKey) {
        const axes = parseRuleAxes(suppress[suppressedKey]);
        if (axes)
            return {direction: RuleDirection.SUPPRESS, axes};
    }

    const forcedKey = lookupRuleKey(force, key);
    if (forcedKey) {
        const axes = parseRuleAxes(force[forcedKey]);
        if (axes)
            return {direction: RuleDirection.FORCE, axes};
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
 * @property {{suppress?: Record<string, string>, force?: Record<string, string>}} [rules={}] - Both rule groups
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
    rules = {},
    preferCrispText = false,
    insetThreshold = MUTTER_CSD_MIN_INSET_THRESHOLD,
}) {
    // 1. Structural eligibility. No rule may override these.
    const eligibility = checkDecorationEligibility({windowType, isMaximized, isFullscreen, hasSsd});
    if (!eligibility.eligible)
        return {applyShadow: false, applyClip: false, reason: eligibility.reason};

    // 2. Inferred baseline: what we would do with no rule at all.
    const {w, h} = computeInsets(bufferWidth, bufferHeight, frameWidth, frameHeight, geometryScale);
    const baseline = inferDecorationBaseline({
        isX11, sideW: w / 2, sideH: h / 2, insetThreshold,
    });

    // 3. User rule: moves every axis it names in one direction, leaving the rest
    //    to the baseline. This is the one place a rule may turn an axis back ON.
    const rule = resolveRule(wmClass, rules, {
        clientType: isX11 ? CLIENT_TYPE_TOKEN_X11 : CLIENT_TYPE_TOKEN_WAYLAND,
        windowType,
        hasParent: Boolean(hasParent),
        allowsResize,
        isAttachedDialog,
    });

    let shadow = baseline.shadow;
    let corners = baseline.corners;
    if (rule) {
        const forced = rule.direction === RuleDirection.FORCE;
        if (rule.axes.has(RuleAxis.SHADOW))
            shadow = forced;
        if (rule.axes.has(RuleAxis.CORNERS))
            corners = forced;
    }

    // 4. State modifiers are applied last, on top of both the baseline and any
    //    rule, because they are visual policies rather than inferences about who
    //    already paints what:
    //      - a snap-tiled neighbour would be obstructed by our shadow
    //        (meta-window-actor-x11.c: "If we have two snap-tiled windows, we
    //        don't want the shadow to obstruct the other window.")
    //      - corner clipping is what blurs text under fractional scaling
    const shadowBeforeTiling = shadow;
    shadow = shadow && !hasTileMatch;
    corners = corners && shouldClipWindow({preferCrispText, scale: monitorScale});

    let reason = rule
        ? `rule-applied(${wmClass}:${rule.direction}:${buildRuleValue(rule.axes)})`
        : baseline.reason;
    if (shadowBeforeTiling && !shadow)
        reason = `tile-match(suppress-shadow,${reason})`;

    return {applyShadow: shadow, applyClip: corners, reason};
}

