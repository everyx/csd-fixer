/**
 * Style state machine: selects decoration parameters based on window state.
 * Strictly tracks native GNOME (libadwaita window.csd).
 * Pure logic module, unit-testable.
 */

import {ADWAITA_STYLE} from './adwaitaStyle.generated.js';

/**
 * Returns decoration parameters for the given window state.
 *
 * Returns {radius, shadows, outline}:
 *   radius    corner radius (px)
 *   shadows   shadow layers [{blur, spread, alpha, color?}] (<= 3)
 *   outline   window outline highlight {color: [r,g,b], alpha} (libadwaita outline)
 *
 * State parameters: focused / maximized / fullscreen / tiled / highContrast.
 * Precedence matches libadwaita CSS selectors:
 *   fullscreen > maximized > tiled > focused|backdrop
 * High contrast replaces shadow set (upstream @media prefers-contrast: more),
 * and deepens outline (7% -> 30%).
 */
export function styleForWindow(winState) {
    const {window} = ADWAITA_STYLE;
    const outline = winState.highContrast
        ? window.outline.highContrast : window.outline.normal;

    // Maximized / fullscreen / tiled: no outline (upstream outline: none), no shadows
    if (winState.fullscreen)
        return {...window.fullscreen, outline: null};
    if (winState.maximized)
        return {...window.maximized, outline: null};
    if (winState.tiled)
        return {...window.tiled, outline: null};

    const base = winState.focused ? window : window.backdrop;
    const style = {radius: base.radius, shadows: base.shadows};
    if (winState.highContrast) {
        style.shadows = winState.focused
            ? window.highContrast.shadows
            : window.highContrast.backdropShadows;
    }
    style.outline = outline;
    return style;
}
