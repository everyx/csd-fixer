/**
 * detector unit tests (jasmine-gjs).
 * Run: pnpm test
 */

import {
    shouldDecorate, computeInsets, WindowType, isFractionalScale,
    shouldClipWindow, ExclusionTarget, normalizeRuleMode,
    isWindowMaximized, isWindowTiled,
    resolveRule, evaluateWindowActions,
    parseRuleKey, buildRuleKey, isDialogWindow, sanitizeWindowRules,
} from '../src/lib/detector.js';

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
    const rules = {
        'wechat': ExclusionTarget.CLIP,
        'steam': ExclusionTarget.ALL,
        'my-game': ExclusionTarget.SHADOW,
    };

    it('exact match in windowRules', () => {
        expect(resolveRule('wechat', rules)).toBe(ExclusionTarget.CLIP);
        expect(resolveRule('steam', rules)).toBe(ExclusionTarget.ALL);
        expect(resolveRule('my-game', rules)).toBe(ExclusionTarget.SHADOW);
    });

    it('case-insensitive match in windowRules', () => {
        expect(resolveRule('WeChat', rules)).toBe(ExclusionTarget.CLIP);
        expect(resolveRule('STEAM', rules)).toBe(ExclusionTarget.ALL);
    });

    it('no match returns null', () => {
        expect(resolveRule('unknown-app', rules)).toBeNull();
        expect(resolveRule(null, rules)).toBeNull();
        expect(resolveRule('', rules)).toBeNull();
    });

    it('composite rules: dialog window matches wmClass:dialog with highest precedence over base wmClass', () => {
        const compositeRules = {
            'wechat': ExclusionTarget.CLIP,
            'wechat:dialog': ExclusionTarget.ALL,
        };

        // Main normal window: matches base wmClass
        expect(resolveRule('wechat', compositeRules, {isDialog: false})).toBe(ExclusionTarget.CLIP);

        // Dialog popup window: matches wechat:dialog (disable-all)
        expect(resolveRule('wechat', compositeRules, {isDialog: true})).toBe(ExclusionTarget.ALL);

        // Case-insensitive dialog match
        expect(resolveRule('WeChat', compositeRules, {isDialog: true})).toBe(ExclusionTarget.ALL);
    });

    it('composite rules: title rule matches with highest precedence over dialog and base', () => {
        const compositeRules = {
            'wechat': ExclusionTarget.CLIP,
            'wechat:dialog': ExclusionTarget.ALL,
            'wechat:title=Special': ExclusionTarget.SHADOW,
        };

        // Title matches specifically
        expect(resolveRule('wechat', compositeRules, {isDialog: true, title: 'Special'})).toBe(ExclusionTarget.SHADOW);

        // Other dialog matches wechat:dialog
        expect(resolveRule('wechat', compositeRules, {isDialog: true, title: 'Logout'})).toBe(ExclusionTarget.ALL);
    });

    it('composite rules: fallback to base wmClass when no dialog or title rule exists', () => {
        const compositeRules = {
            'wechat': ExclusionTarget.CLIP,
        };

        // When only base rule exists, dialog inherits base rule
        expect(resolveRule('wechat', compositeRules, {isDialog: true})).toBe(ExclusionTarget.CLIP);
    });

    it('bidirectional case-insensitive match (uppercase rule key matches lowercase wmClass)', () => {
        const uppercaseRules = {
            'WeChat': ExclusionTarget.CLIP,
            'Steam:dialog': ExclusionTarget.ALL,
            'Discord:title=Voice Channel': ExclusionTarget.SHADOW,
        };
        expect(resolveRule('wechat', uppercaseRules)).toBe(ExclusionTarget.CLIP);
        expect(resolveRule('steam', uppercaseRules, {isDialog: true})).toBe(ExclusionTarget.ALL);
        expect(resolveRule('discord', uppercaseRules, {title: 'Voice Channel'})).toBe(ExclusionTarget.SHADOW);
    });

    it('native property rules: fixed dialog matches specifically without affecting resizable child window', () => {
        const rules = {
            'com.tencent.wechat': ExclusionTarget.CLIP,
            'com.tencent.wechat:has_parent=true,allows_resize=false': ExclusionTarget.ALL,
        };

        // Main window (no parent) -> matches base rule (CLIP)
        expect(resolveRule('com.tencent.wechat', rules, {hasParent: false, allowsResize: true})).toBe(ExclusionTarget.CLIP);

        // Fixed exit dialog (hasParent=true, allowsResize=false) -> matches specific rule (ALL)
        expect(resolveRule('com.tencent.wechat', rules, {hasParent: true, allowsResize: false})).toBe(ExclusionTarget.ALL);

        // Article browser (hasParent=true, allowsResize=true) -> does NOT match exit dialog rule, falls back to base rule (CLIP)
        expect(resolveRule('com.tencent.wechat', rules, {hasParent: true, allowsResize: true})).toBe(ExclusionTarget.CLIP);

        // When specific article browser rule is added, it matches specifically
        const rulesWithArticle = {
            ...rules,
            'com.tencent.wechat:has_parent=true,allows_resize=true': ExclusionTarget.SHADOW,
        };
        expect(resolveRule('com.tencent.wechat', rulesWithArticle, {hasParent: true, allowsResize: true})).toBe(ExclusionTarget.SHADOW);
    });
});

