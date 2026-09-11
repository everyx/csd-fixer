/**
 * rule model unit tests: keys, values and resolution (jasmine-gjs).
 * Run: pnpm test
 */

import {
    WindowType,
} from '../src/lib/mutterRules.generated.js';
import {
    RuleAxis, RuleDirection, RULE_AXIS_ORDER, parseRuleAxes,
    buildRuleValue, resolveRule, parseRuleKey, buildRuleKey,
    sanitizeWindowRules, withRule,
} from '../src/lib/rules.js';

/** Comparable shape for a resolveRule() result. */
function resolved(result) {
    return result && {direction: result.direction, axes: [...result.axes].sort()};
}

describe('rule axes vocabulary', () => {
    it('parseRuleAxes reads each canonical value into a set', () => {
        expect([...parseRuleAxes('shadow')]).toEqual([RuleAxis.SHADOW]);
        expect([...parseRuleAxes('corners')]).toEqual([RuleAxis.CORNERS]);
        expect([...parseRuleAxes('shadow,corners')].sort()).toEqual(['corners', 'shadow']);
    });

    it('parseRuleAxes accepts a reversed pair, normalised later by buildRuleValue', () => {
        expect([...parseRuleAxes('corners,shadow')].sort()).toEqual(['corners', 'shadow']);
    });

    it('parseRuleAxes rejects empty, legacy modes and unknown values', () => {
        for (const bad of [
            '', 'all', 'clip', 'disable-all', 'disable-clip', 'disable-shadow',
            'nonsense', 'both', null, undefined, 42,
        ])
            expect(parseRuleAxes(bad)).toBeNull();
    });

    it('buildRuleValue renders the canonical order regardless of input order', () => {
        expect(buildRuleValue(['corners', 'shadow'])).toBe('shadow,corners');
        expect(buildRuleValue(['shadow', 'corners'])).toBe('shadow,corners');
        expect(buildRuleValue([RuleAxis.CORNERS])).toBe('corners');
        expect(buildRuleValue([RuleAxis.SHADOW])).toBe('shadow');
    });

    it('buildRuleValue returns an empty string when no known axis is named', () => {
        expect(buildRuleValue([])).toBe('');
        expect(buildRuleValue(new Set())).toBe('');
        expect(buildRuleValue(['nonsense'])).toBe('');
    });

    it('round-trips parseRuleAxes -> buildRuleValue', () => {
        for (const value of ['shadow', 'corners', 'shadow,corners'])
            expect(buildRuleValue(parseRuleAxes(value))).toBe(value);
        expect(buildRuleValue(parseRuleAxes('corners,shadow'))).toBe('shadow,corners');
    });
});

