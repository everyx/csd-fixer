/**
 * detector unit tests (jasmine-gjs).
 * Run: pnpm test
 */

import {
    computeInsets, WindowType, isFractionalScale,
    shouldClipWindow,
    isWindowMaximized, isWindowTiled,
    checkDecorationEligibility, inferDecorationBaseline,
    RuleAxis, RuleDirection,
    parseRuleAxes, buildRuleValue,
    resolveRule, evaluateWindowActions,
    parseRuleKey, buildRuleKey, sanitizeWindowRules,
    extractWindowProperties, WindowClientType,
    chooseWindowIdentity, isWindowBackedAppId,
} from '../src/lib/detector.js';
import {MUTTER_CSD_MIN_INSET_THRESHOLD} from '../src/lib/mutterRules.generated.js';
import {
    getWindowRules,
    setWindowRules,
    SETTINGS_KEY_SUPPRESS_RULES,
    SETTINGS_KEY_FORCE_RULES,
} from '../src/lib/settings.js';

/** Per-side margins from a buffer/frame rectangle pair (matches runtime math). */
function marginsFromRects(bufferWidth, bufferHeight, frameWidth, frameHeight) {
    const {w, h} = computeInsets(bufferWidth, bufferHeight, frameWidth, frameHeight);
    return {sideW: w / 2, sideH: h / 2};
}

/** Comparable shape for a resolveRule() result. */
function resolved(result) {
    return result && {direction: result.direction, axes: [...result.axes].sort()};
}

describe('computeInsets', () => {
    it('buffer == frame -> zero insets', () => {
        const {w, h} = computeInsets(400, 300, 400, 300);
        expect(w).toBe(0);
        expect(h).toBe(0);
    });

    it('buffer > frame -> positive insets', () => {
        const {w, h} = computeInsets(400, 300, 360, 260);
        expect(w).toBe(40);
        expect(h).toBe(40);
    });

    it('frame > buffer -> clamps to zero rather than going negative', () => {
        const {w, h} = computeInsets(400, 300, 440, 340);
        expect(w).toBe(0);
        expect(h).toBe(0);
    });
});

describe('checkDecorationEligibility', () => {
    // These are the structural gates: facts about the window that a user rule
    // must never be able to override.
    const base = {
        windowType: WindowType.NORMAL,
        isMaximized: false,
        isFullscreen: false,
        hasSsd: false,
    };

    it('plain normal window -> eligible', () => {
        expect(checkDecorationEligibility(base)).toEqual({eligible: true, reason: ''});
    });

    it('every decoratable window type is eligible', () => {
        for (const windowType of [
            WindowType.NORMAL, WindowType.DIALOG,
            WindowType.MODAL_DIALOG, WindowType.UTILITY,
        ])
            expect(checkDecorationEligibility({...base, windowType}).eligible).toBeTrue();
    });

    it('server-side decorations (SSD, traditional X11 app with system titlebar) -> ineligible', () => {
        const r = checkDecorationEligibility({...base, hasSsd: true});
        expect(r.eligible).toBeFalse();
        expect(r.reason).toBe('has-ssd-frame');
    });

    it('maximized / fullscreen -> ineligible', () => {
        expect(checkDecorationEligibility({...base, isMaximized: true}))
            .toEqual({eligible: false, reason: 'maximized/fullscreen'});
        expect(checkDecorationEligibility({...base, isFullscreen: true}))
            .toEqual({eligible: false, reason: 'maximized/fullscreen'});
    });

    it('non-normal window type -> ineligible and names the offending type', () => {
        const r = checkDecorationEligibility({...base, windowType: WindowType.DOCK});
        expect(r.eligible).toBeFalse();
        expect(r.reason).toBe(`window-type=${WindowType.DOCK}`);
    });

    it('uses sane defaults when called without arguments', () => {
        expect(checkDecorationEligibility()).toEqual({eligible: true, reason: ''});
    });
});

