/**
 * detector unit tests (jasmine-gjs).
 * Run: pnpm test
 */

import {
    shouldDecorate, computeInsets, WindowType, isFractionalScale,
    shouldClipWindow, RuleMode, resolveRule, evaluateWindowActions,
    parseRuleKey,
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

    it('Wayland window with small resize grip (Chromium 4px resize grip) single side < 8px -> detected as lacking CSD, decorate', () => {
        // Captured real-world data: buf=[1156, 852], frame=[1148, 844], 4px per edge
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

    it('X11 / XWayland windows (WPS Office, Dida) -> Mutter C core manages native shadow, skip', () => {
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
        'wechat': RuleMode.DISABLE_CLIP,
        'steam': RuleMode.DISABLE_ALL,
        'my-game': RuleMode.DISABLE_SHADOW,
    };

    it('exact match in windowRules', () => {
        expect(resolveRule('wechat', rules)).toBe(RuleMode.DISABLE_CLIP);
        expect(resolveRule('steam', rules)).toBe(RuleMode.DISABLE_ALL);
        expect(resolveRule('my-game', rules)).toBe(RuleMode.DISABLE_SHADOW);
    });

    it('case-insensitive match in windowRules', () => {
        expect(resolveRule('WeChat', rules)).toBe(RuleMode.DISABLE_CLIP);
        expect(resolveRule('STEAM', rules)).toBe(RuleMode.DISABLE_ALL);
    });

    it('no match returns null', () => {
        expect(resolveRule('unknown-app', rules)).toBeNull();
        expect(resolveRule(null, rules)).toBeNull();
        expect(resolveRule('', rules)).toBeNull();
    });

    it('composite rules: dialog window matches wmClass:dialog with highest precedence over base wmClass', () => {
        const compositeRules = {
            'wechat': RuleMode.DISABLE_CLIP,
            'wechat:dialog': RuleMode.DISABLE_ALL,
        };

        // Main normal window: matches base wmClass
        expect(resolveRule('wechat', compositeRules, {isDialog: false})).toBe(RuleMode.DISABLE_CLIP);

        // Dialog popup window: matches wechat:dialog (disable-all)
        expect(resolveRule('wechat', compositeRules, {isDialog: true})).toBe(RuleMode.DISABLE_ALL);

        // Case-insensitive dialog match
        expect(resolveRule('WeChat', compositeRules, {isDialog: true})).toBe(RuleMode.DISABLE_ALL);
    });

    it('composite rules: title rule matches with highest precedence over dialog and base', () => {
        const compositeRules = {
            'wechat': RuleMode.DISABLE_CLIP,
            'wechat:dialog': RuleMode.DISABLE_ALL,
            'wechat:title=Special': RuleMode.DISABLE_SHADOW,
        };

        // Title matches specifically
        expect(resolveRule('wechat', compositeRules, {isDialog: true, title: 'Special'})).toBe(RuleMode.DISABLE_SHADOW);

        // Other dialog matches wechat:dialog
        expect(resolveRule('wechat', compositeRules, {isDialog: true, title: 'Logout'})).toBe(RuleMode.DISABLE_ALL);
    });

    it('composite rules: fallback to base wmClass when no dialog or title rule exists', () => {
        const compositeRules = {
            'wechat': RuleMode.DISABLE_CLIP,
        };

        // When only base rule exists, dialog inherits base rule
        expect(resolveRule('wechat', compositeRules, {isDialog: true})).toBe(RuleMode.DISABLE_CLIP);
    });
});

describe('parseRuleKey', () => {
    it('plain wmClass without specifier', () => {
        expect(parseRuleKey('wechat')).toEqual({baseWmClass: 'wechat', specifier: null});
        expect(parseRuleKey('steam')).toEqual({baseWmClass: 'steam', specifier: null});
    });

    it('dialog specifier', () => {
        expect(parseRuleKey('wechat:dialog')).toEqual({baseWmClass: 'wechat', specifier: 'dialog'});
    });

    it('title specifier', () => {
        expect(parseRuleKey('wechat:title=Exit')).toEqual({baseWmClass: 'wechat', specifier: 'title=Exit'});
    });

    it('empty or null', () => {
        expect(parseRuleKey('')).toEqual({baseWmClass: '', specifier: null});
        expect(parseRuleKey(null)).toEqual({baseWmClass: '', specifier: null});
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

    it('X11 window (WPS, dida): skips both shadow and clip due to native Mutter shadow', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            isX11: true,
            wmClass: 'wps',
        });
        expect(res.applyShadow).toBeFalse();
        expect(res.applyClip).toBeFalse();
        expect(res.reason).toBe('x11-mutter-native-shadow');
    });

    it('disable-all rule: both shadow and clip disabled', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            wmClass: 'overlay-app',
            windowRules: {'overlay-app': RuleMode.DISABLE_ALL},
        });
        expect(res.applyShadow).toBeFalse();
        expect(res.applyClip).toBeFalse();
        expect(res.reason).toContain('disabled-by-rule');
    });

    it('disable-clip rule: retains shadow, disables clip', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            wmClass: 'wechat',
            windowRules: {'wechat': RuleMode.DISABLE_CLIP},
        });
        expect(res.applyShadow).toBeTrue();
        expect(res.applyClip).toBeFalse();
        expect(res.reason).toContain('rule-applied');
    });

    it('disable-shadow rule: disables shadow, retains clip', () => {
        const res = evaluateWindowActions({
            ...baseWin,
            wmClass: 'custom-tool',
            windowRules: {'custom-tool': RuleMode.DISABLE_SHADOW},
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
            windowRules: {'gtk4-app': RuleMode.DISABLE_CLIP},
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
            'wechat:dialog': RuleMode.DISABLE_ALL,
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
        expect(dialogWin.reason).toContain('disabled-by-rule(wechat:disable-all)');

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
});