describe('resolveRule', () => {
    const mainKey = buildRuleKey('wechat');
    const fixedChildKey = buildRuleKey('wechat', {hasParent: true, allowsResize: false});

    it('exact fingerprint match, returning direction and axes', () => {
        const rules = {
            suppress: {
                [mainKey]: 'corners',
                [fixedChildKey]: 'shadow,corners',
            },
        };
        expect(resolved(resolveRule('wechat', rules)))
            .toEqual({direction: RuleDirection.SUPPRESS, axes: ['corners']});
        expect(resolved(resolveRule('wechat', rules, {hasParent: true, allowsResize: false})))
            .toEqual({direction: RuleDirection.SUPPRESS, axes: ['corners', 'shadow']});
    });

    it('reads force rules from the force group', () => {
        const rules = {force: {[mainKey]: 'corners'}};
        expect(resolved(resolveRule('wechat', rules)))
            .toEqual({direction: RuleDirection.FORCE, axes: ['corners']});
    });

    it('suppression wins when a window kind is in both groups', () => {
        const rules = {
            suppress: {[mainKey]: 'shadow'},
            force: {[mainKey]: 'corners'},
        };
        expect(resolved(resolveRule('wechat', rules)))
            .toEqual({direction: RuleDirection.SUPPRESS, axes: ['shadow']});
    });

    it('does not fall back to the application: a different window kind of the same app does not match', () => {
        const rules = {suppress: {[fixedChildKey]: 'shadow,corners'}};

        expect(resolveRule('wechat', rules)).toBeNull();
        expect(resolveRule('wechat', rules, {hasParent: true, allowsResize: true})).toBeNull();
        expect(resolveRule('wechat', rules, {clientType: 'x11', hasParent: true, allowsResize: false})).toBeNull();
        expect(resolveRule('wechat', rules, {windowType: WindowType.DIALOG, hasParent: true, allowsResize: false})).toBeNull();
    });

    it('matches an identity whatever case the window spells it in', () => {
        const upperRule = buildRuleKey('WeChat', {hasParent: true, allowsResize: false});
        expect(resolved(resolveRule('wechat', {suppress: {[upperRule]: 'shadow,corners'}}, {hasParent: true, allowsResize: false})))
            .toEqual({direction: RuleDirection.SUPPRESS, axes: ['corners', 'shadow']});

        const lowerRule = buildRuleKey('wechat', {hasParent: true, allowsResize: false});
        expect(resolved(resolveRule('WeChat', {suppress: {[lowerRule]: 'shadow,corners'}}, {hasParent: true, allowsResize: false})))
            .toEqual({direction: RuleDirection.SUPPRESS, axes: ['corners', 'shadow']});
    });

    it('no match returns null', () => {
        expect(resolveRule('unknown-app', {suppress: {[mainKey]: 'shadow,corners'}})).toBeNull();
        expect(resolveRule(null, {suppress: {[mainKey]: 'shadow,corners'}})).toBeNull();
        expect(resolveRule('', {suppress: {[mainKey]: 'shadow,corners'}})).toBeNull();
    });

    it('every fingerprint field participates in matching', () => {
        const base = buildRuleKey('app', {
            clientType: 'wayland', windowType: WindowType.NORMAL,
            hasParent: true, allowsResize: false, isAttachedDialog: false,
        });
        const rules = {suppress: {[base]: 'shadow,corners'}};

        expect(resolveRule('app', rules, {hasParent: true, allowsResize: false})).not.toBeNull();
        expect(resolveRule('app', rules, {clientType: 'x11', windowType: WindowType.NORMAL, hasParent: true, allowsResize: false, isAttachedDialog: false})).toBeNull();
        expect(resolveRule('app', rules, {windowType: WindowType.DIALOG, hasParent: true, allowsResize: false, isAttachedDialog: false})).toBeNull();
        expect(resolveRule('app', rules, {hasParent: true, allowsResize: true, isAttachedDialog: false})).toBeNull();
        expect(resolveRule('app', rules, {hasParent: true, allowsResize: false, isAttachedDialog: true})).toBeNull();
    });
});

describe('buildRuleKey', () => {
    it('always emits the full window-kind fingerprint', () => {
        expect(buildRuleKey('wechat')).toBe(
            'wechat:client_type=wayland,window_type=0,has_parent=false,allows_resize=true,attached_dialog=false');
    });

    it('encodes every structural field', () => {
        expect(buildRuleKey('wechat', {
            clientType: 'x11',
            windowType: 3,
            hasParent: true,
            allowsResize: false,
            isAttachedDialog: true,
        })).toBe('wechat:client_type=x11,window_type=3,has_parent=true,allows_resize=false,attached_dialog=true');
    });

    it('never collapses to a bare application key', () => {
        expect(buildRuleKey('wechat', {hasParent: false})).not.toBe('wechat');
        expect(buildRuleKey('wechat', {hasParent: true, allowsResize: false})).not.toBe('wechat');
    });

    it('empty wmClass returns empty string', () => {
        expect(buildRuleKey('')).toBe('');
        expect(buildRuleKey(null)).toBe('');
    });
});

describe('parseRuleKey', () => {
    const key = 'wechat:client_type=wayland,window_type=0,has_parent=true,allows_resize=false,attached_dialog=false';

    it('parses base wmClass, specifier and typed properties', () => {
        expect(parseRuleKey(key)).toEqual({
            baseWmClass: 'wechat',
            specifier: 'client_type=wayland,window_type=0,has_parent=true,allows_resize=false,attached_dialog=false',
            properties: {
                client_type: 'wayland',
                window_type: 0,
                has_parent: true,
                allows_resize: false,
                attached_dialog: false,
            },
        });
    });

    it('empty or null', () => {
        expect(parseRuleKey('')).toEqual({baseWmClass: '', specifier: null, properties: null});
        expect(parseRuleKey(null)).toEqual({baseWmClass: '', specifier: null, properties: null});
    });

    it('rejects bare app keys and legacy specifiers', () => {
        const invalid = [
            'wechat',
            'wechat:dialog',
            'wechat:title=Exit',
            'wechat:has_parent=true,allows_resize=false',
            'wechat:foo=bar',
            'wechat:client_type=macos,window_type=0,has_parent=false,allows_resize=true,attached_dialog=false',
        ];
        for (const bad of invalid)
            expect(parseRuleKey(bad)).toEqual({baseWmClass: '', specifier: null, properties: null});
    });
});