describe('inferDecorationBaseline', () => {
    // Geometric inference: who already paints a shadow, answered per axis.
    const normal = marginsFromRects(400, 300, 400, 300);

    it('non-CSD normal window -> both axes on', () => {
        const r = inferDecorationBaseline(normal);
        expect(r.shadow).toBeTrue();
        expect(r.corners).toBeTrue();
        expect(r.reason).toContain('no-csd');
    });

    it('WeChat article / browser window (XWayland, Chromium 4px resize grip) single side < 8px -> Mutter skips native shadow, baseline decorates', () => {
        // Captured real-world data: buf=[1156, 852], frame=[1148, 844], 4px per edge
        const r = inferDecorationBaseline({
            isX11: true,
            ...marginsFromRects(1156, 852, 1148, 844),
        });
        expect(r.shadow).toBeTrue();
        expect(r.corners).toBeTrue();
        expect(r.reason).toContain('no-csd');
        expect(r.reason).toContain(`4.0x4.0 < ${MUTTER_CSD_MIN_INSET_THRESHOLD}`);
    });

    it('Wayland window with small resize grip (Chromium 4px resize grip) single side < 8px -> detected as lacking CSD, baseline decorates', () => {
        const r = inferDecorationBaseline({
            isX11: false,
            ...marginsFromRects(1156, 852, 1148, 844),
        });
        expect(r.shadow).toBeTrue();
        expect(r.corners).toBeTrue();
        expect(r.reason).toContain('no-csd');
        expect(r.reason).toContain(`4.0x4.0 < ${MUTTER_CSD_MIN_INSET_THRESHOLD}`);
    });

    it('X11 / XWayland windows without frame extents (WPS Office, Dida) -> Mutter C core manages native shadow, baseline off', () => {
        const r = inferDecorationBaseline({isX11: true, ...marginsFromRects(800, 600, 800, 600)});
        expect(r.shadow).toBeFalse();
        expect(r.corners).toBeFalse();
        expect(r.reason).toBe('x11-mutter-native-shadow');
    });

    it('X11 with a small non-zero grip declares custom frame extents -> baseline still decorates', () => {
        const r = inferDecorationBaseline({isX11: true, ...marginsFromRects(808, 604, 800, 600)});
        expect(r.shadow).toBeTrue();
        expect(r.corners).toBeTrue();
        expect(r.reason).toContain('no-csd');
    });

    it('genuine self-drawn CSD shadow (e.g. GTK4/Adwaita, single side 20px+ >= 8px) -> baseline off', () => {
        // Margins: 20px left/right (bufferWidth=440, frameWidth=400), 20px top/bottom
        const r = inferDecorationBaseline(marginsFromRects(440, 340, 400, 300));
        expect(r.shadow).toBeFalse();
        expect(r.corners).toBeFalse();
        expect(r.reason).toContain('has-csd');
        expect(r.reason).toContain(`20.0x20.0 >= ${MUTTER_CSD_MIN_INSET_THRESHOLD}`);
    });

    it('oversized margin on a single axis (asymmetric) is not treated as a CSD shadow -> baseline decorates', () => {
        const r = inferDecorationBaseline(marginsFromRects(440, 300, 400, 300));
        expect(r.shadow).toBeTrue();
        expect(r.corners).toBeTrue();
        expect(r.reason).toContain('no-csd');
    });

    it('honours an explicit inset threshold', () => {
        const margins = marginsFromRects(410, 310, 400, 300); // single side 5px
        expect(inferDecorationBaseline({...margins, insetThreshold: 4}).reason).toContain('has-csd');
        expect(inferDecorationBaseline({...margins, insetThreshold: 8}).reason).toContain('no-csd');
    });
});

describe('isFractionalScale', () => {
    it('integer scales (1, 2, 3) -> not fractional', () => {
        expect(isFractionalScale(1.0)).toBeFalse();
        expect(isFractionalScale(2.0)).toBeFalse();
        expect(isFractionalScale(3.0)).toBeFalse();
    });

    it('common fractional scales (1.25, 1.333333, 1.5, 1.75) -> fractional', () => {
        expect(isFractionalScale(1.25)).toBeTrue();
        expect(isFractionalScale(1.333333)).toBeTrue();
        expect(isFractionalScale(1.5)).toBeTrue();
        expect(isFractionalScale(1.75)).toBeTrue();
        expect(isFractionalScale(2.25)).toBeTrue();
    });

    it('non-number or abnormal scale -> conservatively not fractional', () => {
        expect(isFractionalScale(null)).toBeFalse();
        expect(isFractionalScale(undefined)).toBeFalse();
        expect(isFractionalScale(0)).toBeFalse();
        expect(isFractionalScale(-1)).toBeFalse();
        expect(isFractionalScale(NaN)).toBeFalse();
    });
});

