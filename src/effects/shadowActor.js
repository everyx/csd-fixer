/**
 * ShadowActor: the shadow of one window, drawn from a baked texture.
 *
 * Geometry is the compositor's job. Four Clutter.BindConstraint sync the padded rect
 * with the window actor and seven property bindings carry opacity, visibility, pivot,
 * scale and translation through the map, close and minimize animations, so neither a
 * frame nor a resize costs any JavaScript.
 *
 * Painting is eight texture rectangles out of one baked buffer (shadowTexture.js):
 * four corners, four edges stretched from a one-pixel strip, and no middle, because
 * the shader's hollow mask leaves the window's interior transparent.
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import {shadowGeometry, shadowPipeline, shadowSlices, SHADOW_PAD} from './shadowTexture.js';

export {SHADOW_PAD};

/** Properties that carry the shadow through the window's own animations. */
const SYNCED_PROPERTIES = [
    'opacity', 'visible', 'pivot-point', 'scale-x', 'scale-y', 'translation-x', 'translation-y',
];

export const ShadowActor = GObject.registerClass({
    GTypeName: 'CsdFixerShadowActor',
}, class ShadowActor extends Clutter.Actor {
    /**
     * @param {Clutter.Actor} windowActor - Actor of the window being decorated
     * @param {Clutter.Actor} container - Container actor (windowGroup), which the
     *   shadow is inserted below
     */
    _init(windowActor, container) {
        super._init({name: 'CsdFixerShadowActor', reactive: false, opacity: 255});

        this._windowActor = windowActor;
        this._container = container;
        this._style = null;
        this._pipeline = null;
        this._laidOutWidth = -1;
        this._laidOutHeight = -1;
        this._slices = [];
        this._boxes = [];

        for (const [coordinate, offset] of [
            [Clutter.BindCoordinate.X, -SHADOW_PAD],
            [Clutter.BindCoordinate.Y, -SHADOW_PAD],
            [Clutter.BindCoordinate.WIDTH, SHADOW_PAD * 2],
            [Clutter.BindCoordinate.HEIGHT, SHADOW_PAD * 2],
        ])
            this.add_constraint(new Clutter.BindConstraint({source: windowActor, coordinate, offset}));

        this._bindings = SYNCED_PROPERTIES.map(property => windowActor.bind_property(
            property, this, property, GObject.BindingFlags.SYNC_CREATE));

        this._destroyId = windowActor.connect('destroy', () => this.destroy());

        container.insert_child_below(this, windowActor);
    }

    /**
     * Draw this shadow: corner radius and shadow layers, already resolved for the
     * window's state. The bake happens at the first paint after this, because the
     * Cogl context does not exist outside one.
     *
     * @param {{radius: number, shadows: Array<object>}} style
     */
    setShadowStyle(style) {
        this._style = style;
        this._pipeline = null;
    }

    vfunc_paint_node(node, paintContext) {
        if (!this._style)
            return;

        if (!this._pipeline) {
            this._pipeline = shadowPipeline(paintContext.get_framebuffer().get_context(),
                this._style.radius, this._style.shadows);
        }
        if (!this._pipeline)
            return;

        if (this._laidOutWidth !== this.width || this._laidOutHeight !== this.height)
            this._relayout();

        const pipelineNode = new Clutter.PipelineNode(this._pipeline);
        node.add_child(pipelineNode);
        for (let i = 0; i < this._slices.length; i++) {
            const slice = this._slices[i];
            const box = this._boxes[i];
            box.set_origin(slice.x1, slice.y1);
            box.set_size(slice.x2 - slice.x1, slice.y2 - slice.y1);
            pipelineNode.add_texture_rectangle(box, slice.s1, slice.t1, slice.s2, slice.t2);
        }
    }

    /** Destination boxes follow the actor's size; the sources never change. */
    _relayout() {
        this._slices = shadowSlices(shadowGeometry(this._style.radius), this.width, this.height);
        this._boxes = this._slices.map(() => new Clutter.ActorBox());
        this._laidOutWidth = this.width;
        this._laidOutHeight = this.height;
    }

    destroy() {
        for (const binding of this._bindings)
            binding.unbind();
        this._bindings = [];
        try {
            this._windowActor.disconnect(this._destroyId);
        } catch {
            // Window actor already destroyed: its signals went with it
        }
        this._pipeline = null;
        try {
            this._container?.remove_child(this);
        } catch {
            // Container may already be destroyed
        }
        this._container = null;
        super.destroy();
    }
});
