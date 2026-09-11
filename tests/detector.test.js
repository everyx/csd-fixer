/**
 * detector unit tests (jasmine-gjs).
 * Run: pnpm test
 */

import {
    shouldDecorate, computeInsets, WindowType, isFractionalScale,
    shouldClipWindow, ExclusionTarget, normalizeRuleMode,
    isWindowMaximized, isWindowTiled,
    resolveRule, evaluateWindowActions,
    parseRuleKey, buildRuleKey, sanitizeWindowRules,
    extractWindowProperties, WindowClientType,
    chooseWindowIdentity, isWindowBackedAppId,
} from '../src/lib/detector.js';
import {
    getWindowRules,
    setWindowRules,
} from '../src/lib/settings.js';

describe('computeInsets', () => {
    it('buffer == frame (scale = 1) -> zero insets', () => {
        const {w, h} = computeInsets(400, 300, 400, 300, 1);
        expect(w).toBe(0);
        expect(h).toBe(0);
    });

    it('buffer > frame (scale = 1) -> positive insets', () => {
        const {w, h} = computeInsets(400, 300, 360, 260, 1);
        expect(w).toBe(40);
        expect(h).toBe(40);
    });

    it('fractional scaling: compares after dividing physical buffer by scale', () => {
        // 2x HiDPI: non-CSD window buffer=800x600, frame=400x300
        const {w, h} = computeInsets(800, 600, 400, 300, 2);
        expect(w).toBe(0);
        expect(h).toBe(0);
        // 2x + CSD 20px insets
        const {w: w2} = computeInsets(840, 640, 400, 300, 2);
        expect(w2).toBe(20);
    });
});

