/**
 * style state machine unit tests: tracks libadwaita window.csd states.
 */

import {styleForWindow} from '../src/lib/style.js';
import {STYLE} from '../src/style/defaults.js';

describe('styleForWindow', () => {
    const base = {focused: true, maximized: false, fullscreen: false, tiled: false, highContrast: false};

    it('focused normal window -> rounded corners + 3-layer shadow', () => {
        const s = styleForWindow(base);
        expect(s.radius).toBe(15);
        expect(s.shadows.length).toBe(3);
        expect(s.shadows[0].alpha).toBe(0.15);
    });

    it('unfocused (backdrop) -> same radius, faded shadow, unchanged extents', () => {
        const focused = styleForWindow(base);
        const backdrop = styleForWindow({...base, focused: false});
        expect(backdrop.radius).toBe(focused.radius);
        // First layer transparent (retains extents to prevent jitter)
        expect(backdrop.shadows[0].alpha).toBe(0);
        expect(backdrop.shadows[0].blur).toBe(focused.shadows[0].blur);
        expect(backdrop.shadows[0].spread).toBe(focused.shadows[0].spread);
        // Visible shadow layer fades
        expect(backdrop.shadows[1].alpha).toBeLessThan(focused.shadows[1].alpha);
    });

    it('tiled -> zero radius, 1px border only', () => {
        const s = styleForWindow({...base, tiled: true});
        expect(s.radius).toBe(0);
        expect(s.shadows.length).toBe(1);
        expect(s.shadows[0].spread).toBe(1);
        expect(s.shadows[0].blur).toBe(0);
    });

    it('maximized / fullscreen -> no radius and no shadow', () => {
        const max = styleForWindow({...base, maximized: true});
        expect(max.radius).toBe(0);
        expect(max.shadows.length).toBe(0);
        const fs = styleForWindow({...base, fullscreen: true});
        expect(fs.radius).toBe(0);
        expect(fs.shadows.length).toBe(0);
    });

    it('high contrast mode -> deeper outline and replaced outline color', () => {
        const normal = styleForWindow(base);
        const hc = styleForWindow({...base, highContrast: true});
        // Full shadow set replacement: outline layer 5% -> 80%
        expect(hc.shadows[2].alpha).toBe(0.8);
        expect(hc.shadows[2].blur).toBe(normal.shadows[2].blur);
        // Outline color deepened: white 7% -> white 30%
        expect(normal.outline.alpha).toBe(0.07);
        expect(hc.outline.alpha).toBe(0.3);
        expect(hc.outline.color).toEqual([255, 255, 255]);
    });

    it('high contrast unfocused -> HC backdrop shadow set', () => {
        const s = styleForWindow({...base, highContrast: true, focused: false});
        // Backdrop first layer transparent to prevent jitter
        expect(s.shadows[0].alpha).toBe(0);
        expect(s.shadows[2].alpha).toBe(0.8);
    });

    it('maximized / tiled / fullscreen -> no outline (upstream outline: none)', () => {
        for (const st of [true, false]) {
            expect(styleForWindow({...base, maximized: true, highContrast: st}).outline).toBeNull();
            expect(styleForWindow({...base, fullscreen: true, highContrast: st}).outline).toBeNull();
            expect(styleForWindow({...base, tiled: true, highContrast: st}).outline).toBeNull();
        }
    });

    it('maximized takes precedence over tiled (matches libadwaita selector precedence)', () => {
        const s = styleForWindow({...base, maximized: true, tiled: true});
        expect(s.shadows.length).toBe(0);
        expect(s.outline).toBeNull();
    });
});
