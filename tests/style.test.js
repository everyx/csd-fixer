/**
 * style 状态机单测：固定跟随 libadwaita window.csd 状态。
 */

import {styleForWindow} from '../src/lib/style.js';
import {STYLE} from '../src/style/defaults.js';

describe('styleForWindow', () => {
    const base = {focused: true, maximized: false, fullscreen: false, tiled: false, highContrast: false};

    it('聚焦普通窗口 → 圆角 + 三层阴影', () => {
        const s = styleForWindow(base);
        expect(s.radius).toBe(15);
        expect(s.shadows.length).toBe(3);
        expect(s.shadows[0].alpha).toBe(0.15);
    });

    it('失焦（backdrop）→ 圆角不变，阴影减淡且 extents 不变', () => {
        const focused = styleForWindow(base);
        const backdrop = styleForWindow({...base, focused: false});
        expect(backdrop.radius).toBe(focused.radius);
        // 首层透明（保持 extents 防跳动）
        expect(backdrop.shadows[0].alpha).toBe(0);
        expect(backdrop.shadows[0].blur).toBe(focused.shadows[0].blur);
        expect(backdrop.shadows[0].spread).toBe(focused.shadows[0].spread);
        // 可见阴影层减淡
        expect(backdrop.shadows[1].alpha).toBeLessThan(focused.shadows[1].alpha);
    });

    it('贴边（tiled）→ 圆角归零，只留 1px 描边', () => {
        const s = styleForWindow({...base, tiled: true});
        expect(s.radius).toBe(0);
        expect(s.shadows.length).toBe(1);
        expect(s.shadows[0].spread).toBe(1);
        expect(s.shadows[0].blur).toBe(0);
    });

    it('最大化/全屏 → 无圆角无阴影', () => {
        const max = styleForWindow({...base, maximized: true});
        expect(max.radius).toBe(0);
        expect(max.shadows.length).toBe(0);
        const fs = styleForWindow({...base, fullscreen: true});
        expect(fs.radius).toBe(0);
        expect(fs.shadows.length).toBe(0);
    });

    it('高对比模式 → outline 加深 + outline 色替换', () => {
        const normal = styleForWindow(base);
        const hc = styleForWindow({...base, highContrast: true});
        // 阴影集整体替换：outline 层 5% → 80%
        expect(hc.shadows[2].alpha).toBe(0.8);
        expect(hc.shadows[2].blur).toBe(normal.shadows[2].blur);
        // outline 色加深：白 7% → 白 30%
        expect(normal.outline.alpha).toBe(0.07);
        expect(hc.outline.alpha).toBe(0.3);
        expect(hc.outline.color).toEqual([255, 255, 255]);
    });

    it('高对比失焦 → HC backdrop 阴影集', () => {
        const s = styleForWindow({...base, highContrast: true, focused: false});
        // backdrop 首层透明防跳动不变
        expect(s.shadows[0].alpha).toBe(0);
        expect(s.shadows[2].alpha).toBe(0.8);
    });

    it('最大化/tiled/全屏 → 无 outline（上游 outline: none）', () => {
        for (const st of [true, false]) {
            expect(styleForWindow({...base, maximized: true, highContrast: st}).outline).toBeNull();
            expect(styleForWindow({...base, fullscreen: true, highContrast: st}).outline).toBeNull();
            expect(styleForWindow({...base, tiled: true, highContrast: st}).outline).toBeNull();
        }
    });

    it('最大化优先于贴边（与 libadwaita 选择器优先级一致）', () => {
        const s = styleForWindow({...base, maximized: true, tiled: true});
        expect(s.shadows.length).toBe(0);
        expect(s.outline).toBeNull();
    });
});