describe('rule key contract & round-trip', () => {
    it('round-trip: buildRuleKey -> parseRuleKey', () => {
        const keys = [
            buildRuleKey('wechat'),
            buildRuleKey('wechat', {hasParent: true, allowsResize: false}),
            buildRuleKey('steam', {clientType: 'x11', windowType: WindowType.MODAL_DIALOG, isAttachedDialog: true}),
        ];
        for (const key of keys) {
            const parsed = parseRuleKey(key);
            expect(`${parsed.baseWmClass}:${parsed.specifier}`).toBe(key);
        }
    });

    it('escapes identities the key grammar would otherwise split or drop', () => {
        // A bare 'window:5' used to build a key the validator rejected, so the
        // rule was silently discarded instead of ever matching.
        const colonKey = buildRuleKey('window:5');
        expect(colonKey.startsWith('window%3A5:')).toBeTrue();
        expect(parseRuleKey(colonKey).baseWmClass).toBe('window:5');

        const spacedKey = buildRuleKey('my app');
        expect(parseRuleKey(spacedKey).baseWmClass).toBe('my app');
    });

    it('lowercases an identity but changes nothing else about it', () => {
        expect(buildRuleKey('wechat').startsWith('wechat:')).toBeTrue();
        expect(buildRuleKey('org.gnome.Nautilus').startsWith('org.gnome.nautilus:')).toBeTrue();
    });

    it('prefs-generated keys match resolveRule for the picked kind only', () => {
        const picked = {hasParent: true, allowsResize: false};
        const prefsGeneratedRules = {
            suppress: {[buildRuleKey('code', picked)]: 'shadow,corners'},
        };
        expect(resolved(resolveRule('code', prefsGeneratedRules, picked)))
            .toEqual({direction: RuleDirection.SUPPRESS, axes: ['corners', 'shadow']});
        expect(resolveRule('code', prefsGeneratedRules, {hasParent: true, allowsResize: true})).toBeNull();
        expect(resolveRule('code', prefsGeneratedRules)).toBeNull();
    });
});

