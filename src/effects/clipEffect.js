/**
 * Rounded corner clipping effect: attached to window actor.
 * Uses GLSL to clip window contents to a rounded rectangle and adds an inner highlight outline.
 *
 * Shader mathematical principles:
 *   SDF (Signed Distance Field) computes distance d to window edge:
 *     p = cogl_tex_coord0_in.xy * uSize - halfSize (window center as origin)
 *     d = sdRoundedBox(p, halfSize, uRadius)
 *     inside window d < 0, outside window d > 0, boundary d = 0
 *   Rounded clipping:
 *     cogl_color_out *= 1.0 - clamp(d + 0.5, 0.0, 1.0) (1px anti-aliasing)
 *   Inner highlight outline (libadwaita 1px white window outline):
 *     Snugs along inside window boundary by 1px (d in [-1.0, 0.0])
 *     clamp(1.0 + d, 0.0, 1.0) strictly evaluates to 0 when d <= -1.0
 *     uOutline.rgb normalized to [0.0, 1.0]
 */

import GObject from 'gi://GObject';
import Cogl from 'gi://Cogl';
import Shell from 'gi://Shell';

const DECLARATIONS = `
uniform vec2 uSize;      // Window size (width, height)
uniform float uRadius;   // Corner radius
uniform vec4 uOutline;   // Inner highlight (r, g, b, alpha), disabled when alpha=0, rgb in [0.0, 1.0]

// ClutterOffscreenEffect (_clutter_actor_box_enlarge_for_effects)
// Pad 2px top-left to avoid jitter, 3px overall enlargement
const vec2 FBO_OFFSET = vec2(2.0, 2.0);
const vec2 FBO_EXTRA  = vec2(3.0, 3.0);

float sdRoundedBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
`;

const CODE = `
    vec2 halfSize = uSize * 0.5;
    vec2 quadSize = uSize + FBO_EXTRA;
    vec2 c = FBO_OFFSET + halfSize;
    vec2 p = cogl_tex_coord0_in.xy * quadSize;
    float d = sdRoundedBox(p - c, halfSize, uRadius);

    // Inner highlight: 1px band inside window edge (d in [-1.0, 0.0]), tracks corner curvature and fades with window
    if (uOutline.a > 0.0) {
        float m = clamp(1.0 + d, 0.0, 1.0) * uOutline.a * cogl_color_in.a;
        cogl_color_out.rgb = uOutline.rgb * m + cogl_color_out.rgb * (1.0 - m);
        cogl_color_out.a = m + cogl_color_out.a * (1.0 - m);
    }

    // Rounded clipping (1px anti-aliasing; zeroes out outside regions and clips excess drawing)
    cogl_color_out *= 1.0 - clamp(d + 0.5, 0.0, 1.0);
`;

export const RoundedClipEffect = GObject.registerClass({
    GTypeName: 'CsdFixerRoundedClipEffect',
}, class RoundedClipEffect extends Shell.GLSLEffect {
    _init() {
        super._init();
        this._uSize = this.get_uniform_location('uSize');
        this._uRadius = this.get_uniform_location('uRadius');
        this._uOutline = this.get_uniform_location('uOutline');
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT,
            DECLARATIONS, CODE, false);
    }

    /**
     * Update clipping parameters (size/radius/outline; disabled when outline is null).
     */
    setParams(width, height, radius, outline) {
        this.set_uniform_float(this._uSize, 2, [width, height]);
        this.set_uniform_float(this._uRadius, 1, [radius]);
        const u = outline
            ? [
                outline.color[0] > 1 ? outline.color[0] / 255 : outline.color[0],
                outline.color[1] > 1 ? outline.color[1] / 255 : outline.color[1],
                outline.color[2] > 1 ? outline.color[2] / 255 : outline.color[2],
                outline.alpha,
            ]
            : [0, 0, 0, 0];
        this.set_uniform_float(this._uOutline, 4, u);
        this.queue_repaint();
    }
});
