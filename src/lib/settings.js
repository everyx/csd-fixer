/**
 * Settings - GSettings IO adapter for Window Nativizer.
 *
 * Responsibilities:
 *   - Reads and deserializes both window rule groups (a{ss})
 *   - Serializes and saves updated rules back to GSettings
 *   - Isolates GSettings IO from pure detection and rule resolution logic
 */

import GLib from 'gi://GLib';
import {sanitizeWindowRules} from './rules.js';

/** Windows this extension must not decorate; key -> axes to suppress. */
export const SETTINGS_KEY_SUPPRESS_RULES = 'suppress-rules';

/** Windows this extension must decorate anyway; key -> axes to force. */
export const SETTINGS_KEY_FORCE_RULES = 'force-rules';

/**
 * Reads and sanitizes both window rule groups from GSettings.
 *
 * @param {object} settings - GSettings object
 * @returns {{suppress: Record<string, string>, force: Record<string, string>}}
 */
export function getWindowRules(settings) {
    return sanitizeWindowRules({
        suppress: readRuleGroup(settings, SETTINGS_KEY_SUPPRESS_RULES),
        force: readRuleGroup(settings, SETTINGS_KEY_FORCE_RULES),
    });
}

/**
 * Saves both window rule groups to GSettings.
 *
 * @param {object} settings - GSettings object
 * @param {{suppress?: Record<string, string>, force?: Record<string, string>}} rules
 */
export function setWindowRules(settings, rules) {
    const clean = sanitizeWindowRules(rules);
    writeRuleGroup(settings, SETTINGS_KEY_SUPPRESS_RULES, clean.suppress);
    writeRuleGroup(settings, SETTINGS_KEY_FORCE_RULES, clean.force);
}

/**
 * Writes one group, unless it already holds exactly these rules. Every write
 * notifies the Shell side, which then re-evaluates every tracked window, so
 * changing one group must not cost the same as changing both.
 */
function writeRuleGroup(settings, key, group) {
    const value = new GLib.Variant('a{ss}', group);
    try {
        if (settings?.get_value?.(key)?.equal(value))
            return;
    } catch {
        // Unreadable key: writing it is the way back to a known state.
    }
    settings.set_value(key, value);
}

function readRuleGroup(settings, key) {
    try {
        const value = settings?.get_value?.(key);
        return value ? value.deep_unpack() : {};
    } catch {
        return {};
    }
}