describe('shouldClipWindow', () => {
    it('preferCrispText=false (default) always enables rounded corner clipping', () => {
        expect(shouldClipWindow({preferCrispText: false, scale: 1.0})).toBeTrue();
        expect(shouldClipWindow({preferCrispText: false, scale: 1.333333})).toBeTrue();
        expect(shouldClipWindow({preferCrispText: false, scale: 2.0})).toBeTrue();
    });

    it('preferCrispText=true skips corner clipping on fractional scale displays, retains on integer scale displays', () => {
        // Integer scale displays retain
        expect(shouldClipWindow({preferCrispText: true, scale: 1.0})).toBeTrue();
        expect(shouldClipWindow({preferCrispText: true, scale: 2.0})).toBeTrue();
        // Fractional scale displays skip
        expect(shouldClipWindow({preferCrispText: true, scale: 1.25})).toBeFalse();
        expect(shouldClipWindow({preferCrispText: true, scale: 1.333333})).toBeFalse();
        expect(shouldClipWindow({preferCrispText: true, scale: 1.5})).toBeFalse();
        expect(shouldClipWindow({preferCrispText: true, scale: 1.75})).toBeFalse();
    });
});

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

    it('case-insensitive wmClass match in both directions', () => {
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

    it('leaves ordinary identities byte-for-byte', () => {
        expect(buildRuleKey('wechat').startsWith('wechat:')).toBeTrue();
        expect(buildRuleKey('org.gnome.Nautilus').startsWith('org.gnome.Nautilus:')).toBeTrue();
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

    it('rejects case-colliding duplicate keys deterministically', () => {
        const input = {
            suppress: {
                [buildRuleKey('wechat')]: 'corners',
                [buildRuleKey('WeChat')]: 'shadow,corners',
            },
        };
        expect(sanitizeWindowRules(input)).toEqual({
            suppress: {[buildRuleKey('wechat')]: 'corners'},
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

    it('mutual exclusion is case-insensitive across groups', () => {
        const input = {
            suppress: {[buildRuleKey('wechat')]: 'shadow'},
            force: {[buildRuleKey('WeChat')]: 'corners'},
        };
        expect(sanitizeWindowRules(input)).toEqual({
            suppress: {[buildRuleKey('wechat')]: 'shadow'},
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
});

describe('evaluateWindowActions', () => {
    const baseWin = {
        bufferWidth: 400, bufferHeight: 300,
        frameWidth: 400, frameHeight: 300,
        monitorScale: 1,
        isX11: false,
        windowType: WindowType.NORMAL,
        wmClass: 'test-app',
    };

    it('default normal non-CSD window: both shadow and clip enabled', () => {
        const res = evaluateWindowActions(baseWin);
        expect(res.applyShadow).toBeTrue();
        expect(res.applyClip).toBeTrue();
        expect(res.reason).toContain('no-csd');
    });

    it('X11 window without frame extents (WPS, dida): skips both shadow and clip due to native Mutter shadow', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            isX11: true,
            wmClass: 'wps',
        });
        expect(res.applyShadow).toBeFalse();
        expect(res.applyClip).toBeFalse();
        expect(res.reason).toBe('x11-mutter-native-shadow');
    });

    it('X11 window with small frame extents (WeChat 4px resize grip): decorates with shadow and clip', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            isX11: true,
            wmClass: 'wechat',
            bufferWidth: 1156, bufferHeight: 852,
            frameWidth: 1148, frameHeight: 844,
        });
        expect(res.applyShadow).toBeTrue();
        expect(res.applyClip).toBeTrue();
        expect(res.reason).toContain('no-csd');
    });

    it('suppress rule naming both axes: both shadow and clip disabled', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            wmClass: 'overlay-app',
            rules: {suppress: {[buildRuleKey('overlay-app')]: 'shadow,corners'}},
        });
        expect(res.applyShadow).toBeFalse();
        expect(res.applyClip).toBeFalse();
        expect(res.reason).toContain('rule-applied');
    });

    it('suppress rule naming corners: retains shadow, disables clip', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            wmClass: 'wechat',
            rules: {suppress: {[buildRuleKey('wechat')]: 'corners'}},
        });
        expect(res.applyShadow).toBeTrue();
        expect(res.applyClip).toBeFalse();
        expect(res.reason).toContain('rule-applied');
    });

    it('suppress rule naming shadow: disables shadow, retains clip', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            wmClass: 'custom-tool',
            rules: {suppress: {[buildRuleKey('custom-tool')]: 'shadow'}},
        });
        expect(res.applyShadow).toBeFalse();
        expect(res.applyClip).toBeTrue();
        expect(res.reason).toContain('rule-applied');
    });

    it('suppression wins over a force rule for the same window kind', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            wmClass: 'wechat',
            rules: {
                suppress: {[buildRuleKey('wechat')]: 'corners'},
                force: {[buildRuleKey('wechat')]: 'shadow,corners'},
            },
        });
        expect(res.applyShadow).toBeTrue();
        expect(res.applyClip).toBeFalse();
        expect(res.reason).toBe('rule-applied(wechat:suppress:corners)');
    });

    it('CSD window (GTK4): no decorations applied regardless of suppress rules', () => {
        const csdWin = {
            ...baseWin,
            bufferWidth: 460, bufferHeight: 360, // single side 30px >= 8px
            wmClass: 'gtk4-app',
            rules: {suppress: {[buildRuleKey('gtk4-app')]: 'corners'}},
        };
        const res = evaluateWindowActions(csdWin);
        expect(res.applyShadow).toBeFalse();
        expect(res.applyClip).toBeFalse();
    });

    it('CSD window (GTK4): the has-csd baseline reason surfaces when no rule matches', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            bufferWidth: 460, bufferHeight: 360, // single side 30px >= 8px
            wmClass: 'gtk4-app',
        });
        expect(res.applyShadow).toBeFalse();
        expect(res.applyClip).toBeFalse();
        expect(res.reason).toContain('has-csd');
    });

    it('force rule re-enables both axes on a has-csd baseline', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            bufferWidth: 460, bufferHeight: 360, // has-csd baseline: both off
            wmClass: 'gtk4-app',
            rules: {force: {[buildRuleKey('gtk4-app')]: 'shadow,corners'}},
        });
        expect(res.applyShadow).toBeTrue();
        expect(res.applyClip).toBeTrue();
        expect(res.reason).toBe('rule-applied(gtk4-app:force:shadow,corners)');
    });

    it('force rule re-enables both axes on an x11-mutter-native-shadow baseline', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            isX11: true,
            wmClass: 'wps',
            rules: {force: {[buildRuleKey('wps', {clientType: 'x11'})]: 'shadow,corners'}},
        });
        expect(res.applyShadow).toBeTrue();
        expect(res.applyClip).toBeTrue();
        expect(res.reason).toContain('rule-applied');
    });

    it('per-axis force: corners turned ON while shadow keeps the inferred baseline', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            bufferWidth: 460, bufferHeight: 360, // has-csd baseline: shadow=false, corners=false
            wmClass: 'gtk4-app',
            rules: {force: {[buildRuleKey('gtk4-app')]: 'corners'}},
        });
        expect(res.applyShadow).toBeFalse();
        expect(res.applyClip).toBeTrue();
        expect(res.reason).toBe('rule-applied(gtk4-app:force:corners)');
    });

    it('per-axis force: shadow turned ON while corners keeps the inferred baseline', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            isX11: true,
            wmClass: 'wps',
            rules: {force: {[buildRuleKey('wps', {clientType: 'x11'})]: 'shadow'}},
        });
        expect(res.applyShadow).toBeTrue();
        expect(res.applyClip).toBeFalse();
        expect(res.reason).toBe('rule-applied(wps:force:shadow)');
    });

    it('force rules cannot override structural ineligibility: maximized', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            isMaximized: true,
            wmClass: 'wechat',
            rules: {force: {[buildRuleKey('wechat')]: 'shadow,corners'}},
        });
        expect(res.applyShadow).toBeFalse();
        expect(res.applyClip).toBeFalse();
        expect(res.reason).toBe('maximized/fullscreen');
    });

    it('force rules cannot override structural ineligibility: fullscreen', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            isFullscreen: true,
            wmClass: 'wechat',
            rules: {force: {[buildRuleKey('wechat')]: 'shadow,corners'}},
        });
        expect(res.applyShadow).toBeFalse();
        expect(res.applyClip).toBeFalse();
        expect(res.reason).toBe('maximized/fullscreen');
    });

    it('force rules cannot override structural ineligibility: non-normal window type', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            windowType: WindowType.DOCK,
            wmClass: 'dock-app',
            rules: {force: {[buildRuleKey('dock-app', {windowType: WindowType.DOCK})]: 'shadow,corners'}},
        });
        expect(res.applyShadow).toBeFalse();
        expect(res.applyClip).toBeFalse();
        expect(res.reason).toBe(`window-type=${WindowType.DOCK}`);
    });

    it('force rules cannot override structural ineligibility: SSD', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            hasSsd: true,
            wmClass: 'legacy-x11',
            rules: {force: {[buildRuleKey('legacy-x11')]: 'shadow,corners'}},
        });
        expect(res.applyShadow).toBeFalse();
        expect(res.applyClip).toBeFalse();
        expect(res.reason).toBe('has-ssd-frame');
    });

    it('preferCrispText retains rounded corners on integer scale displays (1.0x, 2.0x)', () => {
        const res1 = evaluateWindowActions({
            ...baseWin,
            monitorScale: 1.0,
            preferCrispText: true,
        });
        expect(res1.applyShadow).toBeTrue();
        expect(res1.applyClip).toBeTrue();

        const res2 = evaluateWindowActions({
            ...baseWin,
            monitorScale: 2.0,
            preferCrispText: true,
        });
        expect(res2.applyShadow).toBeTrue();
        expect(res2.applyClip).toBeTrue();
    });

    it('preferCrispText skips corner clipping on fractional scale displays (1.25x, 1.333x, 1.5x) while retaining shadow', () => {
        for (const fracScale of [1.25, 1.333333, 1.5, 1.75]) {
            const res = evaluateWindowActions({
                ...baseWin,
                monitorScale: fracScale, // monitor physical scale
                preferCrispText: true,
            });
            expect(res.applyShadow).toBeTrue();
            expect(res.applyClip).toBeFalse();
        }
    });

    it('preferCrispText disabled retains rounded corners on fractional scale displays', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            monitorScale: 1.333333,
            preferCrispText: false,
        });
        expect(res.applyShadow).toBeTrue();
        expect(res.applyClip).toBeTrue();
    });

    it('rule for one window kind leaves other kinds of the same app decorated', () => {
        const rules = {
            suppress: {
                [buildRuleKey('wechat', {hasParent: true, allowsResize: false})]: 'shadow,corners',
            },
        };

        // Main window (top-level, resizable) is a different kind -> untouched
        const mainWin = evaluateWindowActions({
            ...baseWin,
            wmClass: 'wechat',
            hasParent: false,
            allowsResize: true,
            rules,
        });
        expect(mainWin.applyShadow).toBeTrue();
        expect(mainWin.applyClip).toBeTrue();

        // Fixed child dialog matches the rule
        const dialogWin = evaluateWindowActions({
            ...baseWin,
            wmClass: 'wechat',
            hasParent: true,
            allowsResize: false,
            rules,
        });
        expect(dialogWin.applyShadow).toBeFalse();
        expect(dialogWin.applyClip).toBeFalse();
        expect(dialogWin.reason).toContain('rule-applied');

        // Resizable child of the same app is a different kind -> untouched
        const resizableChild = evaluateWindowActions({
            ...baseWin,
            wmClass: 'wechat',
            hasParent: true,
            allowsResize: true,
            rules,
        });
        expect(resizableChild.applyShadow).toBeTrue();
        expect(resizableChild.applyClip).toBeTrue();
    });

    it('client type is part of the window kind: an X11 window does not match a Wayland rule', () => {
        const rules = {
            suppress: {
                [buildRuleKey('wechat', {clientType: 'wayland', hasParent: true, allowsResize: false})]: 'shadow,corners',
            },
        };

        const waylandChild = evaluateWindowActions({
            ...baseWin,
            wmClass: 'wechat',
            isX11: false,
            hasParent: true,
            allowsResize: false,
            rules,
        });
        expect(waylandChild.applyShadow).toBeFalse();

        // XWayland variant with 4px frame extents: decorated, because the stored
        // rule targets the Wayland kind only.
        const x11Child = evaluateWindowActions({
            ...baseWin,
            wmClass: 'wechat',
            isX11: true,
            bufferWidth: 408,
            bufferHeight: 304,
            hasParent: true,
            allowsResize: false,
            rules,
        });
        expect(x11Child.applyShadow).toBeTrue();
        expect(x11Child.applyClip).toBeTrue();
    });

    it('GNOME tiling alignment: hasTileMatch suppresses shadow to prevent adjacent window obstruction', () => {
        // Aligns with Mutter meta-window-actor-x11.c:392
        const snapTiledWin = evaluateWindowActions({
            ...baseWin,
            isMaximized: false,
            hasTileMatch: true,
        });
        expect(snapTiledWin.applyShadow).toBeFalse();
        expect(snapTiledWin.applyClip).toBeTrue();
        expect(snapTiledWin.reason).toContain('tile-match(suppress-shadow');
    });

    it('GNOME tiling alignment: single tiled window without match retains shadow', () => {
        const singleTiledWin = evaluateWindowActions({
            ...baseWin,
            isMaximized: false,
            hasTileMatch: false,
        });
        expect(singleTiledWin.applyShadow).toBeTrue();
        expect(singleTiledWin.applyClip).toBeTrue();
    });

    it('GNOME tiling alignment: full maximized window skips all decorations', () => {
        const maximizedWin = evaluateWindowActions({
            ...baseWin,
            isMaximized: true,
            hasTileMatch: false,
        });
        expect(maximizedWin.applyShadow).toBeFalse();
        expect(maximizedWin.applyClip).toBeFalse();
        expect(maximizedWin.reason).toBe('maximized/fullscreen');
    });
});

