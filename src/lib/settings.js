/**
 * Settings - GSettings IO adapter for CSD Fixer.
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
    settings.set_value(SETTINGS_KEY_SUPPRESS_RULES, new GLib.Variant('a{ss}', clean.suppress));
    settings.set_value(SETTINGS_KEY_FORCE_RULES, new GLib.Variant('a{ss}', clean.force));
}

function readRuleGroup(settings, key) {
    try {
        const value = settings?.get_value?.(key);
        return value ? value.deep_unpack() : {};
    } catch {
        return {};
    }
}
