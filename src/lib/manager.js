/**
 * Manager — 扩展核心状态机。
 *
 * 职责：
 *   - 监听窗口创建/销毁/状态变化（幂等：每事件重新求值 → 对比 → 增删效果）
 *   - 读 GSettings（黑白名单、XWayland 跳过、debug）
 *   - 对每个判定命中的窗口挂载装饰效果（effects/shadow 模块）
 *
 * 设计约束：
 *   - 所有窗口状态读取都走 detector.shouldDecorate（纯函数，可单测）
 *   - enable/disable 幂等，disable 后零残留（无信号泄漏、无孤儿 actor）
 */

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {shouldDecorate, shouldClipWindow} from './detector.js';
import {styleForWindow} from './style.js';
import {RoundedClipEffect} from '../effects/clipEffect.js';
import {SdfShadowEffect} from '../effects/shadowEffect.js';
import {ShadowActor, SHADOW_PAD} from '../effects/shadowActor.js';

const DEBUG_KEY = 'debug';

export class Manager {
    /** @param {import('../extension.js').default} ext */
    constructor(ext) {
        this._ext = ext;
        this._settings = ext.getSettings();
        this._windows = new Map();  // Meta.Window → decorations state
        this._signals = [];
    }

    enable() {
        // display 级事件（全局）
        const wm = global.windowManager;
        this._connect(wm, 'switch-workspace', () => this._reconcile());
        this._connect(global.display, 'window-created', (_, win) => this._trackWindow(win));
        this._connect(global.display, 'grab-op-end', () => this._reconcile());
        // 窗口 restack（focus/raise/lower）→ 阴影 actor 必须跟着窗口重新垫底
        // （rwc 同款：insert_child_below 只在插入时有效，restack 后需重新 set）
        this._connect(global.display, 'restacked', () => this._restackShadows());
        // 焦点切换（active ↔ backdrop 阴影深度切换）
        this._connect(global.display, 'notify::focus-window', () => this._reconcileDebounced());

        // 监听显示器变化（缩放改变、外接屏插拔等）
        const monitorManager = global.backend?.get_monitor_manager?.();
        if (monitorManager)
            this._connect(monitorManager, 'monitors-changed', () => this._reconcile());

        // GSettings 变化 → 全量重判（所有键）
        this._settingsHandlerIds = [];
        for (const key of ['blacklist', 'whitelist', 'skip-xwayland', 'prefer-crisp-text', DEBUG_KEY]) {
            const id = this._settings.connect(`changed::${key}`, () => this._reconcile());
            this._settingsHandlerIds.push(id);
        }

        // 已存在的窗口（扩展中途启用）
        for (const win of global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null))
            this._trackWindow(win);
        this._reconcile();
    }

    disable() {
        if (this._reconcileTimeout) {
            GLib.Source.remove(this._reconcileTimeout);
            this._reconcileTimeout = null;
        }
        for (const [win] of this._windows)
            this._undecorate(win);
        this._windows.clear();
        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        this._signals = [];
        this._settingsHandlerIds?.forEach(id => this._settings.disconnect(id));
        this._settingsHandlerIds = [];
    }

    // ---------- 内部 ----------

    _connect(obj, signal, handler) {
        this._signals.push([obj, obj.connect(signal, handler)]);
    }

    _trackWindow(win) {
        if (this._windows.has(win))
            return;
        this._windows.set(win, {decorated: null, signals: []});
        // 窗口级信号（位置/尺寸/焦点/显示器变化 → 幂等重判）
        const windowSignals = [
            'position-changed', 'size-changed', 'notify::appears-focused',
            'notify::maximized-horizontally', 'notify::maximized-vertically',
            'notify::fullscreen', 'notify::main-monitor', 'highest-scale-monitor-changed',
        ];
        for (const sig of windowSignals) {
            try {
                this._windows.get(win).signals.push([win, win.connect(sig, () => this._reconcileDebounced())]);
            } catch (e) {
                // 部分 Mutter 版本可能缺少某些信号，静默忽略
            }
        }
        this._connect(win, 'unmanaging', () => this._forgetWindow(win));
        // actor allocation 变化（首帧尺寸 0 → 就绪重判 + 尺寸跟随）
        const actor = win.get_compositor_private();
        if (actor)
            this._windows.get(win).signals.push([actor, actor.connect('notify::allocation',
                () => this._reconcileDebounced())]);
        this._reconcileDebounced();
    }

    _forgetWindow(win) {
        const state = this._windows.get(win);
        if (state) {
            for (const [obj, id] of state.signals)
                obj.disconnect(id);
            // 关键：不要在 unmanaging 阶段同步调用 _undecorate(win)！
            // 此时窗口即将播放关闭动画并销毁；若在此刻提前拔掉 clipEffect，关闭动画期间
            // 窗口会瞬间退化为直角，导致原本被圆角裁切的关闭按钮和直角边缘闪现。
            // 保持 clipEffect 与 shadowActor，让它们随 windowActor 的 destroy 信号自然谢幕。
            if (this._settings.get_boolean(DEBUG_KEY))
                console.debug(`[csd-fixer] forget window (closing): ${win.get_wm_class()}`);
        }
        this._windows.delete(win);
    }

    _reconcileDebounced() {
        if (this._reconcileTimeout)
            return;
        this._reconcileTimeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 50, () => {
                this._reconcileTimeout = null;
                this._reconcile();
                return GLib.SOURCE_REMOVE;
            });
    }

    /** 获取窗口所在显示器的物理/逻辑缩放比例 */
    _getMonitorScale(win) {
        const monitor = win.get_monitor();
        if (monitor < 0)
            return 1;
        if (typeof global.display?.get_monitor_scale === 'function')
            return global.display.get_monitor_scale(monitor);
        return 1;
    }

    /** 是否应为该窗口启用离线圆角剪裁 */
    _shouldClipWindow(win) {
        const preferCrisp = this._settings.get_boolean('prefer-crisp-text');
        const scale = this._getMonitorScale(win);
        return shouldClipWindow({preferCrispText: preferCrisp, scale});
    }

    /** 动态同步已装饰窗口的 clipEffect（用于跨屏拖拽或设置实时切换） */
    _syncClip(win) {
        const state = this._windows.get(win);
        if (!state)
            return;
        const actor = win.get_compositor_private();
        if (!actor)
            return;

        const wantClip = this._shouldClipWindow(win);
        const hasClip = Boolean(state.clip);
        if (wantClip !== hasClip) {
            if (wantClip) {
                state.clip = new RoundedClipEffect();
                actor.add_effect(state.clip);
            } else {
                actor.remove_effect(state.clip);
                state.clip = null;
            }
        }
    }

    /** 全量幂等重判：对每个已跟踪窗口求值 → 与当前状态对比 → 增删 */
    _reconcile() {
        for (const [win, state] of this._windows) {
            // 窗口 actor 尚未就绪（首帧尺寸 0）→ 等 allocation 信号重判
            const actor = win.get_compositor_private();
            if (!actor || actor.width === 0 || actor.height === 0)
                continue;

            const want = this._evaluate(win);
            if (want !== state.decorated) {
                if (want)
                    this._decorate(win);
                else
                    this._undecorate(win);
                state.decorated = want;
            } else if (want) {
                this._syncClip(win);
            }
            // 已装饰的窗口：样式状态可能变（focus/tiled/maximized）→ 更新参数
            if (want)
                this._updateStyle(win);
        }
    }

    /** restack 后重排所有阴影 actor 到对应窗口下方（rwc onRestacked 同款） */
    _restackShadows() {
        for (const [win, state] of this._windows) {
            if (!state.decorated || !state.shadow)
                continue;
            const actor = win.get_compositor_private();
            if (!actor)
                continue;
            global.windowGroup.set_child_below_sibling(state.shadow.actor, actor);
        }
    }

    /** 读取窗口全部状态 → detector 判定 */
    _evaluate(win) {
        const actor = win.get_compositor_private();
        if (!actor)
            return false;
        const b = win.get_buffer_rect();
        const f = win.get_frame_rect();
        const hasSsd = Boolean(win.decorated && !win.is_client_decorated());
        const res = shouldDecorate({
            bufferWidth: b.width, bufferHeight: b.height,
            frameWidth: f.width, frameHeight: f.height,
            scale: actor.get_geometry_scale?.() ?? 1,
            isX11: win.get_client_type() === Meta.WindowClientType.X11,
            skipXwayland: this._settings.get_boolean('skip-xwayland'),
            isMaximized: win.maximized_horizontally && win.maximized_vertically,
            isFullscreen: win.is_fullscreen(),
            hasSsd,
            windowType: win.get_window_type(),
            wmClass: win.get_wm_class(),
            blacklist: this._settings.get_strv('blacklist'),
            whitelist: this._settings.get_strv('whitelist'),
        });
        if (this._settings.get_boolean(DEBUG_KEY)) {
            console.debug(`[csd-fixer] evaluate: "${win.get_title() ?? ''}" wmClass=${win.get_wm_class()} type=${win.get_window_type()} apply=${res.apply} reason=${res.reason} buf=${b.width}x${b.height} frame=${f.width}x${f.height}`);
        }
        return res.apply;
    }

    _decorate(win) {
        const actor = win.get_compositor_private();
        const state = this._windows.get(win);

        // 1) 圆角裁剪 + 内亮边：按需挂窗口 actor 本体
        if (this._shouldClipWindow(win)) {
            state.clip = new RoundedClipEffect();
            actor.add_effect(state.clip);
        } else {
            state.clip = null;
        }

        // 2) SDF 阴影：独立 actor 垫窗口下（尺寸含 PAD 余量）
        state.shadowFx = new SdfShadowEffect();
        state.shadow = new ShadowActor(actor, global.windowGroup);
        state.shadow.actor.add_effect(state.shadowFx);
        state.shadow.onRelayout((w, h) => {
            // 窗口尺寸变化：uniform 重设（样式不变时也需更新尺寸）
            const style = this._styleOf(win);
            this._applyStyle(win, style, w, h);
        });
        state.shadow.relayout();

        this._applyStyle(win, this._styleOf(win));
        if (this._settings.get_boolean(DEBUG_KEY))
            console.debug(`[csd-fixer] decorate: ${win.get_wm_class()} "${win.get_title() ?? ''}" ${actor.width}x${actor.height} (clip=${Boolean(state.clip)})`);
    }

    _undecorate(win) {
        const state = this._windows.get(win);
        if (!state)
            return;
        const actor = win.get_compositor_private();
        if (state.clip && actor) {
            actor.remove_effect(state.clip);
            state.clip = null;
        }
        if (state.shadow) {
            state.shadow.destroy();
            state.shadow = null;
            state.shadowFx = null;
        }
        if (this._settings.get_boolean(DEBUG_KEY))
            console.debug(`[csd-fixer] undecorate: ${win.get_wm_class()}`);
    }

    /** 读窗口状态 → styleForWindow（公开给单测伪注入） */
    _styleOf(win) {
        const hMax = win.maximized_horizontally;
        const vMax = win.maximized_vertically;
        return styleForWindow({
            focused: win.appears_focused,
            maximized: hMax && vMax,
            fullscreen: win.is_fullscreen(),
            tiled: hMax !== vMax,  // 半边 tile = 单轴最大化（mutter tiling）
            highContrast: St.Settings.get().high_contrast,
        });
    }

    /** style → shader uniforms；尺寸变化时可选传入新 w/h */
    _applyStyle(win, style, wOverride, hOverride) {
        const state = this._windows.get(win);
        const actor = win.get_compositor_private();
        if (!state || !actor)
            return;

        const w = wOverride ?? actor.width;
        const h = hOverride ?? actor.height;
        if (state.clip)
            state.clip.setParams(w, h, style.radius, style.outline);
        if (state.shadowFx) {
            // 若免除了圆角裁剪（直角窗口），阴影半径同步为 0 以保证 SDF 阴影与直角外轮廓严丝合缝
            const shadowRadius = state.clip ? style.radius : 0;
            state.shadowFx.setParams(w, h, shadowRadius, SHADOW_PAD, style.shadows);
        }
    }

    _updateStyle(win) {
        this._applyStyle(win, this._styleOf(win));
    }
}