describe('isWindowMaximized', () => {
    it('uses win.is_maximized() canonical method', () => {
        const winTrue = {
            is_maximized: () => true,
        };
        expect(isWindowMaximized(winTrue)).toBeTrue();

        const winFalse = {
            is_maximized: () => false,
        };
        expect(isWindowMaximized(winFalse)).toBeFalse();
    });

    it('handles null/undefined gracefully', () => {
        expect(isWindowMaximized(null)).toBeFalse();
        expect(isWindowMaximized(undefined)).toBeFalse();
        expect(isWindowMaximized({})).toBeFalse();
    });
});

describe('isWindowTiled', () => {
    it('returns false for fully maximized window', () => {
        const win = {
            is_maximized: () => true,
            maximized_horizontally: true,
            maximized_vertically: true,
            get_tile_match: () => ({}),
        };
        expect(isWindowTiled(win)).toBeFalse();
        expect(isWindowTiled(win, {isMaximized: true})).toBeFalse();
    });

    it('returns true for single-axis half-tiled window (hMax !== vMax)', () => {
        const winSnapLeft = {
            is_maximized: () => false,
            maximized_horizontally: false,
            maximized_vertically: true,
        };
        expect(isWindowTiled(winSnapLeft)).toBeTrue();

        const winSnapTop = {
            is_maximized: () => false,
            maximized_horizontally: true,
            maximized_vertically: false,
        };
        expect(isWindowTiled(winSnapTop)).toBeTrue();
    });

    it('returns true when get_tile_match() returns an adjacent window', () => {
        const winWithMatch = {
            is_maximized: () => false,
            maximized_horizontally: false,
            maximized_vertically: false,
            get_tile_match: () => ({title: 'Adjacent Window'}),
        };
        expect(isWindowTiled(winWithMatch)).toBeTrue();
    });

    it('returns false for normal non-tiled floating window', () => {
        const floatingWin = {
            is_maximized: () => false,
            maximized_horizontally: false,
            maximized_vertically: false,
            get_tile_match: () => null,
        };
        expect(isWindowTiled(floatingWin)).toBeFalse();
    });

    it('handles null/undefined gracefully', () => {
        expect(isWindowTiled(null)).toBeFalse();
        expect(isWindowTiled(undefined)).toBeFalse();
    });
});