describe('buildRuleKey', () => {
    it('main window without parent returns plain wmClass', () => {
        expect(buildRuleKey('wechat')).toBe('wechat');
        expect(buildRuleKey('wechat', {hasParent: false, allowsResize: true})).toBe('wechat');
        expect(buildRuleKey('wechat', {hasParent: false, allowsResize: false})).toBe('wechat');
    });

    it('fixed child window returns has_parent=true,allows_resize=false', () => {
        expect(buildRuleKey('wechat', {hasParent: true, allowsResize: false})).toBe('wechat:has_parent=true,allows_resize=false');
    });

    it('resizable child window returns has_parent=true,allows_resize=true', () => {
        expect(buildRuleKey('wechat', {hasParent: true, allowsResize: true})).toBe('wechat:has_parent=true,allows_resize=true');
    });

    it('empty wmClass returns empty string', () => {
        expect(buildRuleKey('')).toBe('');
        expect(buildRuleKey(null)).toBe('');
    });
});

describe('parseRuleKey', () => {
    it('plain wmClass without specifier', () => {
        expect(parseRuleKey('wechat')).toEqual({baseWmClass: 'wechat', specifier: null, properties: null});
        expect(parseRuleKey('steam')).toEqual({baseWmClass: 'steam', specifier: null, properties: null});
    });

    it('native property specifier', () => {
        expect(parseRuleKey('wechat:has_parent=true,allows_resize=false')).toEqual({
            baseWmClass: 'wechat',
            specifier: 'has_parent=true,allows_resize=false',
            properties: {
                has_parent: true,
                allows_resize: false,
            },
        });
        expect(parseRuleKey('wechat:has_parent=true,allows_resize=true')).toEqual({
            baseWmClass: 'wechat',
            specifier: 'has_parent=true,allows_resize=true',
            properties: {
                has_parent: true,
                allows_resize: true,
            },
        });
    });

    it('dialog specifier', () => {
        expect(parseRuleKey('wechat:dialog')).toEqual({baseWmClass: 'wechat', specifier: 'dialog', properties: null});
    });

    it('title specifier', () => {
        expect(parseRuleKey('wechat:title=Exit')).toEqual({baseWmClass: 'wechat', specifier: 'title=Exit', properties: null});
    });

    it('empty or null', () => {
        expect(parseRuleKey('')).toEqual({baseWmClass: '', specifier: null, properties: null});
        expect(parseRuleKey(null)).toEqual({baseWmClass: '', specifier: null, properties: null});
    });
});

describe('rule key contract & round-trip', () => {
    it('round-trip: parseRuleKey with composite keys', () => {
        const keys = [
            'wechat',
            'wechat:has_parent=true,allows_resize=false',
            'wechat:has_parent=true,allows_resize=true',
            'wechat:dialog',
            'wechat:title=Exit',
        ];
        for (const key of keys) {
            const parsed = parseRuleKey(key);
            const reconstructed = parsed.specifier
                ? `${parsed.baseWmClass}:${parsed.specifier}`
                : parsed.baseWmClass;
            expect(reconstructed).toBe(key);
        }
    });

    it('prefs rule keys match resolveRule candidate structure', () => {
        const prefsGeneratedRules = {
            [buildRuleKey('code', {hasParent: true, allowsResize: false})]: ExclusionTarget.ALL,
            'code:title=Preferences': ExclusionTarget.CLIP,
        };
        expect(resolveRule('code', prefsGeneratedRules, {hasParent: true, allowsResize: false})).toBe(ExclusionTarget.ALL);
        expect(resolveRule('code', prefsGeneratedRules, {title: 'Preferences'})).toBe(ExclusionTarget.CLIP);
    });
});

