/**
 * Picks the decoration parameters for a window state, tracking libadwaita's
 * window.csd. Pure logic module, unit-testable.
 */

import {ADWAITA_STYLE} from './adwaitaStyle.generated.js';

/**
 * Returns the decoration parameters for a window state: {radius, shadows, outline} -
 * the corner radius, up to three shadow layers ({blur, spread, alpha}), and
 * libadwaita's outline highlight. The precedence between states is in
 * docs/decoration-model.md.
 *
 * @param {object} winState - focused / maximized / fullscreen / tiled / highContrast
 * @returns {{radius: number, shadows: Array<object>, outline: object|null}}
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
