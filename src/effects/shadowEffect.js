/**
 * Shadow effect: attached to shadow actor (pure GPU analytical Gaussian integration, zero textures).
 *
 * Rendering kernel (transpiled by tools/gen-shader.mjs from GTK4 GSK gskgpuboxshadow.glsl):
 *   - 2D analytical Gaussian integral (double product of error function erf) + 8-step corner numerical integral subtraction;
 *   - Standard CSS parameter conversion (sigma = blur / 2);
 *   - Hollow mask with SNAP_BLEED (clipAlpha = clamp(d + 0.5 + 0.8, 0.0, 1.0)):
 *     SNAP_BLEED = 0.8 (injected by tools/gen-shader.mjs, aligning with GTK4 GSK_RECT_SNAP_GROW philosophy)
 *     extends shadow cutout 0.8px beneath window frame, eliminating fractional-scaling seam light-leak.
 *     Non-strictly complementary to RoundedClipEffect (conservative overlap);
 *   - blur=0 layer: 1px anti-aliased border outline.
 *
 * Premultiplied output format (rgb = 0 <= a).
 */

import GObject from 'gi://GObject';
import Cogl from 'gi://Cogl';
import Shell from 'gi://Shell';

import {DECLARATIONS, CODE} from './shadowShader.generated.js';

/** Padding for a shadow layer a window does not have. */
const NO_SHADOW = Object.freeze({blur: 0, spread: 0, alpha: 0});

export const SdfShadowEffect = GObject.registerClass({
    GTypeName: 'CsdFixerSdfShadowEffect',
}, class SdfShadowEffect extends Shell.GLSLEffect {
    _init() {
        super._init();
        for (const [k, n] of [['_uWinSize', 'uWinSize'], ['_uRadius', 'uRadius'], ['_uPad', 'uPad']])
            this[k] = this.get_uniform_location(n);
        this._uShadow = ['uShadow1', 'uShadow2', 'uShadow3']
            .map(name => this.get_uniform_location(name));

        this._lastWinW = -1;
        this._lastWinH = -1;
        this._lastRadius = -1;
        this._lastPad = -1;
        this._lastShadows = undefined;
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT,
            DECLARATIONS, CODE, false);
    }

    /**
     * Update shadow parameters (window size / radius / padding / shadow layers, <= 3
     * layers). Returns without touching the pipeline when nothing changed: an upload
     * dirties Cogl's pipeline state, and the repaint schedules a compositor frame.
     */
    setParams(winW, winH, radius, pad, shadows) {
        if (this._lastWinW === winW && this._lastWinH === winH &&
            this._lastRadius === radius && this._lastPad === pad &&
            this._lastShadows === shadows)
            return;

        this._lastWinW = winW;
        this._lastWinH = winH;
        this._lastRadius = radius;
        this._lastPad = pad;
        this._lastShadows = shadows;

        this.set_uniform_float(this._uWinSize, 2, [winW, winH]);
        this.set_uniform_float(this._uRadius, 1, [radius]);
        this.set_uniform_float(this._uPad, 2, [pad, pad]);

        for (let i = 0; i < 3; i++) {
            const s = shadows[i] ?? NO_SHADOW;
            this.set_uniform_float(this._uShadow[i], 4, [s.blur, s.spread, s.alpha, 0]);
        }
        this.queue_repaint();
    }
});
