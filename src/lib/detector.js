import {MUTTER_CSD_MIN_INSET_THRESHOLD, WindowType} from './mutterRules.generated.js';

import {
    CLIENT_TYPE_TOKEN_WAYLAND,
    CLIENT_TYPE_TOKEN_X11,
    RULE_AXIS_ORDER,
    RuleAxis,
    RuleDirection,
    buildRuleValue,
    resolveRule,
    withRule,
} from './rules.js';
import {buildRuleKeyFromProperties} from './pick.js';

/**
 * Window decoration detection and the window-rule model.
 *
 * Decoration is decided per axis (shadow, corners), in four layers:
 * 1. Structural eligibility - window type, maximized/fullscreen, server-side
 *    decorations: facts about the window that no rule may override.
 * 2. Inferred baseline - whether the client already draws a shadow (content
 *    margins) or, for X11, whether Mutter draws one itself. Both axes answer
 *    alike, because every case is about the window as a whole.
 * 3. User rules - 'suppress-rules' / 'force-rules' move the axes they name and
 *    leave the rest to the baseline. The only layer that may turn an axis on.
 * 4. State modifiers - snap-tiled windows lose the shadow (matching Mutter, so
 *    it cannot obstruct the neighbour); corner clipping is skipped under
 *    fractional scaling when the user prefers crisp text.
 *
 * Pure logic module: no shell globals, unit-testable.
 */
/**
 * Computes window content margins: how far the buffer extends past the frame on
 * each side pair.
 *
 * MetaWindow scales both rectangles by the same geometry scale, so the difference
 * is a margin. That scale is 1 whenever the logical monitor layout is LOGICAL,
 * which the native backend always reports (meta-monitor-manager-native.c), so on
 * Wayland the margin is in logical pixels and compares against a logical
 * threshold. A backend that lays monitors out physically uses the integer monitor
 * scale instead, which GJS cannot read; leaving it unconverted makes a margin
 * look larger, never smaller, so the error stays on the side of drawing nothing.
 *
 * Returns {w, h}, each >= 0, holding the two-sided total difference.
 */
export function computeInsets(bufferWidth, bufferHeight, frameWidth, frameHeight) {
    return {
        w: Math.max(0, bufferWidth - frameWidth),
        h: Math.max(0, bufferHeight - frameHeight),
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
 * Geometry and compositor read different answers from the same fact. Any
 * snap-tiled window flattens its corners, so the background cannot leak past a
 * flat screen edge or the split between two neighbours (libadwaita aligns with
 * that); only a window with an adjacent match loses its shadow, so a lone
 * half-tiled window keeps the shadow on its outer edge.
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
 * @typedef {object} WindowEvaluationParams
 * @property {number} bufferWidth - Buffer rectangle width
 * @property {number} bufferHeight - Buffer rectangle height
 * @property {number} frameWidth - Frame rectangle width
 * @property {number} frameHeight - Frame rectangle height
 * @property {number} [monitorScale=1] - Display scale factor
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
    monitorScale = 1,
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
    const {w, h} = computeInsets(bufferWidth, bufferHeight, frameWidth, frameHeight);
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
/**
 * Whether a rule would change the actions we take for a window.
 *
 * A rule that changes nothing is a row that misrepresents what it does, so the
 * picker refuses to add one. Running the runtime's own evaluator twice - with and
 * without the rule - covers every reason a rule can be inert: the kind is never
 * decorated, its baseline already answers the way the rule asks, or a policy
 * overrides it again.
 *
 * @param {WindowEvaluationParams} params - The window, evaluated without the rule
 * @param {{direction: string, key: string, axes: Iterable<string>}} rule
 * @returns {boolean}
 */
export function ruleWouldChangeActions(params, {direction, key, axes}) {
    const before = evaluateWindowActions(params);
    const after = evaluateWindowActions({
        ...params,
        rules: withRule(params.rules, direction, key, axes),
    });

    return before.applyShadow !== after.applyShadow ||
        before.applyClip !== after.applyClip;
}
/**
 * Whether the rule a pick would add for `properties`' window kind would change
 * what we draw for the window `params` describes.
 *
 * A fresh pick names every axis (RULE_AXIS_ORDER), and the user narrows it down
 * from there. The state that comes and goes - maximized, fullscreen, snapped,
 * currently server-decorated - must not decide this: a rule worth creating for a
 * restored window is worth creating while it is maximized. What is left is the
 * kind's own attributes plus the margins it declares, which travel with it.
 *
 * @param {Record<string, string>} properties - extractWindowProperties() output
 * @param {WindowEvaluationParams} params - The window as the runtime sees it
 * @param {string} direction - RuleDirection
 * @returns {boolean|null} null when the window cannot be identified
 */
export function pickedRuleWouldChange(properties, params, direction) {
    const key = buildRuleKeyFromProperties(properties);
    if (!key)
        return null;

    const asKind = {
        ...params,
        isMaximized: false,
        isFullscreen: false,
        hasTileMatch: false,
        hasSsd: false,
    };

    return ruleWouldChangeActions(asKind, {direction, key, axes: RULE_AXIS_ORDER});
}
