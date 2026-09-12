# Aligning the decoration with libadwaita

The decoration is meant to be indistinguishable from libadwaita's client-side decoration.
This is what that means numerically, how it was measured, what is known, and what is still
open. It exists because the knowledge below cost a great deal to acquire and is not visible
anywhere in the code.

## What is being aligned

libadwaita draws `window.csd` as a rounded rectangle with `box-shadow` and a 1px outline; the
values are generated into `src/lib/adwaitaStyle.generated.js`. Mutter's own X11 window shadows
are **not** the model (they are cached per focus state and swapped with no transition); they
are recorded in `decoration-model.md` as a contrast.

Two things are drawn, and they have different mechanisms:

| Part | Where it lives | Notes |
| --- | --- | --- |
| Rounded clip + inner outline | `ClipEffect` on the window actor | skipped entirely under some settings, see below |
| Shadow | `CsdFixerShadowActor`, a **sibling** of the window actor | one baked 145x145 texture per style, nine-slice |

Because the shadow is a sibling and the clip is an effect, a window-scoped screenshot
(`ScreenshotWindow`) can never contain the shadow. Only a full-desktop screenshot shows both.

## The measurement that works

A window with a **known body colour** over a **white backdrop**, profiled pixel by pixel
outward from the window edge, all three channels. Red body + white background + black shadow
separate three things in one profile: body, outline, shadow.

`tools/probe-window.js` takes `CSD_FIXER_BODY=#ff0000` for exactly this; with
`CSD_FIXER_BACKDROP=1` it is the white surface. `CSD_FIXER_MODE=native` renders the same
window through libadwaita as the reference.

Profiles must step **outward** on all four sides (top and left step negative) and must be
read in **physical** pixels: a screenshot is `logical x ceil-less resource scale` — on a
1.3333 display a 1280x800 monitor yields a 1707x1067 image.

### A native window's edge looks like this

Red body, bottom edge, offsets from the last pixel inside the window:

```
offset   -3   -2   -1    0    1    2    3    4    5
R       255  255  255  248  200  215  219  223  227
G         0    0   12   37  200  215  219  223  227
```

`G=12` at -1 is libadwaita's inner 1px highlight (white over red, about 5%; the generated
style says 7%). `0` is the anti-aliased body edge. `+1` and beyond is the shadow: the first
shadow pixel is a 1px border ring (`0 0 0 1px rgba(0,0,0,0.15)`, which the generated style has
as `shadows: [{blur: 0, spread: 1, alpha: 0.15}]`).

## The setting that silently disables half of this

`prefer-crisp-text` (default false) plus a fractional-scale monitor means
`shouldClipWindow()` returns false and **no clip effect is attached at all**: square corners,
no inner outline, and the shadow is baked against a square outline instead. On the machine
this was developed on the setting is `true` and the monitor is at 1.3333, so every early
measurement compared a square decoration against a rounded one and produced a phantom "1
pixel edge offset" that was chased for a long time.

Before measuring corners or the outline:

```bash
gsettings set org.gnome.shell.extensions.csd-fixer prefer-crisp-text false   # and restore it
```

This is a real trade-off, not a bug: clipping is an offscreen per window, and the option
exists to avoid text blur and resampling on fractional-scale displays.

## The overview, which is not the shell showing it

- **It is never raised by the shell on its own.** Two runs of 29s and 17s with no input and
  no interaction left `OverviewActive` false throughout.
- **It is sometimes already up when a devkit session becomes usable**, and around startup a
  hide does not always stick; later, one hide sticks.
- **Exiting it is one D-Bus write**, which the shell maps onto its own `Main.overview.hide()`
  (`shellDBus.js`):

```bash
gdbus call --dest org.gnome.Shell --object-path /org/gnome/Shell \
  --method org.freedesktop.DBus.Properties.Set org.gnome.Shell OverviewActive '<false>'
```

- **Judges that lied**, both measured: the overview actor stays `mapped=true` while the
  overview is hidden, and `Main.overview.visible` was true while a screenshot showed a plain
  desktop. The D-Bus property is the one that agreed with the pixels.
- **A screenshot must be a transaction**: hide, check, shoot, check again, discard and retry
  if the state changed, refuse if it never holds. That is what finally made a measurement
  trustworthy: with it, a shot taken right after a session start still measured a clean
  desktop (mean 97, against 37 with the overview up).

## Facts that cost the most

- `pkill -f 'gnome-shell --devkit'` matches **the command line that runs it**. Use the
  `gnome-shel[l]` bracket trick, or a script file.
- `Eval` answers `(false, '')` in some sessions while the shell is perfectly usable. Read
  state from D-Bus properties instead of requiring Eval.
- The shell's own startup notification banner landed inside a measurement region and produced
  a 171 grey-level difference that had nothing to do with the decoration.
- A `ClutterOffscreenEffect`'s offscreen is not the actor's box: Clutter enlarges it to a
  stable size, `_clutter_actor_box_enlarge_for_effects` (`clutter-actor-box.c:505`) gives
  three pixels per axis split around the actor — two on the left/top and one on the
  right/bottom for an integer position — and the whole box is then multiplied by
  `ceilf(resource_scale)`, which is **2** for a 1.3333 monitor, not 1.3333.
- `clutter_offscreen_effect_paint_texture` applies `1/resource_scale` and the `fbo_offset`
  in one matrix. Read the order in Graphene rather than assuming it.
- Measured live values for a 440x280 window: `w=440.0000 h=280.0000`, `pad=2.0000,2.0000`,
  `target=[true, 886, 566]` (= (440+3)x(280+3) at 2x).
- `move_resize_frame` to the work area, never `maximize()`: a maximize animation in a nested
  session never finishes.
- ES modules are not hot-reloaded: every change needs a fresh shell.
- Sessions must be torn down by display ownership (anything whose `WAYLAND_DISPLAY` is not
  `wayland-0`), or the devkit window outlives the shell it was showing.

## Where the alignment stands

With clipping enabled and a 440x280 window, profiles outward from the window edge, ours
against the native: the shadow converges (at +4 and +5 we are within 1-4 grey levels) but

- our inner highlight appears on the **right edge only** (G=133 at the last pixel inside)
  and not on the top, bottom or left (G=0), while libadwaita has it on all four;
- the value on the right is far too strong for `alpha: 0.07`, which points at the clip's
  own anti-aliasing leaking the shadow rather than at the outline itself;
- our first shadow pixel is about 12 levels darker than the native's (186-188 against
  198-200).

An experiment that painted the shader's `d` into the output produced **no change at all** —
and that run was made while `prefer-crisp-text` was true, so the clip was not attached and
the experiment tested nothing. Redoing it with clipping on is the obvious next step: it turns
the shader's own coordinate into a number, which settles the geometry instead of arguing
about Clutter's matrix order.

## Next steps

1. Redo the `d`-painting experiment with clipping enabled, and read `d` across all four
   edges. Expect `d = -0.5` at the last pixel inside if the pad model is right.
2. From that, fix whichever of the pad, the quad size or the texture coordinate mapping is
   wrong, then re-run the profile and require the four edges to agree.
3. Only then compare the shadow's first pixel, which is currently darker than the native's.
4. Decide the `prefer-crisp-text` default policy separately; it is a trade-off, not a defect.

Do not rebuild a test harness before step 1 is answered: the harnesses built so far were
more complex than the problem and produced as many wrong conclusions as right ones.
