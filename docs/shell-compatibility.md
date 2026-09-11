# The Shell / Mutter API surface we depend on

Checked against the Shell 45–50 typelibs and Mutter's C source. Anything here that
stops being true is a compatibility break, not a refactor.

| Used | Status | Notes |
|---|---|---|
| `win.get_client_type()` | 45–50 stable | returns `Meta.WindowClientType`; the only reliable way to tell a Wayland client from an X11 one |
| `win.decorated` | 45–50 stable | GObject property: whether Mutter drew a frame (server-side decorations) |
| `win.is_client_decorated()` | **does not exist** | a GTK concept; `Meta.Window` has no counterpart |
| `win.is_maximized()` | 45–50 stable | canonical `meta_window_is_maximized` |
| `win.get_tile_match()` | 45–50 stable | the adjacent matching tile, or null |
| `global.display.get_monitor_scale(i)` | 45–50 stable | fractional scale, so it is not an integer; called through optional chaining |
| `global.backend.get_monitor_manager()` | 45–50 stable | called through optional chaining |

What GJS cannot see at all — the window geometry scale, Mutter's own shadow gates —
is in [decoration-model.md](decoration-model.md).

## Working rules

- **The decisions are pure.** Everything that decides decoration delegates to
  `detector.evaluateWindowActions()`; the shell-side modules only gather inputs and
  apply effects. That is what makes the behaviour testable outside a session.
- **`enable()` and `disable()` are idempotent.** After `disable()` nothing of ours
  remains: no connected signals, no actors, no pending sources.
- **Signals that may not exist are connected in "safe" mode.** Window- and
  actor-level signals vary across 45–50, and the object can be unmanaged while we
  connect, so a failure there is expected and swallowed. A failure on a global
  signal is not: it means an API assumption is wrong.
