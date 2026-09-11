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
 * Decoration detection: what we would draw for a window, and whether a rule would
 * change it. The four-layer model behind that, and where it diverges from Mutter
 * on purpose, are in docs/decoration-model.md. Pure logic module, unit-testable.
 */
/**
 * Computes window content margins - how far the buffer extends past the frame on
 * each side pair - as {w, h} two-sided totals, each >= 0.
 *
 * Both rectangles carry the window's geometry scale, so the difference is the
 * margin the client declared: logical pixels on Wayland, and scaled by a factor
 * GJS cannot read on a backend that lays monitors out physically. See
 * docs/decoration-model.md.
 */
export function computeInsets(bufferWidth, bufferHeight, frameWidth, frameHeight) {
    return {
        w: Math.max(0, bufferWidth - frameWidth),
        h: Math.max(0, bufferHeight - frameHeight),
    };
}
/**
 * Whether the extension is allowed to decorate this window at all. Structural
 * facts, not guesses - no rule may override them.
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
 * Both axes answer the same, because each reason below is about the window as a
 * whole; they are returned separately so a `force` rule may flip one and leave the
 * other here. The X11 case covers corners too, and is a consistency call rather
 * than a fact - see docs/decoration-model.md.
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

    // X11 / XWayland without custom frame extents (e.g. WPS Office, Dida): Mutter
    // draws the box shadow itself (meta-window-actor-x11.c:has_shadow), and ours
    // would duplicate it. A declared extent makes Mutter drop its own, so those
    // windows are decorated like any other.
    if (isX11 && sideW <= 0 && sideH <= 0)
        return {shadow: false, corners: false, reason: 'x11-mutter-native-shadow'};

    return {shadow: true, corners: true, reason: `no-csd(insets=${sideW.toFixed(1)}x${sideH.toFixed(1)} < ${insetThreshold})`};
}
/**
 * Checks whether the scaling factor is fractional. Invalid or <= 0 counts as no.
 */
export function isFractionalScale(scale) {
    if (scale === null || scale === undefined || !Number.isFinite(scale) || scale <= 0)
        return false;
    return Math.abs(scale - Math.round(scale)) > 0.001;
}
/**
 * Whether to clip the window to its rounded corners: always, unless the user
 * prefers crisp text on a fractional-scale display, where clipping is what blurs.
 */
export function shouldClipWindow({preferCrispText = false, scale = 1}) {
    if (!preferCrispText)
        return true;
    return !isFractionalScale(scale);
}
/**
 * @param {object} win - Meta.Window instance
 * @returns {boolean} Whether the window is maximized
 */
export function isWindowMaximized(win) {
    return Boolean(win?.is_maximized?.());
}
/**
 * Checks whether a window is in a snap-tiled state: half-tiled on one axis, or
 * matched with a neighbour. Both flatten their corners, so the background cannot
 * leak past a flat screen edge or the split between two windows; only the matched
 * one also loses its shadow - see docs/decoration-model.md.
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
    // 1. Structural eligibility - no rule may override it.
    // 2. Inferred baseline - what we would do with no rule at all.
    // 3. User rule - moves the axes it names; the only layer that can turn one on.
    // 4. State modifiers - policies, not inferences (docs/decoration-model.md).
    const eligibility = checkDecorationEligibility({windowType, isMaximized, isFullscreen, hasSsd});
    if (!eligibility.eligible)
        return {applyShadow: false, applyClip: false, reason: eligibility.reason};

    const {w, h} = computeInsets(bufferWidth, bufferHeight, frameWidth, frameHeight);
    const baseline = inferDecorationBaseline({
        isX11, sideW: w / 2, sideH: h / 2, insetThreshold,
    });

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

    // 4. State modifiers, applied last: policies, not inferences about who already
    //    paints what (docs/decoration-model.md).
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
 * picker refuses to add one. Running the runtime's evaluator twice - with and
 * without the rule - covers every way a rule can be inert: an ineligible kind, a
 * baseline that already answers as asked, a policy that overrides it again. *
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
 * A fresh pick names every axis (RULE_AXIS_ORDER) and the user narrows it down
 * from there. State that comes and goes must not decide this: a rule worth
 * creating for a restored window is worth creating while it is maximized, so the
 * kind's attributes and the margins it declares are what count. *
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
