/**
 * The window-kind rule model: what a rule names and how it is written down.
 *
 * A rule is keyed by an application identity plus five structural attributes of
 * the window ("kind"), and it moves named decoration axes in one direction. This
 * module owns that vocabulary end to end - parsing, canonical rendering, matching
 * and the sanitising that keeps stored rules trustworthy - so the picker, the
 * runtime and the settings layer cannot disagree about what a key means.
 *
 * Pure logic module: no shell globals, unit-testable.
 */

import {WindowType} from './mutterRules.generated.js';

/** Rule-key / D-Bus tokens for the client-type fingerprint field. */
export const CLIENT_TYPE_TOKEN_WAYLAND = 'wayland';
export const CLIENT_TYPE_TOKEN_X11 = 'x11';
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
/**
 * Every decoration a rule can name, in the canonical order of a rule value.
 * Also the set a freshly picked rule names, so the user narrows down from a rule
 * that covers the whole window rather than guessing at what it left out.
 */
export const RULE_AXIS_ORDER = [RuleAxis.SHADOW, RuleAxis.CORNERS];
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
export function boolString(value) {
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
/**
 * Finds the key a rule group actually stores for `key`, ignoring case: the same
 * application can report its identity with different casing from one window to
 * the next, and the settings layer already collapses those onto one kind.
 * Returns null when the group holds no rule for it.
 */
export function lookupRuleKey(group, key) {
    if (Object.prototype.hasOwnProperty.call(group, key))
        return key;

    const lowerKey = key.toLowerCase();
    return Object.keys(group).find(storedKey => storedKey.toLowerCase() === lowerKey) ?? null;
}
/**
 * Returns the rules with `key` moved into `direction`, naming `axes`.
 *
 * A window kind lives in exactly one group, so the other group loses it - under
 * whichever spelling it stored. The picker and the effectiveness check both go
 * through here, so the rule that looked worth adding is the rule that gets
 * stored.
 *
 * @param {{suppress?: Record<string, string>, force?: Record<string, string>}} [rules={}]
 * @param {string} direction - RuleDirection
 * @param {string} key
 * @param {Iterable<string>} axes
 * @returns {{suppress: Record<string, string>, force: Record<string, string>}}
 */
export function withRule({suppress = {}, force = {}} = {}, direction, key, axes) {
    const moved = {
        suppress: {...suppress},
        force: {...force},
    };

    const other = direction === RuleDirection.SUPPRESS
        ? RuleDirection.FORCE
        : RuleDirection.SUPPRESS;
    const previous = lookupRuleKey(moved[other], key);
    if (previous)
        delete moved[other][previous];

    moved[direction][key] = buildRuleValue(axes);
    return moved;
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