describe('extractWindowProperties', () => {
    it('extracts the full window-kind fingerprint inputs', () => {
        const mockWin = {
            get_wm_class: () => 'com.tencent.wechat',
            get_window_type: () => WindowType.NORMAL,
            get_client_type: () => WindowClientType.WAYLAND,
            get_transient_for: () => ({}),
            allows_resize: () => false,
            is_attached_dialog: () => false,
        };
        expect(extractWindowProperties(mockWin)).toEqual({
            wmClass: 'com.tencent.wechat',
            clientType: 'wayland',
            windowType: '0',
            hasParent: 'true',
            allowsResize: 'false',
            isAttachedDialog: 'false',
        });
    });

    it('marks X11 clients and encodes every boolean field', () => {
        const x11Win = {
            get_wm_class: () => 'wechat',
            get_window_type: () => WindowType.MODAL_DIALOG,
            get_client_type: () => WindowClientType.X11,
            get_transient_for: () => null,
            allows_resize: () => true,
            is_attached_dialog: () => true,
        };
        expect(extractWindowProperties(x11Win)).toEqual({
            wmClass: 'wechat',
            clientType: 'x11',
            windowType: String(WindowType.MODAL_DIALOG),
            hasParent: 'false',
            allowsResize: 'true',
            isAttachedDialog: 'true',
        });
    });

    it('falls back to get_sandboxed_app_id when wm_class is unavailable', () => {
        const flatpakWin = {
            get_sandboxed_app_id: () => 'org.signal.Signal',
            get_transient_for: () => null,
            allows_resize: () => true,
        };
        expect(extractWindowProperties(flatpakWin).wmClass).toBe('org.signal.Signal');
    });

    it('accepts a pre-resolved wmClass override (Shell.WindowTracker fallback for WM_CLASS-less windows)', () => {
        const noWmClassWin = {
            get_wm_class: () => null,
            get_transient_for: () => null,
        };
        expect(extractWindowProperties(noWmClassWin, 'wechat').wmClass).toBe('wechat');
    });

    it('handles null and undefined safely', () => {
        expect(extractWindowProperties(null)).toEqual({});
        expect(extractWindowProperties(undefined)).toEqual({});
    });
});

