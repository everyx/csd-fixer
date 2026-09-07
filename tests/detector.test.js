/**
 * detector 纯逻辑单测（jasmine-gjs）。
 * 运行: jasmine --module tests/ （见 package.json 的 npm test）
 */

import {shouldDecorate, computeInsets, WindowType} from '../src/lib/detector.js';

describe('computeInsets', () => {
    it('buffer==frame（scale=1）→ 零边距', () => {
        const {w, h} = computeInsets(400, 300, 400, 300, 1);
        expect(w).toBe(0);
        expect(h).toBe(0);
    });

    it('buffer>frame（scale=1）→ 正边距', () => {
        const {w, h} = computeInsets(400, 300, 360, 260, 1);
        expect(w).toBe(40);
        expect(h).toBe(40);
    });

    it('分数缩放：buffer 物理像素除以 scale 后再比', () => {
        // 2x HiDPI：无 CSD 窗口 buffer=800x600，frame=400x300
        const {w, h} = computeInsets(800, 600, 400, 300, 2);
        expect(w).toBe(0);
        expect(h).toBe(0);
        // 2x + CSD 20px 边距
        const {w: w2} = computeInsets(840, 640, 400, 300, 2);
        expect(w2).toBe(20);
    });
});

describe('shouldDecorate', () => {
    const base = {
        bufferWidth: 400, bufferHeight: 300,
        frameWidth: 400, frameHeight: 300,
        scale: 1,
        isX11: false, skipXwayland: true,
        isMaximized: false, isFullscreen: false,
        windowType: WindowType.NORMAL,
        wmClass: 'test-app',
    };

    it('无 CSD 普通窗口 → 需要补装饰', () => {
        const r = shouldDecorate(base);
        expect(r.apply).toBeTrue();
        expect(r.reason).toContain('no-csd');
    });

    it('有 CSD（buffer>frame）→ 跳过', () => {
        const r = shouldDecorate({...base,
            bufferWidth: 440, bufferHeight: 340,
            frameWidth: 400, frameHeight: 300});
        expect(r.apply).toBeFalse();
        expect(r.reason).toContain('has-csd');
    });

    it('XWayland 窗口默认跳过', () => {
        const r = shouldDecorate({...base, isX11: true});
        expect(r.apply).toBeFalse();
        expect(r.reason).toBe('xwayland-skipped');
    });

    it('skip-xwayland=false 时 XWayland 无 CSD 窗口处理', () => {
        const r = shouldDecorate({...base, isX11: true, skipXwayland: false});
        expect(r.apply).toBeTrue();
    });

    it('最大化/全屏 → 跳过', () => {
        expect(shouldDecorate({...base, isMaximized: true}).apply).toBeFalse();
        expect(shouldDecorate({...base, isFullscreen: true}).apply).toBeFalse();
    });

    it('非普通窗口类型 → 跳过', () => {
        expect(shouldDecorate({...base, windowType: WindowType.DOCK}).apply).toBeFalse();
    });

    it('黑名单命中 → 跳过', () => {
        const r = shouldDecorate({...base, blacklist: ['test-app']});
        expect(r.apply).toBeFalse();
        expect(r.reason).toContain('blacklisted');
    });

    it('白名单非空且不含该窗口 → 跳过；命中 → 处理', () => {
        const whitelist = ['only-this'];
        expect(shouldDecorate({...base, whitelist}).apply).toBeFalse();
        expect(shouldDecorate({...base, whitelist, wmClass: 'only-this'}).apply).toBeTrue();
    });

    it('wmClass 为 null 且黑名单含 null 项？→ 白名单为空时按无 CSD 处理', () => {
        const r = shouldDecorate({...base, wmClass: null});
        expect(r.apply).toBeTrue();
    });
});