describe('sanitizeWindowRules', () => {
    it('passes valid rule keys unchanged', () => {
        const input = {
            'wechat': ExclusionTarget.CLIP,
            'wechat:has_parent=true,allows_resize=false': ExclusionTarget.ALL,
            'wechat:has_parent=true,allows_resize=true': ExclusionTarget.SHADOW,
            'steam:dialog': ExclusionTarget.ALL,
            'discord:title=Voice Channel': ExclusionTarget.SHADOW,
        };
        expect(sanitizeWindowRules(input)).toEqual(input);
    });

    it('drops invalid rule keys and non-string entries', () => {
        const input = {
            'wechat': ExclusionTarget.CLIP,
            'invalid:key:too:many:colons': ExclusionTarget.ALL,
            'has space': ExclusionTarget.CLIP,
            'valid_app': 123,
        };
        expect(sanitizeWindowRules(input)).toEqual({
            'wechat': ExclusionTarget.CLIP,
        });
    });

    it('rejects case-colliding duplicate keys deterministically', () => {
        const input = {
            'wechat': ExclusionTarget.CLIP,
            'WeChat': ExclusionTarget.ALL,
        };
        expect(sanitizeWindowRules(input)).toEqual({
            'wechat': ExclusionTarget.CLIP,
        });
    });

    it('migrates legacy disable-* rule modes to canonical forms', () => {
        const legacyInput = {
            'wechat': 'disable-clip',
            'steam:dialog': 'disable-all',
            'discord:title=Voice Channel': 'disable-shadow',
        };
        expect(sanitizeWindowRules(legacyInput)).toEqual({
            'wechat': ExclusionTarget.CLIP,
            'steam:dialog': ExclusionTarget.ALL,
            'discord:title=Voice Channel': ExclusionTarget.SHADOW,
        });
    });

    it('drops entries with invalid rule modes', () => {
        const input = {
            'wechat': ExclusionTarget.CLIP,
            'bad-app': 'not-a-valid-mode',
        };
        expect(sanitizeWindowRules(input)).toEqual({
            'wechat': ExclusionTarget.CLIP,
        });
    });

    it('handles null, undefined, or non-object input gracefully', () => {
        expect(sanitizeWindowRules(null)).toEqual({});
        expect(sanitizeWindowRules(undefined)).toEqual({});
        expect(sanitizeWindowRules('string')).toEqual({});
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

describe('isDialogWindow', () => {
    it('detects dialog by windowType DIALOG or MODAL_DIALOG', () => {
        expect(isDialogWindow({windowType: WindowType.DIALOG})).toBe(true);
        expect(isDialogWindow({windowType: WindowType.MODAL_DIALOG})).toBe(true);
        expect(isDialogWindow({windowType: WindowType.NORMAL})).toBe(false);
    });

    it('detects dialog when hasParent is true', () => {
        expect(isDialogWindow({windowType: WindowType.NORMAL, hasParent: true})).toBe(true);
    });

    it('detects dialog when isAttachedDialog is true', () => {
        expect(isDialogWindow({windowType: WindowType.NORMAL, isAttachedDialog: true})).toBe(true);
    });

    it('returns false for normal standalone window', () => {
        expect(isDialogWindow({
            windowType: WindowType.NORMAL,
            hasParent: false,
            isAttachedDialog: false,
        })).toBe(false);
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
            windowRules: {'overlay-app': ExclusionTarget.ALL},
        });
        expect(res.applyShadow).toBeFalse();
        expect(res.applyClip).toBeFalse();
        expect(res.reason).toContain('disabled-by-rule');
    });

    it('disable-clip rule: retains shadow, disables clip', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            wmClass: 'wechat',
            windowRules: {'wechat': ExclusionTarget.CLIP},
        });
        expect(res.applyShadow).toBeTrue();
        expect(res.applyClip).toBeFalse();
        expect(res.reason).toContain('rule-applied');
    });

    it('disable-shadow rule: disables shadow, retains clip', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            wmClass: 'custom-tool',
            windowRules: {'custom-tool': ExclusionTarget.SHADOW},
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
            windowRules: {'gtk4-app': ExclusionTarget.CLIP},
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

    it('dialog popup with wechat:dialog rule disables decorations on dialog while retaining them on main window', () => {
        const rules = {
            'wechat:dialog': ExclusionTarget.ALL,
        };

        // WeChat main window (NORMAL, no parent)
        const mainWin = evaluateWindowActions({
            ...baseWin,
            wmClass: 'wechat',
            windowType: WindowType.NORMAL,
            hasParent: false,
            windowRules: rules,
        });
        expect(mainWin.applyShadow).toBeTrue();
        expect(mainWin.applyClip).toBeTrue();

        // WeChat exit popup (DIALOG windowType)
        const dialogWin = evaluateWindowActions({
            ...baseWin,
            wmClass: 'wechat',
            windowType: WindowType.DIALOG,
            hasParent: true,
            windowRules: rules,
        });
        expect(dialogWin.applyShadow).toBeFalse();
        expect(dialogWin.applyClip).toBeFalse();
        expect(dialogWin.reason).toContain('disabled-by-rule(wechat:all)');

        // WeChat modal popup (MODAL_DIALOG windowType)
        const modalWin = evaluateWindowActions({
            ...baseWin,
            wmClass: 'wechat',
            windowType: WindowType.MODAL_DIALOG,
            windowRules: rules,
        });
        expect(modalWin.applyShadow).toBeFalse();
        expect(modalWin.applyClip).toBeFalse();

        // WeChat popup with transient parent even if type is NORMAL
        const transientWin = evaluateWindowActions({
            ...baseWin,
            wmClass: 'wechat',
            windowType: WindowType.NORMAL,
            hasParent: true,
            windowRules: rules,
        });
        expect(transientWin.applyShadow).toBeFalse();
        expect(transientWin.applyClip).toBeFalse();
    });

    it('WeChat real-world isolation: fixed exit dialog excluded without affecting resizable article browser or main window', () => {
        const rules = {
            'com.tencent.wechat:has_parent=true,allows_resize=false': ExclusionTarget.ALL,
        };

        // 1. WeChat main window (NORMAL, no parent, resizable) -> decorated normally
        const mainWin = evaluateWindowActions({
            ...baseWin,
            wmClass: 'com.tencent.wechat',
            hasParent: false,
            allowsResize: true,
            windowRules: rules,
        });
        expect(mainWin.applyShadow).toBeTrue();
        expect(mainWin.applyClip).toBeTrue();

        // 2. WeChat exit dialog (transient, non-resizable) -> excluded by rule
        const exitDialog = evaluateWindowActions({
            ...baseWin,
            wmClass: 'com.tencent.wechat',
            hasParent: true,
            allowsResize: false,
            windowRules: rules,
        });
        expect(exitDialog.applyShadow).toBeFalse();
        expect(exitDialog.applyClip).toBeFalse();
        expect(exitDialog.reason).toContain('disabled-by-rule(com.tencent.wechat:all)');

        // 3. WeChat article browser (transient, resizable) -> NOT affected by exit dialog rule!
        const articleBrowser = evaluateWindowActions({
            ...baseWin,
            wmClass: 'com.tencent.wechat',
            hasParent: true,
            allowsResize: true,
            windowRules: rules,
        });
        expect(articleBrowser.applyShadow).toBeTrue();
        expect(articleBrowser.applyClip).toBeTrue();
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
    it('uses win.is_maximized() when method is present', () => {
        const winTrue = {
            is_maximized: () => true,
            maximized_horizontally: false,
            maximized_vertically: false,
        };
        expect(isWindowMaximized(winTrue)).toBeTrue();

        const winFalse = {
            is_maximized: () => false,
            maximized_horizontally: true,
            maximized_vertically: true,
        };
        expect(isWindowMaximized(winFalse)).toBeFalse();
    });

    it('falls back to maximized_horizontally && maximized_vertically when is_maximized is absent', () => {
        expect(isWindowMaximized({
            maximized_horizontally: true,
            maximized_vertically: true,
        })).toBeTrue();

        expect(isWindowMaximized({
            maximized_horizontally: true,
            maximized_vertically: false,
        })).toBeFalse();

        expect(isWindowMaximized({
            maximized_horizontally: false,
            maximized_vertically: true,
        })).toBeFalse();
    });

    it('handles GObject property getters returning booleans on instances', () => {
        const mockGObjectWin = {
            get maximized_horizontally() { return true; },
            get maximized_vertically() { return true; },
        };
        expect(isWindowMaximized(mockGObjectWin)).toBeTrue();
    });

    it('handles null/undefined gracefully', () => {
        expect(isWindowMaximized(null)).toBeFalse();
        expect(isWindowMaximized(undefined)).toBeFalse();
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

