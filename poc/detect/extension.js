import Meta from 'gi://Meta';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

function logWindow(actor) {
    const win = actor.metaWindow;
    if (!win) return;
    const buf = win.get_buffer_rect();
    const frame = win.get_frame_rect();
    const scale = actor.get_geometry_scale?.() ?? 1;
    const type = win.get_client_type() === Meta.WindowClientType.X11 ? 'X11' : 'WL';

    const bufWLog = buf.width / scale;
    const bufHLog = buf.height / scale;
    const deltaW = bufWLog - frame.width;
    const deltaH = bufHLog - frame.height;
    const noCSD = Math.abs(deltaW) < 1 && Math.abs(deltaH) < 1;

    console.log(`[detect] ${type} scale=${scale} wmClass=${win.wmClass} "${(win.get_title() ?? '').slice(0, 40)}"`);
    console.log(`[detect]   buffer(px)=${buf.width}x${buf.height} frame(log)=${frame.width}x${frame.height}  buf/scaled=${bufWLog.toFixed(1)}x${bufHLog.toFixed(1)}`);
    console.log(`[detect]   Δ=${deltaW.toFixed(1)}x${deltaH.toFixed(1)}  => ${noCSD ? 'NO-CSD(需补装饰)' : '有CSD(跳过)'}`);
    console.log(`[detect]   decorated=${win.decorated} max=${win.maximizedHorizontally}/${win.maximizedVertically} fs=${win.fullscreen} type=${win.windowType}`);
}

export default class DetectPoc extends Extension {
    enable() {
        console.log('[detect] enabled');
        for (const actor of global.get_window_actors())
            logWindow(actor);
        this._onCreated = global.display.connect('window-created', (_d, win) => {
            const actor = win.get_compositor_private();
            if (!actor)
                return;
            logWindow(actor);
            // 首帧纹理未就绪时 buffer 是 0x0，等 size-changed 再打一次
            const texture = actor.get_texture?.();
            if (texture) {
                texture.connect('size-changed', () => logWindow(actor));
            }
            actor.connect('notify::first-child', () => {
                const t2 = actor.get_texture?.();
                if (t2)
                    t2.connect('size-changed', () => logWindow(actor));
            });
        });
    }
    disable() {
        global.display.disconnect(this._onCreated);
        console.log('[detect] disabled');
    }
}
