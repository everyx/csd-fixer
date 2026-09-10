/**
 * Interactive Window Inspector and D-Bus Service.
 *
 * Benchmarked against KDE KWin's window selection and property detection pipeline:
 * - KWin: InputRedirection::startInteractiveWindowSelection + clientToVariantMap (src/input.cpp, src/dbusinterface.cpp)
 * - Mutter / GNOME Shell: Main.pushModal + global.stage.set_cursor_type + Clutter event grab
 *
 * D-Bus Interface:
 *   Bus Name:  org.gnome.Shell.Extensions.CsdFixer
 *   Path:      /org/gnome/Shell/Extensions/CsdFixer
 *   Interface: org.gnome.Shell.Extensions.CsdFixer
 *   Method:    PickWindow() -> a{ss}
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {INSPECTOR_DBUS_NAME, INSPECTOR_DBUS_PATH, isDialogWindow} from './detector.js';

const INSPECTOR_DBUS_IFACE_XML = `
<node>
  <interface name="${INSPECTOR_DBUS_NAME}">
    <method name="PickWindow">
      <arg type="a{ss}" direction="out" name="properties"/>
    </method>
  </interface>
</node>`;

export class InspectorService {
    constructor() {
        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(INSPECTOR_DBUS_IFACE_XML, this);
        this._dbusImpl.export(Gio.DBus.session, INSPECTOR_DBUS_PATH);
        this._ownerId = Gio.DBus.session.own_name(
            INSPECTOR_DBUS_NAME,
            Gio.BusNameOwnerFlags.REPLACE,
            null,
            null
        );

        this._activeGrab = null;
        this._overlay = null;
        this._highlight = null;
        this._pendingInvocation = null;
    }

    destroy() {
        this._cancelInteractivePick();

        if (this._ownerId) {
            Gio.DBus.session.unown_name(this._ownerId);
            this._ownerId = null;
        }

        if (this._dbusImpl) {
            this._dbusImpl.unexport();
            this._dbusImpl = null;
        }
    }

    /**
     * D-Bus method: PickWindowAsync
     */
    PickWindowAsync(_params, invocation) {
        if (this._pendingInvocation) {
            invocation.return_error_literal(
                Gio.IOErrorEnum,
                Gio.IOErrorEnum.BUSY,
                'Window inspection is already in progress'
            );
            return;
        }

        this._pendingInvocation = invocation;
        this._startInteractivePick();
    }

    // ---------- Interactive Picking Implementation ----------

    _findTargetWindow(stageX, stageY) {
        const actors = global.get_window_actors?.() ?? [];
        for (let i = actors.length - 1; i >= 0; i--) {
            const winActor = actors[i];
            const win = winActor.meta_window ?? winActor.metaWindow;
            if (!win || win.minimized || (win.is_hidden && win.is_hidden()))
                continue;
            if (winActor.is_mapped && !winActor.is_mapped())
                continue;

            const activeWorkspace = global.workspace_manager?.get_active_workspace?.();
            if (activeWorkspace && !win.is_on_all_workspaces?.() && !win.located_on_workspace?.(activeWorkspace))
                continue;

            const type = win.get_window_type?.() ?? Meta.WindowType.NORMAL;
            if (type === Meta.WindowType.DESKTOP || type === Meta.WindowType.DOCK)
                continue;

            const frame = win.get_frame_rect();
            if (stageX >= frame.x && stageX < frame.x + frame.width &&
                stageY >= frame.y && stageY < frame.y + frame.height)
                return win;
        }
        return null;
    }

    _startInteractivePick() {
        // 1. Overlay to capture global mouse and keyboard events
        this._overlay = new St.Widget({
            name: 'CsdFixerInspectorOverlay',
            reactive: true,
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height,
        });
        Main.uiGroup.add_child(this._overlay);

        // 2. Visual highlight border box
        this._highlight = new St.Widget({
            name: 'CsdFixerInspectorHighlight',
            style: 'border: 3px solid #3584e4; background-color: rgba(53, 132, 228, 0.15); border-radius: 12px;',
            visible: false,
        });
        Main.uiGroup.add_child(this._highlight);

        // 3. Event bindings
        this._overlay.connect('motion-event', (_actor, event) => {
            const [x, y] = event.get_coords();
            const targetWin = this._findTargetWindow(x, y);
            if (targetWin) {
                const frame = targetWin.get_frame_rect();
                this._highlight.set_position(frame.x, frame.y);
                this._highlight.set_size(frame.width, frame.height);
                this._highlight.visible = true;
            } else {
                this._highlight.visible = false;
            }
            return Clutter.EVENT_STOP;
        });

        this._overlay.connect('button-press-event', (_actor, event) => {
            const button = event.get_button();
            if (button === Clutter.BUTTON_PRIMARY) {
                const [x, y] = event.get_coords();
                const targetWin = this._findTargetWindow(x, y);
                this._finishInteractivePick(targetWin);
            } else {
                // Right click or other buttons cancel
                this._finishInteractivePick(null);
            }
            return Clutter.EVENT_STOP;
        });

        this._overlay.connect('key-press-event', (_actor, event) => {
            const symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_Escape)
                this._finishInteractivePick(null);
            return Clutter.EVENT_STOP;
        });

        // 4. Modal grab and crosshair cursor
        this._activeGrab = Main.pushModal(this._overlay);
        global.stage.set_cursor_type(Clutter.CursorType.CROSSHAIR);
    }

    _finishInteractivePick(win) {
        const invocation = this._pendingInvocation;
        this._pendingInvocation = null;

        this._cleanupPickUI();

        if (!invocation)
            return;

        if (!win) {
            // Cancelled or no window clicked
            invocation.return_value(new GLib.Variant('(a{ss})', [{}]));
            return;
        }

        const wmClass = win.get_wm_class?.() ?? win.get_sandboxed_app_id?.() ?? '';
        const title = win.get_title?.() ?? '';
        const windowType = win.get_window_type?.() ?? Meta.WindowType.NORMAL;
        const hasParent = Boolean(win.get_transient_for?.());
        const allowsResize = Boolean(win.allows_resize?.());
        const isAttachedDialog = Boolean(win.is_attached_dialog?.());
        const isDialog = isDialogWindow({windowType, hasParent, isAttachedDialog});

        const properties = {
            wmClass,
            title,
            'isDialog': isDialog ? 'true' : 'false',
            'hasParent': hasParent ? 'true' : 'false',
            'allowsResize': allowsResize ? 'true' : 'false',
            'windowType': String(windowType),
        };

        invocation.return_value(new GLib.Variant('(a{ss})', [properties]));
    }

    _cancelInteractivePick() {
        if (this._pendingInvocation) {
            const inv = this._pendingInvocation;
            this._pendingInvocation = null;
            try {
                inv.return_value(new GLib.Variant('(a{ss})', [{}]));
            } catch {
                // Ignore if invocation already answered
            }
        }
        this._cleanupPickUI();
    }

    _cleanupPickUI() {
        if (this._activeGrab) {
            Main.popModal(this._activeGrab);
            this._activeGrab = null;
        }

        try {
            global.stage?.set_cursor_type?.(Clutter.CursorType.DEFAULT);
        } catch {
            // Ignore if stage is unmanaging
        }

        if (this._highlight) {
            this._highlight.destroy();
            this._highlight = null;
        }

        if (this._overlay) {
            this._overlay.destroy();
            this._overlay = null;
        }
    }
}
