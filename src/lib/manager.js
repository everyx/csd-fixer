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

import {evaluateWindowActions, RuleMode} from './detector.js';
import {styleForWindow} from './style.js';
import {RoundedClipEffect} from '../effects/clipEffect.js';
import {SdfShadowEffect} from '../effects/shadowEffect.js';
import {ShadowActor, SHADOW_PAD} from '../effects/shadowActor.js';

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

        // GSettings 变化 → 全量重判（仅相关核心键）
        this._settingsHandlerIds = [];
        for (const key of ['window-rules', 'prefer-crisp-text']) {
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
        this._windows.set(win, {clip: null, shadow: null, shadowFx: null, signals: []});
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
        if (actor) {
            this._windows.get(win).signals.push([actor, actor.connect('notify::allocation', () => {
                const state = this._windows.get(win);
                // 首帧就绪（尚未装饰但已取得尺寸）：立刻同步，杜绝 50ms 延迟导致打开动效丢失阴影淡入
                if (state && (!state.clip && !state.shadow) && actor.width > 0 && actor.height > 0)
                    this._reconcileWindow(win);
                else
                    this._reconcileDebounced();
            })]);
        }
        if (actor && actor.width > 0 && actor.height > 0)
            this._reconcileWindow(win);
        else
            this._reconcileDebounced();
    }

    _forgetWindow(win) {
        const state = this._windows.get(win);
        if (state) {
            for (const [obj, id] of state.signals)
                obj.disconnect(id);
            // 保持 clipEffect 与 shadowActor，让它们随 windowActor 自然谢幕，防止关闭动画瞬间变直角
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

    _getWindowRules() {
        try {
            const v = this._settings.get_value('window-rules');
            return v ? v.deep_unpack() : {};
        } catch (e) {
            return {};
        }
    }

    /** 获取窗口所在显示器的物理/逻辑缩放比例（支持分数缩放 1.25, 1.333, 1.5 等） */
    _getMonitorScale(win) {
        const monitor = win.get_monitor();
        if (monitor < 0)
            return 1;
        if (typeof global.display?.get_monitor_scale === 'function')
            return global.display.get_monitor_scale(monitor);
        return 1;
    }

    /** 动态同步窗口 clipEffect */
    _syncClip(win, wantClip) {
        const state = this._windows.get(win);
        if (!state)
            return;
        const actor = win.get_compositor_private();
        if (!actor)
            return;

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

    /** 动态同步窗口 shadowActor */
    _syncShadow(win, wantShadow) {
        const state = this._windows.get(win);
        if (!state)
            return;
        const actor = win.get_compositor_private();
        if (!actor)
            return;

        const hasShadow = Boolean(state.shadow);
        if (wantShadow !== hasShadow) {
            if (wantShadow) {
                state.shadowFx = new SdfShadowEffect();
                state.shadow = new ShadowActor(actor, global.windowGroup);
                state.shadow.actor.add_effect(state.shadowFx);
                state.shadow.onRelayout((w, h) => {
                    const style = this._styleOf(win);
                    this._applyStyle(win, style, w, h);
                });
                state.shadow.relayout();
            } else {
                state.shadow.destroy();
                state.shadow = null;
                state.shadowFx = null;
            }
        }
    }

    /** 对单个窗口执行幂等重判与装饰同步 */
    _reconcileWindow(win) {
        const state = this._windows.get(win);
        if (!state)
            return;
        const actor = win.get_compositor_private();
        if (!actor || actor.width === 0 || actor.height === 0)
            return;

        const actions = this._evaluateActions(win);
        this._syncClip(win, actions.applyClip);
        this._syncShadow(win, actions.applyShadow);

        if (state.clip || state.shadow)
            this._updateStyle(win);
    }

    /** 全量幂等重判：对每个已跟踪窗口分别同步 clip 与 shadow */
    _reconcile() {
        for (const [win] of this._windows)
            this._reconcileWindow(win);
    }

    /** restack 后重排所有阴影 actor 到对应窗口下方 */
    _restackShadows() {
        for (const [win, state] of this._windows) {
            if (!state.shadow)
                continue;
            const actor = win.get_compositor_private();
            if (!actor)
                continue;
            global.windowGroup.set_child_below_sibling(state.shadow.actor, actor);
        }
    }

    /** 读取窗口全部状态 → detector evaluateWindowActions 判定 */
    _evaluateActions(win) {
        const actor = win.get_compositor_private();
        if (!actor)
            return {applyShadow: false, applyClip: false};

        const b = win.get_buffer_rect();
        const f = win.get_frame_rect();
        const hasSsd = Boolean(win.decorated && !win.is_client_decorated());
        const wmClass = win.get_wm_class();
        const isX11 = win.get_client_type() === Meta.WindowClientType.X11;
        const geometryScale = actor.get_geometry_scale?.() ?? 1;
        const monitorScale = this._getMonitorScale(win);

        return evaluateWindowActions({
            bufferWidth: b.width, bufferHeight: b.height,
            frameWidth: f.width, frameHeight: f.height,
            geometryScale,
            monitorScale,
            isX11,
            isMaximized: win.maximized_horizontally && win.maximized_vertically,
            isFullscreen: win.is_fullscreen(),
            hasSsd,
            windowType: win.get_window_type(),
            wmClass,
            windowRules: this._getWindowRules(),
            preferCrispText: this._settings.get_boolean('prefer-crisp-text'),
        });
    }

    _undecorate(win) {
        this._syncClip(win, false);
        this._syncShadow(win, false);
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