describe('chooseWindowIdentity', () => {
    it('prefers what the window declares itself', () => {
        const chosen = chooseWindowIdentity({declared: 'wechat', peer: 'other', tracked: 'x.desktop', pid: 1});
        expect(chosen).toBe('wechat');
    });

    it('falls back to a sibling process window when the window declares nothing', () => {
        const chosen = chooseWindowIdentity({peer: 'wechat', tracked: 'snap.wechat', pid: 1});
        expect(chosen).toBe('wechat');
    });

    it('uses the tracker id when it names a real application', () => {
        expect(chooseWindowIdentity({tracked: 'wechat.desktop', pid: 42})).toBe('wechat.desktop');
    });

    it('rejects Shell window-backed placeholder ids', () => {
        expect(isWindowBackedAppId('window:5')).toBeTrue();
        expect(isWindowBackedAppId('wechat.desktop')).toBeFalse();
        expect(chooseWindowIdentity({tracked: 'window:5', pid: 42})).toBe('pid-42');
    });

    it('falls back to a process identity when nothing names the application', () => {
        expect(chooseWindowIdentity({pid: 42})).toBe('pid-42');
    });

    it('returns empty when nothing identifies the window', () => {
        expect(chooseWindowIdentity({})).toBe('');
        expect(chooseWindowIdentity({pid: -1})).toBe('');
    });
});
