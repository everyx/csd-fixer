/**
 * ShadowActor: shadow container underneath the window actor.
 *
 * Why a separate actor is needed: GLSL fragment shaders only execute within the actor's
 * own bounding box and cannot render outside its borders. The drawable shadow margin
 * must be allocated by this actor's size (window size + SHADOW_PAD * 2).
 *
 * Tracking mechanisms:
 *   - Geometry tracking (position and size): X/Y/WIDTH/HEIGHT dimensions are synchronized
 *     atomically by Clutter.BindConstraint inside the compositor core with zero JS frame overhead,
 *     avoiding needs_allocation warnings.
 *   - Animation tracking (open, close, minimize): bound via GObject.bind_property
 *     (scale-x/y, pivot-point, translation-x/y, opacity, visible), ensuring shadow follows
 *     window animations seamlessly.
 *   - Z-order (restacking): maintained via display 'restacked' signal in manager
 *     (set_child_below_sibling).
 *
 * Lifecycle: destroys cleanly upon windowActor 'destroy' signal with zero memory leaks.
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

/** Shadow padding: max blur 14 (sigma=7) + spread 5 = 26px (3*sigma), +2 safety margin */
export const SHADOW_PAD = 28;

export class ShadowActor {
    /**
     * @param {Clutter.Actor} windowActor Actor of the window being decorated
     * @param {Clutter.Actor} container   Container actor (windowGroup),
     *                                    shadow is inserted below windowActor
     */
    constructor(windowActor, container) {
        this._windowActor = windowActor;
        this._container = container;
        this._destroyed = false;

        this._actor = new St.Bin({
            name: 'CsdFixerShadowActor',
            reactive: false,
            opacity: 255,
            style: 'background-color: transparent;',
        });

        // Position and size tracking: X/Y/WIDTH/HEIGHT 4D constraints synchronized natively by Clutter C core
        // Avoids calling set_size in notify::allocation callback which breaks layout order and triggers
        // "Can't update stage views actor unnamed [StBin] is on because it needs an allocation" warnings.
        this._actor.add_constraint(new Clutter.BindConstraint({
            source: windowActor,
            coordinate: Clutter.BindCoordinate.X,
            offset: -SHADOW_PAD,
        }));
        this._actor.add_constraint(new Clutter.BindConstraint({
            source: windowActor,
            coordinate: Clutter.BindCoordinate.Y,
            offset: -SHADOW_PAD,
        }));
        this._actor.add_constraint(new Clutter.BindConstraint({
            source: windowActor,
            coordinate: Clutter.BindCoordinate.WIDTH,
            offset: SHADOW_PAD * 2,
        }));
        this._actor.add_constraint(new Clutter.BindConstraint({
            source: windowActor,
            coordinate: Clutter.BindCoordinate.HEIGHT,
            offset: SHADOW_PAD * 2,
        }));

        // Property and animation tracking: sync opacity, visibility, scale, pivot, translation with window
        // Ensures shadow smoothly tracks window scaling and fade during map, destroy, and minimize animations
        const syncProps = [
            'opacity',
            'visible',
            'pivot-point',
            'scale-x',
            'scale-y',
            'translation-x',
            'translation-y',
        ];
        this._bindings = [];
        for (const prop of syncProps) {
            this._bindings.push(windowActor.bind_property(
                prop, this._actor, prop, GObject.BindingFlags.SYNC_CREATE));
        }

        // Size tracking: drives shader uniform updates once allocation is ready without interfering with actor size
        this._lastW = 0;
        this._lastH = 0;
        this._allocId = windowActor.connect('notify::allocation',
            () => this._notifySizeChange());
        // Window actor destruction: fallback cleanup (manager normal path calls destroy first)
        this._destroyId = windowActor.connect('destroy', () => this.destroy());

        container.insert_child_below(this._actor, windowActor);

        this._relayoutCallbacks = [];
    }

    get actor() {
        return this._actor;
    }

    /** Size change callback (registered by manager to drive effect uniform updates) */
    onRelayout(cb) {
        this._relayoutCallbacks.push(cb);
    }

    /** Refresh uniforms with current window actor dimensions */
    relayout() {
        this._notifySizeChange(true);
    }

    _notifySizeChange(force = false) {
        if (this._destroyed)
            return;
        const w = this._windowActor.width;
        const h = this._windowActor.height;
        if (w === 0 || h === 0)
            return;  // Not yet mapped, waiting for allocation signal
        if (!force && w === this._lastW && h === this._lastH)
            return;
        this._lastW = w;
        this._lastH = h;
        for (const cb of this._relayoutCallbacks)
            cb(w, h);
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._relayoutCallbacks = [];
        for (const b of this._bindings)
            b.unbind();
        this._bindings = [];
        // Window actor may already be destroyed, disconnect may throw
        try {
            this._windowActor.disconnect(this._allocId);
            this._windowActor.disconnect(this._destroyId);
        } catch {
            // Actor destroyed: signals released automatically
        }
        try {
            this._container.remove_child(this._actor);
        } catch {
            // Container may already be destroyed
        }
        this._actor.destroy();
        this._actor = null;
    }
}
