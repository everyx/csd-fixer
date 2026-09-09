/**
 * shader unit tests: verifies generated shadow shader includes GTK4 GSK analytical 2D Gaussian kernel.
 */

import { DECLARATIONS, CODE } from '../src/effects/shadowShader.generated.js';

describe('shadowShader.generated', () => {
    it('DECLARATIONS includes essential math constants and functions', () => {
        expect(DECLARATIONS).toContain('const float PI = 3.141592653589793');
        expect(DECLARATIONS).toContain('const float SQRT1_2 = 0.7071067811865475');
        expect(DECLARATIONS).toContain('float\ngauss');
        expect(DECLARATIONS).toContain('vec2\nerf');
        expect(DECLARATIONS).toContain('float\nerf_range');
        expect(DECLARATIONS).toContain('float\nellipse_x');
        expect(DECLARATIONS).toContain('blur_corner');
        expect(DECLARATIONS).toContain('blur_rounded_rect');
        expect(DECLARATIONS).toContain('sdRoundedBox');
        expect(DECLARATIONS).toContain('evalShadowLayer');
    });

    it('DECLARATIONS includes window and shadow uniform declarations', () => {
        expect(DECLARATIONS).toContain('uniform vec2 uWinSize;');
        expect(DECLARATIONS).toContain('uniform float uRadius;');
        expect(DECLARATIONS).toContain('uniform vec4 uShadow1;');
        expect(DECLARATIONS).toContain('uniform vec4 uShadow2;');
        expect(DECLARATIONS).toContain('uniform vec4 uShadow3;');
        expect(DECLARATIONS).toContain('uniform vec2 uPad;');
    });

    it('CODE includes 3-layer shadow evaluation, GTK native SNAP_BLEED clipping and accumulation', () => {
        expect(CODE).toContain('clipAlpha = clamp(d + 0.5 + 0.8, 0.0, 1.0);');
        expect(CODE).toContain('evalShadowLayer(uShadow1');
        expect(CODE).toContain('evalShadowLayer(uShadow2');
        expect(CODE).toContain('evalShadowLayer(uShadow3');
        expect(CODE).toContain('cogl_color_out = vec4(vec3(0.0), min(a, 1.0) * cogl_color_in.a);');
    });

    it('CODE includes early short-circuit optimization when fully transparent', () => {
        expect(CODE).toContain('if (cogl_color_in.a <= 0.0)');
    });
});
