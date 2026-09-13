/**
 * The shadow, baked once per style into one texture.
 *
 * A shadow is a blurred rounded rectangle, so its pixels depend on the window's size
 * only through the length of its straight edges: four corners and a one-pixel strip
 * from each edge describe the whole shape. Baking those pieces once and stretching the
 * strips lets a window be any size without an offscreen pass of its own, which is how
 * Mutter treats its own window shadows (docs/decoration-model.md).
 *
 * The bake runs the same GLSL the generator produces from GTK4's shadow, so what is
 * drawn stays the upstream shadow rather than a second rendering of it.
 */

import Cogl from 'gi://Cogl';

import {DECLARATIONS, CODE} from './shadowShader.generated.js';

/** How far the shadow reaches outside the window: max blur 14 (3 sigma = 21) + spread 5. */
export const SHADOW_PAD = 28;

/** The shader carries three shadow layers; a style may name fewer. */
const LAYER_COUNT = 3;

/**
 * The shader lays its quad out in a buffer three pixels wider than the padded rect,
 * offset by two, which is how Clutter enlarges an offscreen to keep it from jittering
 * (FBO_OFFSET and FBO_EXTRA in the generated code). Slices are taken through that.
 */
const BAKE_ORIGIN = 2;

const NO_SHADOW = Object.freeze({blur: 0, spread: 0, alpha: 0});

/** Cogl's `COGL_BUFFER_BIT_COLOR`, which the GIR does not expose as an enum. */
const CLEAR_COLOR_BUFFER = 1;

/** Cogl's opacity is the fragment shader's job; the pipeline colour stays out of it. */
const opaqueWhite = () => new Cogl.Color({red: 255, green: 255, blue: 255, alpha: 255});

/**
 * Geometry of a padded shadow for one corner radius.
 *
 * The canonical window a bake is taken from is a square of 2*(pad + radius), which
 * leaves a straight middle 2*pad long. That is wider than the blur reaches, so a strip
 * taken from the middle of an edge is a settled profile that can be stretched.
 *
 * @param {number} radius - Corner radius, in logical pixels
 * @returns {{corner: number, window: number, buffer: number}}
 */
export function shadowGeometry(radius) {
    const corner = SHADOW_PAD + radius;
    return {
        corner,
        window: 2 * corner,
        buffer: 2 * corner + 2 * SHADOW_PAD + 3,
    };
}

/**
 * The eight pieces of a padded shadow: destination boxes inside it, and the source
 * rectangle each samples from the baked buffer, as normalized texture coordinates
 * (Cogl only accepts those). The middle is absent on purpose, since the hollow mask
 * leaves the window's interior transparent.
 *
 * A window too small to hold the four corners at full size shrinks them instead: the
 * result is the corner scaled down, which is the right shape for a window that is all
 * corner, and keeps one code path for every size.
 *
 * @param {{corner: number, window: number, buffer: number}} geometry - shadowGeometry() output
 * @param {number} width - Padded rect width
 * @param {number} height - Padded rect height
 * @returns {Array<{x1: number, y1: number, x2: number, y2: number, s1: number, t1: number, s2: number, t2: number}>}
 */
export function shadowSlices({corner, window, buffer}, width, height) {
    const c = Math.min(corner, width / 2, height / 2);
    const o = BAKE_ORIGIN;
    const near = o / buffer;
    const span = corner / buffer;
    const strip = 1 / buffer;
    const far = (buffer - corner - 1) / buffer;
    // The edge strips have to come from the middle of the canonical window's edges, not
    // from where the corner blocks end: a corner reaches about 3 sigma along the edge it
    // meets, so a strip taken at the corner boundary carries a profile the corner has
    // pulled tighter, and the stretched shadow comes out darker at the edge and shorter.
    const edge = (o + SHADOW_PAD + window / 2) / buffer;
    const right = width - c;
    const bottom = height - c;

    return [
        // corners, drawn one to one
        {x1: 0, y1: 0, x2: c, y2: c, s1: near, t1: near, s2: near + span, t2: near + span},
        {x1: right, y1: 0, x2: width, y2: c, s1: far, t1: near, s2: far + span, t2: near + span},
        {x1: 0, y1: bottom, x2: c, y2: height, s1: near, t1: far, s2: near + span, t2: far + span},
        {x1: right, y1: bottom, x2: width, y2: height, s1: far, t1: far, s2: far + span, t2: far + span},
        // edges, stretched from the one-pixel strip that sits in the middle of each
        {x1: c, y1: 0, x2: right, y2: c, s1: edge, t1: near, s2: edge + strip, t2: near + span},
        {x1: c, y1: bottom, x2: right, y2: height, s1: edge, t1: far, s2: edge + strip, t2: far + span},
        {x1: 0, y1: c, x2: c, y2: bottom, s1: near, t1: edge, s2: near + span, t2: edge + strip},
        {x1: right, y1: c, x2: width, y2: bottom, s1: far, t1: edge, s2: far + span, t2: edge + strip},
    ];
}

/** Pipelines, one per shadow style; each holds its own baked buffer as its layer. */
const pipelines = new Map();

/**
 * Clears the baked pipeline cache. Called when the extension is disabled
 * so no module-scope pipeline or texture handles survive in memory.
 */
export function destroy() {
    pipelines.clear();
}

