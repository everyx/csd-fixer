/**
 * Settings - GSettings IO adapter for CSD Fixer.
 *
 * Responsibilities:
 *   - Reads and deserializes GSettings dictionary values (a{ss})
 *   - Serializes and saves updated rules back to GSettings
 *   - Isolates GSettings IO from pure detection and rule resolution logic
 */

import GLib from 'gi://GLib';
import {sanitizeWindowRules} from './detector.js';

export const SETTINGS_KEY_WINDOW_RULES = 'window-rules';

/**
 * Reads and sanitizes window-rules dictionary from GSettings.
 *
 * @param {object} settings - GSettings object
 * @returns {Record<string, string>} Sanitized rule map
 */
export function getWindowRules(settings) {
    try {
        const v = settings?.get_value?.(SETTINGS_KEY_WINDOW_RULES);
        const raw = v ? v.deep_unpack() : {};
        return sanitizeWindowRules(raw);
    } catch {
        return {};
    }
}

/**
 * Saves sanitized window-rules dictionary to GSettings.
 *
 * @param {object} settings - GSettings object
 * @param {Record<string, string>} rules - Rules dictionary to persist
 */
export function setWindowRules(settings, rules) {
    const clean = sanitizeWindowRules(rules);
    const variant = new GLib.Variant('a{ss}', clean);
    settings.set_value(SETTINGS_KEY_WINDOW_RULES, variant);
}
