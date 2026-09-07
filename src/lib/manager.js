/**
 * Manager — 扩展核心状态机。
 *
 * 职责：
 *   - 监听窗口创建/销毁/状态变化（幂等：每事件重新求值 → 对比 → 增删效果）
 *   - 读 GSettings（黑白名单、XWayland 跳过、debug）
 *   - 对每个判定命中的窗口挂载装饰效果（effects/shadow 模块，骨架期占位）
 *
 * 设计约束：
 *   - 所有窗口状态读取都走 detector.shouldDecorate（纯函数，可单测）
 *   - enable/disable 幂等，disable 后零残留（无信号泄漏、无孤儿 actor）
 */

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {shouldDecorate} from './detector.js';
import {styleForWindow} from './style.js';

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

        // GSettings 变化 → 全量重判（所有键）
        this._settingsHandlerIds = [];
        for (const key of ['blacklist', 'whitelist', 'skip-xwayland', DEBUG_KEY]) {
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
        // 窗口级信号（位置/尺寸/焦点变化 → 幂等重判）
        for (const sig of ['position-changed', 'size-changed', 'notify::appears-focused',
                           'notify::maximized-horizontally', 'notify::maximized-vertically',
                           'notify::fullscreen'])
            this._windows.get(win).signals.push([win, win.connect(sig, () => this._reconcileDebounced())]);
        this._connect(win, 'unmanaging', () => this._forgetWindow(win));
        this._reconcileDebounced();
    }

    _forgetWindow(win) {
        this._undecorate(win);
        const state = this._windows.get(win);
        if (state) {
            for (const [obj, id] of state.signals)
                obj.disconnect(id);
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

    /** 全量幂等重判：对每个已跟踪窗口求值 → 与当前状态对比 → 增删 */
    _reconcile() {
        for (const [win, state] of this._windows) {
            const want = this._evaluate(win);
            if (want !== state.decorated) {
                if (want)
                    this._decorate(win);
                else
                    this._undecorate(win);
                state.decorated = want;
            }
            // 已装饰的窗口：样式状态可能变（focus/tiled/maximized）→ 更新参数
            else if (want) {
                this._updateStyle(win);
            }
        }
    }

    /** 读取窗口全部状态 → detector 判定 */
    _evaluate(win) {
        const actor = win.get_compositor_private();
        if (!actor)
            return false;
        const b = win.get_buffer_rect();
        const f = win.get_frame_rect();
        return shouldDecorate({
            bufferWidth: b.width, bufferHeight: b.height,
            frameWidth: f.width, frameHeight: f.height,
            scale: actor.get_geometry_scale?.() ?? 1,
            isX11: win.get_client_type() === Meta.WindowClientType.X11,
            skipXwayland: this._settings.get_boolean('skip-xwayland'),
            isMaximized: win.maximized_horizontally && win.maximized_vertically,
            isFullscreen: win.is_fullscreen(),
            windowType: win.get_window_type(),
            wmClass: win.get_wm_class(),
            blacklist: this._settings.get_strv('blacklist'),
            whitelist: this._settings.get_strv('whitelist'),
        }).apply;
    }

    _decorate(win) {
        // TODO(effects): 挂 GLSL 圆角裁剪 + 阴影 actor（POC 2 验证后实现）
        this._updateStyle(win);
        if (this._settings.get_boolean(DEBUG_KEY))
            console.debug(`[csd-fixer] decorate: ${win.get_wm_class()} "${win.get_title() ?? ''}"`);
    }

    _undecorate(win) {
        // TODO(effects): 移除效果 actor
        if (this._settings.get_boolean(DEBUG_KEY))
            console.debug(`[csd-fixer] undecorate: ${win.get_wm_class()}`);
    }

    _updateStyle(win) {
        const hMax = win.maximized_horizontally;
        const vMax = win.maximized_vertically;
        const tiled = hMax !== vMax;  // 半边 tile = 单轴最大化（mutter tiling 实现）
        const style = styleForWindow({
            focused: win.appears_focused,
            maximized: hMax && vMax,
            fullscreen: win.is_fullscreen(),
            tiled,
            highContrast: Main.getThemeStylesheet()?.includes('HighContrast') ?? false,
        });
        // TODO(effects): style → shader uniforms
        return style;
    }
}