/**
 * The pipeline that draws a shadow style, from the cache or freshly baked. Windows
 * sharing a style share the pipeline.
 *
 * @param {Cogl.Context} context - Cogl context, which only exists inside a paint
 * @param {number} radius - Corner radius the shadow is drawn with
 * @param {Array<object>} shadows - Style shadow layers
 * @returns {Cogl.Pipeline|null} null when the buffer could not be allocated
 */
function shadowPipeline(context, radius, shadows) {
    const key = `${radius}|${shadows.map(s => `${s.blur},${s.spread},${s.alpha}`).join(';')}`;
    const cached = pipelines.get(key);
    if (cached)
        return cached;

    const pipeline = bake(context, radius, shadows);
    // A bake that could not allocate is not remembered, so the next paint retries it
    // rather than leaving the window without a shadow for the rest of the session.
    if (pipeline)
        pipelines.set(key, pipeline);
    return pipeline;
}

/**
 * A pipeline that draws one style's baked buffer with its own opacity.
 *
 * The sharing is on the texture, which is what costs memory; a pipeline per window lets
 * a window cross-fade between two styles without touching another window's colours. Cogl
 * compiles the program once per source, so the extra pipeline is a small state object.
 *
 * @param {Cogl.Context} context - Cogl context, which only exists inside a paint
 * @param {number} radius - Corner radius the shadow is drawn with
 * @param {Array<object>} shadows - Style shadow layers
 * @returns {Cogl.Pipeline|null} null when the buffer could not be allocated
 */
export function shadowPipelineFor(context, radius, shadows) {
    const source = shadowPipeline(context, radius, shadows);
    if (!source)
        return null;

    const pipeline = Cogl.Pipeline.new(context);
    pipeline.set_layer_texture(0, source.get_layer_texture(0));
    return pipeline;
}

/**
 * Sets a shadow pipeline's opacity, 0 to 1. The colour stays opaque white; only its
 * alpha changes, and Cogl's premultiplied blend scales the baked shadow by it.
 */
export function setPipelineOpacity(pipeline, opacity) {
    const alpha = Math.round(Math.max(0, Math.min(1, opacity)) * 255);
    pipeline.set_color(new Cogl.Color({red: 255, green: 255, blue: 255, alpha}));
}

function bake(context, radius, shadows) {
    const {buffer, window} = shadowGeometry(radius);

    const texture = Cogl.Texture2D.new_with_size(context, buffer, buffer);
    const framebuffer = Cogl.Offscreen.new_with_texture(texture);
    if (!framebuffer.allocate()) {
        console.warn(`[window-nativizer] Could not allocate a ${buffer}x${buffer} shadow buffer`);
        return null;
    }

    const pipeline = Cogl.Pipeline.new(context);
    // A pipeline starts with no colour, and the shader scales its output by the vertex
    // alpha, so an unset colour bakes an empty buffer. Cogl's blend is premultiplied:
    // opaque white leaves the fragment shader's own alpha to do the work.
    pipeline.set_color(opaqueWhite());
    // Cogl wants a snippet object; the shell's GLSL effect takes the same three pieces
    // inline. The code replaces the fragment stage's tail, which is what the effect's
    // non-replacing form does too.
    pipeline.add_snippet(Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE));
    uniform(pipeline, 'uWinSize', 2, [window, window]);
    uniform(pipeline, 'uRadius', 1, [radius]);
    uniform(pipeline, 'uPad', 2, [SHADOW_PAD, SHADOW_PAD]);
    for (let i = 0; i < LAYER_COUNT; i++) {
        const layer = shadows[i] ?? NO_SHADOW;
        uniform(pipeline, `uShadow${i + 1}`, 4, [layer.blur, layer.spread, layer.alpha, 0]);
    }

    // cogl_tex_coord0_in is what the shader maps, and it comes from a texture layer,
    // so the quad is drawn through a one-pixel placeholder.
    pipeline.set_layer_texture(0, Cogl.Texture2D.new_with_size(context, 1, 1));

    framebuffer.orthographic(0, 0, buffer, buffer, -1, 1);
    // The shader returns before writing anything for the window's interior (the hollow
    // mask), and an offscreen texture is not zeroed: without this, the pixels inside the
    // mask keep whatever the driver handed over, and the slices sample them wherever a
    // rounded corner leaves them visible.
    framebuffer.clear4f(CLEAR_COLOR_BUFFER, 0, 0, 0, 0);
    framebuffer.draw_textured_rectangle(pipeline, 0, 0, buffer, buffer, 0, 0, 1, 1);
    context.flush();

    const drawing = Cogl.Pipeline.new(context);
    drawing.set_color(opaqueWhite());
    drawing.set_layer_texture(0, texture);
    return drawing;
}

/**
 * Cogl's float setter takes the array with a separate count, and the GIR does not mark
 * the array's length, so whether GJS accepts that form has to be found out rather than
 * read off. Whichever works is kept for the session; the bake runs once per style.
 */
let setUniformFloat = null;

function uniform(pipeline, name, components, values) {
    const location = pipeline.get_uniform_location(name);
    if (!setUniformFloat) {
        try {
            pipeline.set_uniform_float(location, components, 1, values);
            setUniformFloat = (target, loc, n, v) => target.set_uniform_float(loc, n, 1, v);
        } catch {
            setUniformFloat = (target, loc, n, v) => target.set_uniform_float(loc, n, v);
        }
    }
    setUniformFloat(pipeline, location, components, values);
}
