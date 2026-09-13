/**
 * settings layer unit tests (jasmine-gjs).
 * Run: pnpm test
 */

import {
    buildRuleKey,
} from '../src/lib/rules.js';
import {
    getWindowRules, setWindowRules, SETTINGS_KEY_SUPPRESS_RULES,
    SETTINGS_KEY_FORCE_RULES,
} from '../src/lib/settings.js';

describe('getWindowRules', () => {
    const validKey = buildRuleKey('wechat', {hasParent: true, allowsResize: false});

    it('unpacks and sanitizes both groups from mock settings', () => {
        const mockSettings = {
            get_value: (key) => {
                if (key === SETTINGS_KEY_SUPPRESS_RULES) {
                    return {
                        deep_unpack: () => ({
                            [validKey]: 'corners',
                            'bad:foo=bar': 'corners',
                        }),
                    };
                }
                if (key === SETTINGS_KEY_FORCE_RULES) {
                    return {
                        deep_unpack: () => ({
                            [buildRuleKey('gtk4-app')]: 'corners,shadow',
                        }),
                    };
                }
                return null;
            },
        };
        expect(getWindowRules(mockSettings)).toEqual({
            suppress: {[validKey]: 'corners'},
            force: {[buildRuleKey('gtk4-app')]: 'shadow,corners'},
        });
    });

    it('reads only the suppress group when force-rules is absent', () => {
        const mockSettings = {
            get_value: (key) => (key === SETTINGS_KEY_SUPPRESS_RULES
                ? {deep_unpack: () => ({[validKey]: 'shadow'})}
                : null),
        };
        expect(getWindowRules(mockSettings)).toEqual({
            suppress: {[validKey]: 'shadow'},
            force: {},
        });
    });

    it('returns empty groups on null or throwing settings', () => {
        expect(getWindowRules(null)).toEqual({suppress: {}, force: {}});
        expect(getWindowRules({})).toEqual({suppress: {}, force: {}});
        expect(getWindowRules({
            get_value: () => {
                throw new Error('boom');
            },
        })).toEqual({suppress: {}, force: {}});
    });

    it('setWindowRules sanitizes and writes both GSettings keys', () => {
        const saved = new Map();
        const mockSettings = {
            set_value: (key, val) => {
                saved.set(key, val);
            },
        };
        setWindowRules(mockSettings, {
            suppress: {
                [buildRuleKey('wechat')]: 'corners',
                'invalid:key': 'corners',
            },
            force: {
                [buildRuleKey('gtk4-app')]: 'corners,shadow',
            },
        });

        expect(saved.has(SETTINGS_KEY_SUPPRESS_RULES)).toBeTrue();
        expect(saved.has(SETTINGS_KEY_FORCE_RULES)).toBeTrue();
        expect(saved.get(SETTINGS_KEY_SUPPRESS_RULES).deep_unpack()).toEqual({
            [buildRuleKey('wechat')]: 'corners',
        });
        expect(saved.get(SETTINGS_KEY_FORCE_RULES).deep_unpack()).toEqual({
            [buildRuleKey('gtk4-app')]: 'shadow,corners',
        });
    });

    it('skips writing a group whose stored value already matches', () => {
        let writes = 0;
        const mockSettings = {
            get_value: () => ({equal: () => true}),
            set_value: () => { writes++; },
        };
        setWindowRules(mockSettings, {
            suppress: {[buildRuleKey('wechat')]: 'corners'},
            force: {[buildRuleKey('gtk4-app')]: 'shadow'},
        });
        expect(writes).toBe(0);
    });

    it('writes a group whose stored value differs', () => {
        let writes = 0;
        const mockSettings = {
            get_value: () => ({equal: () => false}),
            set_value: () => { writes++; },
        };
        setWindowRules(mockSettings, {suppress: {[buildRuleKey('wechat')]: 'corners'}});
        expect(writes).toBe(2);
    });
});