describe('shouldDecorate', () => {
    const base = {
        bufferWidth: 400, bufferHeight: 300,
        frameWidth: 400, frameHeight: 300,
        scale: 1,
        isX11: false, skipXwayland: false,
        isMaximized: false, isFullscreen: false,
        hasSsd: false,
        windowType: WindowType.NORMAL,
        wmClass: 'test-app',
    };

    it('non-CSD normal window -> decorate', () => {
        const r = shouldDecorate(base);
        expect(r.apply).toBeTrue();
        expect(r.reason).toContain('no-csd');
    });

    it('WeChat article / browser window (XWayland, Chromium 4px resize grip) single side < 8px -> Mutter skips native shadow, decorate', () => {
        // Captured real-world data: buf=[1156, 852], frame=[1148, 844], 4px per edge
        const r = shouldDecorate({
            ...base,
            isX11: true,
            wmClass: null,
            bufferWidth: 1156, bufferHeight: 852,
            frameWidth: 1148, frameHeight: 844,
        });
        expect(r.apply).toBeTrue();
        expect(r.reason).toContain('no-csd');
        expect(r.reason).toContain('4.0x4.0 < 8');
    });

    it('Wayland window with small resize grip (Chromium 4px resize grip) single side < 8px -> detected as lacking CSD, decorate', () => {
        const r = shouldDecorate({
            ...base,
            isX11: false,
            wmClass: null,
            bufferWidth: 1156, bufferHeight: 852,
            frameWidth: 1148, frameHeight: 844,
        });
        expect(r.apply).toBeTrue();
        expect(r.reason).toContain('no-csd');
        expect(r.reason).toContain('4.0x4.0 < 8');
    });

    it('X11 / XWayland windows without frame extents (WPS Office, Dida) -> Mutter C core manages native shadow, skip', () => {
        const r = shouldDecorate({
            ...base,
            isX11: true,
            bufferWidth: 800, bufferHeight: 600,
            frameWidth: 800, frameHeight: 600,
        });
        expect(r.apply).toBeFalse();
        expect(r.reason).toBe('x11-mutter-native-shadow');
    });

    it('genuine self-drawn CSD shadow (e.g. GTK4/Adwaita, single side 20px+ >= 8px) -> skip', () => {
        // Margins: 20px left/right (bufferWidth=440, frameWidth=400), 20px top/bottom
        const r = shouldDecorate({
            ...base,
            bufferWidth: 440, bufferHeight: 340,
            frameWidth: 400, frameHeight: 300,
        });
        expect(r.apply).toBeFalse();
        expect(r.reason).toContain('has-csd');
        expect(r.reason).toContain('20.0x20.0 >= 8');
    });

    it('oversized margin on a single axis (asymmetric) is not treated as a CSD shadow -> decorate', () => {
        const r = shouldDecorate({
            ...base,
            bufferWidth: 440, bufferHeight: 300,
            frameWidth: 400, frameHeight: 300,
        });
        expect(r.apply).toBeTrue();
        expect(r.reason).toContain('no-csd');
    });

    it('server-side decorations (SSD, traditional X11 app with system titlebar) -> skip', () => {
        const r = shouldDecorate({...base, hasSsd: true});
        expect(r.apply).toBeFalse();
        expect(r.reason).toBe('has-ssd-frame');
    });

    it('maximized / fullscreen -> skip', () => {
        expect(shouldDecorate({...base, isMaximized: true}).apply).toBeFalse();
        expect(shouldDecorate({...base, isFullscreen: true}).apply).toBeFalse();
    });

    it('non-normal window type -> skip', () => {
        expect(shouldDecorate({...base, windowType: WindowType.DOCK}).apply).toBeFalse();
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

describe('resolveRule', () => {
    const mainKey = buildRuleKey('wechat');
    const fixedChildKey = buildRuleKey('wechat', {hasParent: true, allowsResize: false});

    it('exact fingerprint match', () => {
        const rules = {
            [mainKey]: ExclusionTarget.CLIP,
            [fixedChildKey]: ExclusionTarget.ALL,
        };
        expect(resolveRule('wechat', rules)).toBe(ExclusionTarget.CLIP);
        expect(resolveRule('wechat', rules, {hasParent: true, allowsResize: false})).toBe(ExclusionTarget.ALL);
    });

    it('does not fall back to the application: a different window kind of the same app does not match', () => {
        const rules = {[fixedChildKey]: ExclusionTarget.ALL};

        expect(resolveRule('wechat', rules)).toBeNull();
        expect(resolveRule('wechat', rules, {hasParent: true, allowsResize: true})).toBeNull();
        expect(resolveRule('wechat', rules, {clientType: 'x11', hasParent: true, allowsResize: false})).toBeNull();
        expect(resolveRule('wechat', rules, {windowType: WindowType.DIALOG, hasParent: true, allowsResize: false})).toBeNull();
    });

    it('case-insensitive wmClass match in both directions', () => {
        const upperRule = buildRuleKey('WeChat', {hasParent: true, allowsResize: false});
        expect(resolveRule('wechat', {[upperRule]: ExclusionTarget.ALL}, {hasParent: true, allowsResize: false})).toBe(ExclusionTarget.ALL);

        const lowerRule = buildRuleKey('wechat', {hasParent: true, allowsResize: false});
        expect(resolveRule('WeChat', {[lowerRule]: ExclusionTarget.ALL}, {hasParent: true, allowsResize: false})).toBe(ExclusionTarget.ALL);
    });

    it('no match returns null', () => {
        expect(resolveRule('unknown-app', {[mainKey]: ExclusionTarget.ALL})).toBeNull();
        expect(resolveRule(null, {[mainKey]: ExclusionTarget.ALL})).toBeNull();
        expect(resolveRule('', {[mainKey]: ExclusionTarget.ALL})).toBeNull();
    });

    it('every fingerprint field participates in matching', () => {
        const base = buildRuleKey('app', {
            clientType: 'wayland', windowType: WindowType.NORMAL,
            hasParent: true, allowsResize: false, isAttachedDialog: false,
        });
        const rules = {[base]: ExclusionTarget.ALL};

        expect(resolveRule('app', rules, {hasParent: true, allowsResize: false})).toBe(ExclusionTarget.ALL);
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
            [buildRuleKey('code', picked)]: ExclusionTarget.ALL,
        };
        expect(resolveRule('code', prefsGeneratedRules, picked)).toBe(ExclusionTarget.ALL);
        expect(resolveRule('code', prefsGeneratedRules, {hasParent: true, allowsResize: true})).toBeNull();
        expect(resolveRule('code', prefsGeneratedRules)).toBeNull();
    });
});

describe('sanitizeWindowRules', () => {
    const mainKey = buildRuleKey('wechat');
    const childKey = buildRuleKey('wechat', {hasParent: true, allowsResize: false});

    it('passes valid fingerprint keys unchanged', () => {
        const input = {
            [mainKey]: ExclusionTarget.CLIP,
            [childKey]: ExclusionTarget.ALL,
        };
        expect(sanitizeWindowRules(input)).toEqual(input);
    });

    it('drops bare app keys, legacy specifiers and malformed keys', () => {
        const input = {
            [mainKey]: ExclusionTarget.CLIP,
            'wechat': ExclusionTarget.ALL,
            'wechat:dialog': ExclusionTarget.ALL,
            'wechat:title=Exit': ExclusionTarget.ALL,
            'wechat:has_parent=true,allows_resize=false': ExclusionTarget.ALL,
            'invalid:key:too:many:colons': ExclusionTarget.ALL,
            'has space:client_type=wayland,window_type=0,has_parent=false,allows_resize=true,attached_dialog=false': ExclusionTarget.ALL,
            'bad:client_type=macos,window_type=0,has_parent=false,allows_resize=true,attached_dialog=false': ExclusionTarget.ALL,
            [buildRuleKey('valid_app')]: 123,
        };
        expect(sanitizeWindowRules(input)).toEqual({[mainKey]: ExclusionTarget.CLIP});
    });

    it('rejects case-colliding duplicate keys deterministically', () => {
        const input = {
            [buildRuleKey('wechat')]: ExclusionTarget.CLIP,
            [buildRuleKey('WeChat')]: ExclusionTarget.ALL,
        };
        expect(sanitizeWindowRules(input)).toEqual({
            [buildRuleKey('wechat')]: ExclusionTarget.CLIP,
        });
    });

    it('migrates legacy disable-* rule modes to canonical forms', () => {
        const legacyInput = {
            [mainKey]: 'disable-clip',
            [childKey]: 'disable-all',
        };
        expect(sanitizeWindowRules(legacyInput)).toEqual({
            [mainKey]: ExclusionTarget.CLIP,
            [childKey]: ExclusionTarget.ALL,
        });
    });

    it('drops entries with invalid rule modes', () => {
        const input = {
            [mainKey]: ExclusionTarget.CLIP,
            [buildRuleKey('bad-app')]: 'not-a-valid-mode',
        };
        expect(sanitizeWindowRules(input)).toEqual({
            [mainKey]: ExclusionTarget.CLIP,
        });
    });

    it('handles null, undefined, or non-object input gracefully', () => {
        expect(sanitizeWindowRules(null)).toEqual({});
        expect(sanitizeWindowRules(undefined)).toEqual({});
        expect(sanitizeWindowRules('string')).toEqual({});
    });
});

describe('getWindowRules', () => {
    const validKey = buildRuleKey('wechat', {hasParent: true, allowsResize: false});

    it('unpacks and sanitizes from mock settings', () => {
        const mockSettings = {
            get_value: (key) => {
                if (key === 'window-rules') {
                    return {
                        deep_unpack: () => ({
                            [validKey]: 'disable-clip',
                            'bad:foo=bar': 'all',
                        }),
                    };
                }
                return null;
            },
        };
        expect(getWindowRules(mockSettings)).toEqual({
            [validKey]: ExclusionTarget.CLIP,
        });
    });

    it('returns empty object on null or throwing settings', () => {
        expect(getWindowRules(null)).toEqual({});
        expect(getWindowRules({})).toEqual({});
        expect(getWindowRules({
            get_value: () => {
                throw new Error('boom');
            },
        })).toEqual({});
    });

    it('setWindowRules sanitizes and serializes into GSettings variant', () => {
        let savedKey = null;
        let savedVariant = null;
        const mockSettings = {
            set_value: (key, val) => {
                savedKey = key;
                savedVariant = val;
            },
        };
        setWindowRules(mockSettings, {
            [buildRuleKey('wechat')]: 'all',
            'invalid:key': 'clip',
        });
        expect(savedKey).toBe('window-rules');
        expect(savedVariant.deep_unpack()).toEqual({
            [buildRuleKey('wechat')]: ExclusionTarget.ALL,
        });
    });
});

describe('normalizeRuleMode', () => {
    it('returns canonical modes as-is', () => {
        expect(normalizeRuleMode('all')).toBe('all');
        expect(normalizeRuleMode('clip')).toBe('clip');
        expect(normalizeRuleMode('shadow')).toBe('shadow');
    });

    it('maps legacy disable-* modes to canonical modes', () => {
        expect(normalizeRuleMode('disable-all')).toBe('all');
        expect(normalizeRuleMode('disable-clip')).toBe('clip');
        expect(normalizeRuleMode('disable-shadow')).toBe('shadow');
    });

    it('is case-insensitive', () => {
        expect(normalizeRuleMode('ALL')).toBe('all');
        expect(normalizeRuleMode('Disable-Clip')).toBe('clip');
        expect(normalizeRuleMode('DISABLE-SHADOW')).toBe('shadow');
    });

    it('returns null for invalid modes', () => {
        expect(normalizeRuleMode('invalid')).toBeNull();
        expect(normalizeRuleMode('')).toBeNull();
        expect(normalizeRuleMode(null)).toBeNull();
        expect(normalizeRuleMode(undefined)).toBeNull();
    });
});

describe('evaluateWindowActions', () => {
    const baseWin = {
        bufferWidth: 400, bufferHeight: 300,
        frameWidth: 400, frameHeight: 300,
        geometryScale: 1,
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

    it('disable-all rule: both shadow and clip disabled', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            wmClass: 'overlay-app',
            windowRules: {[buildRuleKey('overlay-app')]: ExclusionTarget.ALL},
        });
        expect(res.applyShadow).toBeFalse();
        expect(res.applyClip).toBeFalse();
        expect(res.reason).toContain('disabled-by-rule');
    });

    it('disable-clip rule: retains shadow, disables clip', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            wmClass: 'wechat',
            windowRules: {[buildRuleKey('wechat')]: ExclusionTarget.CLIP},
        });
        expect(res.applyShadow).toBeTrue();
        expect(res.applyClip).toBeFalse();
        expect(res.reason).toContain('rule-applied');
    });

    it('disable-shadow rule: disables shadow, retains clip', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            wmClass: 'custom-tool',
            windowRules: {[buildRuleKey('custom-tool')]: ExclusionTarget.SHADOW},
        });
        expect(res.applyShadow).toBeFalse();
        expect(res.applyClip).toBeTrue();
        expect(res.reason).toContain('rule-applied');
    });

    it('CSD window (GTK4): no decorations applied regardless of rules', () => {
        const csdWin = {
            ...baseWin,
            bufferWidth: 460, bufferHeight: 360, // single side 30px >= 8px
            wmClass: 'gtk4-app',
            windowRules: {[buildRuleKey('gtk4-app')]: ExclusionTarget.CLIP},
        };
        const res = evaluateWindowActions(csdWin);
        expect(res.applyShadow).toBeFalse();
        expect(res.applyClip).toBeFalse();
        expect(res.reason).toContain('has-csd');
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
                geometryScale: 1, // actor geometry scale is typically 1
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
            geometryScale: 1,
            monitorScale: 1.333333,
            preferCrispText: false,
        });
        expect(res.applyShadow).toBeTrue();
        expect(res.applyClip).toBeTrue();
    });

    it('rule for one window kind leaves other kinds of the same app decorated', () => {
        const rules = {
            [buildRuleKey('wechat', {hasParent: true, allowsResize: false})]: ExclusionTarget.ALL,
        };

        // Main window (top-level, resizable) is a different kind -> untouched
        const mainWin = evaluateWindowActions({
            ...baseWin,
            wmClass: 'wechat',
            hasParent: false,
            allowsResize: true,
            windowRules: rules,
        });
        expect(mainWin.applyShadow).toBeTrue();
        expect(mainWin.applyClip).toBeTrue();

        // Fixed child dialog matches the rule
        const dialogWin = evaluateWindowActions({
            ...baseWin,
            wmClass: 'wechat',
            hasParent: true,
            allowsResize: false,
            windowRules: rules,
        });
        expect(dialogWin.applyShadow).toBeFalse();
        expect(dialogWin.applyClip).toBeFalse();
        expect(dialogWin.reason).toContain('disabled-by-rule');

        // Resizable child of the same app is a different kind -> untouched
        const resizableChild = evaluateWindowActions({
            ...baseWin,
            wmClass: 'wechat',
            hasParent: true,
            allowsResize: true,
            windowRules: rules,
        });
        expect(resizableChild.applyShadow).toBeTrue();
        expect(resizableChild.applyClip).toBeTrue();
    });

    it('client type is part of the window kind: an X11 window does not match a Wayland rule', () => {
        const rules = {
            [buildRuleKey('wechat', {clientType: 'wayland', hasParent: true, allowsResize: false})]: ExclusionTarget.ALL,
        };

        const waylandChild = evaluateWindowActions({
            ...baseWin,
            wmClass: 'wechat',
            isX11: false,
            hasParent: true,
            allowsResize: false,
            windowRules: rules,
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
            windowRules: rules,
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