describe('sanitizeWindowRules', () => {
    const mainKey = buildRuleKey('wechat');
    const childKey = buildRuleKey('wechat', {hasParent: true, allowsResize: false});

    it('passes valid fingerprint keys unchanged', () => {
        const input = {
            suppress: {
                [mainKey]: 'corners',
                [childKey]: 'shadow,corners',
            },
        };
        expect(sanitizeWindowRules(input)).toEqual({
            suppress: {
                [mainKey]: 'corners',
                [childKey]: 'shadow,corners',
            },
            force: {},
        });
    });

    it('drops bare app keys, legacy specifiers and malformed keys', () => {
        const input = {
            suppress: {
                [mainKey]: 'corners',
                'wechat': 'shadow,corners',
                'wechat:dialog': 'shadow,corners',
                'wechat:title=Exit': 'shadow,corners',
                'wechat:has_parent=true,allows_resize=false': 'shadow,corners',
                'invalid:key:too:many:colons': 'shadow,corners',
                'has space:client_type=wayland,window_type=0,has_parent=false,allows_resize=true,attached_dialog=false': 'shadow,corners',
                'bad:client_type=macos,window_type=0,has_parent=false,allows_resize=true,attached_dialog=false': 'shadow,corners',
                [buildRuleKey('valid_app')]: 123,
            },
        };
        expect(sanitizeWindowRules(input)).toEqual({
            suppress: {[mainKey]: 'corners'},
            force: {},
        });
    });

    it('drops entries naming an invalid or legacy rule value', () => {
        const input = {
            suppress: {
                [mainKey]: 'shadow,corners',
                [childKey]: 'not-a-valid-mode',
                [buildRuleKey('legacy-all')]: 'all',
                [buildRuleKey('legacy-clip')]: 'clip',
                [buildRuleKey('legacy-disable')]: 'disable-all',
            },
        };
        expect(sanitizeWindowRules(input)).toEqual({
            suppress: {[mainKey]: 'shadow,corners'},
            force: {},
        });
    });

    it('canonicalises the identity to lowercase when storing it', () => {
        const canonical = buildRuleKey('wechat');
        const asSpelled = `WeChat:${canonical.slice(canonical.indexOf(':') + 1)}`;

        expect(buildRuleKey('WeChat')).toBe(canonical);
        expect(sanitizeWindowRules({suppress: {[asSpelled]: 'corners'}})).toEqual({
            suppress: {[canonical]: 'corners'},
            force: {},
        });
    });

    it('rejects case-colliding duplicate keys deterministically', () => {
        const canonical = buildRuleKey('wechat');
        const asSpelled = `WeChat:${canonical.slice(canonical.indexOf(':') + 1)}`;
        const input = {
            suppress: {
                [asSpelled]: 'corners',
                [canonical]: 'shadow,corners',
            },
        };
        expect(sanitizeWindowRules(input)).toEqual({
            suppress: {[canonical]: 'corners'},
            force: {},
        });
    });

    it('canonicalises axis order in stored values', () => {
        const input = {suppress: {[mainKey]: 'corners,shadow'}};
        expect(sanitizeWindowRules(input)).toEqual({
            suppress: {[mainKey]: 'shadow,corners'},
            force: {},
        });
    });

    it('mutual exclusion: a key in both groups is kept only in suppress', () => {
        const input = {
            suppress: {[mainKey]: 'shadow'},
            force: {[mainKey]: 'corners', [childKey]: 'shadow,corners'},
        };
        expect(sanitizeWindowRules(input)).toEqual({
            suppress: {[mainKey]: 'shadow'},
            force: {[childKey]: 'shadow,corners'},
        });
    });

    it('mutual exclusion holds across spellings of one identity', () => {
        const canonical = buildRuleKey('wechat');
        const asSpelled = `WeChat:${canonical.slice(canonical.indexOf(':') + 1)}`;
        const input = {
            suppress: {[canonical]: 'shadow'},
            force: {[asSpelled]: 'corners'},
        };
        expect(sanitizeWindowRules(input)).toEqual({
            suppress: {[canonical]: 'shadow'},
            force: {},
        });
    });

    it('handles undefined or non-object input as empty groups', () => {
        expect(sanitizeWindowRules(undefined)).toEqual({suppress: {}, force: {}});
        expect(sanitizeWindowRules('string')).toEqual({suppress: {}, force: {}});
        expect(sanitizeWindowRules({})).toEqual({suppress: {}, force: {}});
    });

    it('rejects a null input', () => {
        expect(() => sanitizeWindowRules(null)).toThrow();
    });
});

describe('withRule', () => {
    const key = buildRuleKey('wechat', {hasParent: true});

    it('puts the rule in the named group', () => {
        expect(withRule({}, RuleDirection.FORCE, key, ['shadow'])).toEqual({
            suppress: {},
            force: {[key]: 'shadow'},
        });
    });

    it('takes the kind away from the other group, whatever its casing', () => {
        const stored = buildRuleKey('WeChat', {hasParent: true});
        const moved = withRule({suppress: {[stored]: 'corners'}}, RuleDirection.FORCE, key, ['corners']);

        expect(moved.suppress).toEqual({});
        expect(moved.force).toEqual({[key]: 'corners'});
    });

    it('writes the axes in canonical order', () => {
        const moved = withRule({}, RuleDirection.SUPPRESS, key, ['corners', 'shadow']);
        expect(moved.suppress[key]).toBe(buildRuleValue(RULE_AXIS_ORDER));
    });

    it('leaves the rule groups it was given untouched', () => {
        const rules = {suppress: {[key]: 'shadow'}, force: {}};
        withRule(rules, RuleDirection.FORCE, key, ['corners']);
        expect(rules).toEqual({suppress: {[key]: 'shadow'}, force: {}});
    });
});

