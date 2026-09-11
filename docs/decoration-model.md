# How a window's decoration is decided

Background for `src/lib/detector.js`. The decisions live in the code; this records
the model they implement, and the places where it deliberately diverges from what
Mutter does, so a change there does not have to rediscover them.

> ego-lint warns when a file is more than half comments. `detector.js` is mostly
> policy, and policy wants reasons, so it sits near that line: rationale the call
> site does not need belongs here rather than in the module.

## Four layers, applied in order

```
can we decorate it?   window type, maximized, already server-decorated   ── no ──▶ leave it
is it already drawn?  declared margins, X11 native shadow                ── yes ─▶ leave it
your rules?           suppress / force, moving only the axes they name
any policy?           tiled neighbour, crisp text on fractional scaling
                      └───────────────────────────────▶ draw
```

1. **Structural eligibility** — `checkDecorationEligibility()`. Window type,
   maximized/fullscreen, server-side decorations. These are facts about the
   window, and a user rule must never override them.
2. **Inferred baseline** — `inferDecorationBaseline()`. Whether the client already
   draws its own shadow (it reserved content margins for one) or, on X11, whether
   Mutter draws one itself. Both axes answer alike, because every reason here is
   about the window as a whole; they are kept separate so a rule can move one and
   leave the other to this layer.
3. **User rules** — `src/lib/rules.js`. `suppress-rules` and `force-rules` move the
   axes they name, in one direction. The only layer that may turn an axis back on.
4. **State modifiers** — inside `evaluateWindowActions()`. Applied last, on top of
   both of the above, because they are visual policies rather than inferences about
   who already paints what.

A `force` rule overrides layer 2 and nothing else: it exists to correct a wrong
inference, not to overrule a fact or a policy.

## Where we deliberately differ from Mutter

- **X11 / XWayland without custom frame extents.** Mutter's C core draws the box
  shadow itself (`meta-window-actor-x11.c`, `has_shadow()`), so we decorate nothing
  at all — corners included. Rounding the contents while Mutter's square shadow
  follows the square frame would leave shadow corners poking out past the rounded
  content. That is a consistency call rather than a fact, which is exactly why a
  `force` rule is allowed to override it. X11 windows that *do* declare frame
  extents (WeChat's 4px resize grip) make Mutter drop its native shadow, so those
  are decorated like any other window.
- **A snap-tiled window keeps its corners but loses its shadow** when it has an
  adjacent match, following Mutter's own reasoning that the shadow would obstruct
  the neighbour (`meta-window-actor-x11.c`). A lone half-tiled window keeps the
  shadow on its outer edge.
- **Corner clipping is skipped under fractional scaling** when the user prefers
  crisp text: the offscreen pass is what blurs text at non-integer scales.

## The margins, and the scale question

`computeInsets()` reads `buffer_rect - frame_rect`. MetaWindow scales both
rectangles by the same window geometry scale, so their difference is the margin the
client declared. That scale is 1 whenever the logical monitor layout is LOGICAL,
and the native backend always reports that
(`meta-window-wayland.c`, `get_window_geometry_scale_for_logical_monitor`) — so on
Wayland the margin is already in logical pixels and compares directly against the
logical threshold.

A backend that lays monitors out physically scales the margin by the integer
monitor scale instead. GJS cannot read that scale:
`meta_backend_is_stage_views_scaled()` is private, and the layout mode is not in
the GIR. The margin is therefore left as it comes, which on such a backend reads
larger than it is — never smaller — so the error stays on the side of declining to
draw.

## Which style applies

`style.js` turns a window state into the parameters we draw, tracking libadwaita's
`window.csd` so a decorated window looks like a native one. The precedence mirrors
libadwaita's own CSS selectors:

    fullscreen > maximized > tiled > focused | backdrop

The result is `{radius, shadows, outline}`: the corner radius, up to three shadow
layers (`{blur, spread, alpha, color}`), and the outline libadwaita paints around a
decorated window. Fullscreen, maximized and tiled windows get neither outline nor
shadows — they are flush with the screen edge, where a shadow would be a line on it.
High contrast — upstream's `@media (prefers-contrast: more)` — replaces the shadow set
and deepens the outline from 7% to 30%.

## What the decoration costs

One offscreen per decorated window, plus one baked buffer per shadow style for the whole
session:

| Part | Where | Size |
|---|---|---|
| clip | `clipEffect.js`, on the window actor | window size + 3px, ~8.3 MB at 1920x1080 |
| shadow | `shadowTexture.js`, baked once per style | 145x145, ~82 KB, shared by every window |

The clip pass is skipped when there is nothing to clip (radius 0, or no outline) and a
window with no shadow never touches a baked buffer.

The shadow's buffer is small because a shadow is a blurred rounded rectangle: its pixels
depend on the window's size only through the length of its straight edges, so four corners
and a one-pixel strip from each edge describe the whole shape and the strips stretch. That
is Mutter's approach as well: `MetaShadow` (`src/x11/meta-shadow-factory.c`) is a
`CoglTexture` rendered once and painted as a nine-slice. The bake draws the same GLSL the
generator takes from GTK4, so this stays the upstream shadow, computed once instead of
every frame.

Mutter never needs the clip pass, and Shell 45-50 ships no rounded-clip effect (the
typelib has `BlurEffect` and nothing else): a window that decorates itself also rounds
itself and arrives with alpha, so the compositor has nothing left to clip. Decorating
windows that do not round themselves is what makes an offscreen pass inherent here.

## How a style change is drawn

A change is cross-faded over 200ms with CSS `ease-out`, which is what the source of these
numbers does: libadwaita's backdrop rule declares `transition: box-shadow
$backdrop_transition`, and `$backdrop_transition` is `200ms ease-out`.

Upstream also makes the *biggest* shadow layer **transparent** in the backdrop state, with
the comment "to enforce that the shadow extents don't change when we go to backdrop, to
prevent jumping windows". That is why the backdrop set looks like it loses its shadow:
the visible one becomes the smaller remaining layer, and the reserved space stays put. Our
padding is fixed for the same reason, so a change never resizes the shadow.

Mutter's own window shadows behave differently, and the difference is worth knowing
because it is not the model we follow: `default_shadow_classes[]`
(`src/x11/meta-shadow-factory.c`) gives a normal window `{radius 10, opacity 128}` focused
and `{radius 8, opacity 64}` unfocused, so its unfocused shadow only weakens and tightens.
It keeps both cached and swaps between them with no transition, and recomputes lazily when
the window shape or focus changes.

## What is not introspectable at all

`has_shadow()` also gates on ARGB32 windows, shaped windows, and
`has_custom_frame_extents`, none of which GJS can see. A partial reimplementation
would flip the error toward double shadows instead, so those windows are left to a
`force` rule.
