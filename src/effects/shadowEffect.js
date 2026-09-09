/**
 * Shadow effect: attached to shadow actor (pure GPU analytical Gaussian integration, zero textures).
 *
 * Rendering kernel (transpiled by tools/gen-shader.mjs from GTK4 GSK gskgpuboxshadow.glsl):
 *   - 2D analytical Gaussian integral (double product of error function erf) + 8-step corner numerical integral subtraction;
 *   - Standard CSS parameter conversion (sigma = blur / 2);
 *   - Complementary hollow mask (clipAlpha = clamp(d + 0.5, 0.0, 1.0)):
 *     Strictly complementary to window RoundedClipEffect (summing identically to 1.000000), preventing
 *     seam light-leak while eliminating dark fringe bleeding from underlying shadow;
 *   - blur=0 layer: 1px anti-aliased border outline.
 *
 * Premultiplied output format (rgb = 0 <= a).
 */

import GObject from 'gi://GObject';
import Cogl from 'gi://Cogl';
import Shell from 'gi://Shell';

import {DECLARATIONS, CODE} from './shadowShader.generated.js';

export const SdfShadowEffect = GObject.registerClass({
    GTypeName: 'CsdFixerSdfShadowEffect',
}, class SdfShadowEffect extends Shell.GLSLEffect {
    _init() {
        super._init();
        for (const [k, n] of [['_uWinSize', 'uWinSize'], ['_uRadius', 'uRadius'],
            ['_uShadow1', 'uShadow1'], ['_uShadow2', 'uShadow2'],
            ['_uShadow3', 'uShadow3'], ['_uPad', 'uPad']])
            this[k] = this.get_uniform_location(n);
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT,
            DECLARATIONS, CODE, false);
    }

    /**
     * Update shadow parameters (window size / radius / padding / shadow layers, <= 3 layers).
     */
    setParams(winW, winH, radius, pad, shadows) {
        this.set_uniform_float(this._uWinSize, 2, [winW, winH]);
        this.set_uniform_float(this._uRadius, 1, [radius]);
        this.set_uniform_float(this._uPad, 2, [pad, pad]);

        const zeros = [
            {blur: 0, spread: 0, alpha: 0},
            {blur: 0, spread: 0, alpha: 0},
            {blur: 0, spread: 0, alpha: 0},
        ];
        const layers = [...shadows.slice(0, 3), ...zeros.slice(shadows.length)];
        for (let i = 0; i < 3; i++) {
            const s = layers[i];
            this.set_uniform_float(this[`_uShadow${i + 1}`], 4,
                [s.blur, s.spread, s.alpha, 0]);
        }
        this.queue_repaint();
    }
});
