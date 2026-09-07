/**
 * POC 2: SDF 圆角 + 阴影着色器验证。
 *
 * 架构（两个 effect 分挂不同对象）：
 *   1. RoundedClipEffect → 挂 window actor：GLSL 圆角裁剪窗口内容（Mutter 同款思路）
 *   2. SdfShadowEffect   → 挂独立 shadow actor（St.Bin，windowGroup 里垫在窗口下）：
 *      纯 SDF 着色器画三层阴影（libadwaita 参数），输入纹理不看，resize 只改 uniform。
 *
 * 跟随机制（rwc 实现考据后的定稿）：
 *   - 移动（高频）：X/Y BindConstraint offset=-PAD，约束自动同步零 JS 开销
 *   - 尺寸（低频）：notify::allocation 信号 → relayout + uniform 更新
 *   - rwc 能用 4 约束+CSS padding 是因为 St box-shadow 可溢出 actor 矩形绘制
 *     （offscreen+无 clip）；GLSL fragment 只在 actor 矩形内跑，必须自身外扩
 *
 * 与 rwc 的差异点（本 POC 要证明的）：
 *   rwc shadow actor 用 CSS box-shadow（样式变化→offscreen blur 重建，慢）
 *   本 POC 用 GLSL SDF（纯 fragment ALU，零纹理重建）
 *
 * 本 POC 挂所有 Wayland toplevel（不判 CSD——判据 POC 1 已验证，这里只验渲染/性能）。
 */

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Cogl from 'gi://Cogl';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// ── shader 源 ────────────────────────────────────────────────────────

// 圆角矩形 SDF：p 点到圆角矩形边界的距离（<0 内，>0 外）
const SDF_COMMON = `
float sdRoundedBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
`;

// 1) 圆角裁剪（挂窗口 actor）
const CLIP_DECL = `
uniform vec4 uClipBounds;   // 圆角裁剪区（窗口矩形，actor 本地像素坐标）
uniform float uClipRadius;  // 圆角半径
${SDF_COMMON}
`;
const CLIP_CODE = `
    vec2 halfSize = (uClipBounds.zw - uClipBounds.xy) * 0.5;
    vec2 c = (uClipBounds.xy + uClipBounds.zw) * 0.5;
    float d = sdRoundedBox(cogl_tex_coord0_in.xy * uClipBounds.zw - c, halfSize, uClipRadius);
    cogl_color_out *= 1.0 - clamp(d + 0.5, 0.0, 1.0);
`;

// 2) SDF 阴影（挂 shadow actor：输入纹理不看，纯距离场输出）
const SHADOW_DECL = `
uniform vec2 uWinSize;      // 被装饰窗口的尺寸（shadow actor 本地坐标）
uniform float uRadius;     // 圆角半径
uniform vec4 uShadow1;     // (blur, spread, alpha, 未用)
uniform vec4 uShadow2;
uniform vec4 uShadow3;     // outline 层（blur=0）
uniform vec2 uPad;         // shadow actor 的 padding（阴影可画区域）
${SDF_COMMON}
`;
const SHADOW_CODE = `
    // shadow actor 尺寸 = 窗口 + 2*pad。窗口矩形中心：
    vec2 halfSize = uWinSize * 0.5;
    vec2 c = uPad + halfSize;                   // 窗口左上角 = pad,pad
    vec2 p = cogl_tex_coord0_in.xy * (uWinSize + uPad * 2.0);
    float d = sdRoundedBox(p - c, halfSize, uRadius);   // <0 窗内，>0 窗外

    // 三层阴影（libadwaita: 0 0 14px 5px 15% + 0 0 5px 2px 10% + 0 0 0 1px 5%）
    // blur=0 的 outline 层是 1px 边线；blur>0 层是随距离衰减的柔和阴影
    float a = 0.0;
    if (uShadow1.x > 0.5)
        a += uShadow1.z * (1.0 - smoothstep(0.0, uShadow1.x + uShadow1.y, d));
    else
        a += uShadow1.z * (1.0 - smoothstep(-1.0, 1.0, d));
    if (uShadow2.x > 0.5)
        a += uShadow2.z * (1.0 - smoothstep(0.0, uShadow2.x + uShadow2.y, d));
    else
        a += uShadow2.z * (1.0 - smoothstep(-1.0, 1.0, d));
    if (uShadow3.x > 0.5)
        a += uShadow3.z * (1.0 - smoothstep(0.0, uShadow3.x + uShadow3.y, d));
    else
        a += uShadow3.z * (1.0 - smoothstep(-1.0, 1.0, d));

    // 窗口矩形内不画（真窗口纹理在上层覆盖，但保险起见窗内 alpha=0）
    cogl_color_out = vec4(0.0, 0.0, 0.0, a * step(0.0, d));
`;

// ── Effect 类 ────────────────────────────────────────────────────────

const RoundedClipEffect = GObject.registerClass(
    class RoundedClipEffect extends Shell.GLSLEffect {
        _init() {
            super._init();
            this._uClipBounds = this.get_uniform_location('uClipBounds');
            this._uClipRadius = this.get_uniform_location('uClipRadius');
        }

        vfunc_build_pipeline() {
            this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, CLIP_DECL, CLIP_CODE, false);
        }

        /** width/height: 窗口尺寸（像素），radius: 圆角 */
        setParams(width, height, radius) {
            this.set_uniform_float(this._uClipBounds, 4, [0, 0, width, height]);
            this.set_uniform_float(this._uClipRadius, 1, [radius]);
            this.queue_repaint();
        }
    });

const SdfShadowEffect = GObject.registerClass(
    class SdfShadowEffect extends Shell.GLSLEffect {
        _init() {
            super._init();
            for (const [k, n] of [['_uWinSize', 'uWinSize'], ['_uRadius', 'uRadius'],
                ['_uShadow1', 'uShadow1'], ['_uShadow2', 'uShadow2'],
                ['_uShadow3', 'uShadow3'], ['_uPad', 'uPad']])
                this[k] = this.get_uniform_location(n);
            log(`[sdf-poc] uniform locations: ${JSON.stringify({
                uWinSize: this._uWinSize, uRadius: this._uRadius,
                s1: this._uShadow1, s2: this._uShadow2, s3: this._uShadow3, pad: this._uPad})}`);
        }

        vfunc_build_pipeline() {
            log('[sdf-poc] SdfShadowEffect.vfunc_build_pipeline called');
            this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, SHADOW_DECL, SHADOW_CODE, false);
        }

        /**
         * winW/winH: 窗口尺寸，pad: shadow actor 每边 padding，
         * shadows: [{blur, spread, alpha} x3]（libadwaita 参数）
         */
        setParams(winW, winH, radius, pad, shadows) {
            this.set_uniform_float(this._uWinSize, 2, [winW, winH]);
            this.set_uniform_float(this._uRadius, 1, [radius]);
            this.set_uniform_float(this._uPad, 2, [pad, pad]);
            const toV = s => [s.blur, s.spread, s.alpha, 0];
            this.set_uniform_float(this._uShadow1, 4, toV(shadows[0]));
            this.set_uniform_float(this._uShadow2, 4, toV(shadows[1]));
            this.set_uniform_float(this._uShadow3, 4, toV(shadows[2]));
            this.queue_repaint();
        }
    });

// ── Manager（POC 简化版：所有 Wayland toplevel 都挂）──────────────────

const PAD = 24;  // 阴影可绘制区（14+5=19px 最大，+5 安全余量）

export default class SdfPoc {
    enable() {
        this._tracked = new Map();
        this._windowCreatedId = global.display.connect('window-created',
            (_, win) => this._track(win));
        for (const win of global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null))
            this._track(win);
        // 探针延迟挂载：shell 启动早期 stage 可能未 mapped，
        // 过早 add+show 的 actor 不进 paint 列表（POC 2 时序发现）
        this._probeDelayId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000,
            () => {
                this._stageProbe();
                this._probeDelayId = null;
                return GLib.SOURCE_REMOVE;
            });
    }

    // 实验开关：探针延迟加 effect（隔窝 add_effect 时机问题）
    static PROBE_DELAY_EFFECT_MS = 100;

    disable() {
        global.display.disconnect(this._windowCreatedId);
        for (const [win] of this._tracked)
            this._untrack(win);
        this._tracked.clear();
        if (this._probeDelayId) {
            GLib.Source.remove(this._probeDelayId);
            this._probeDelayId = null;
        }
        this._removeStageProbe();
    }

    /**
     * headless 环境下 windowGroup 不渲染（POC 2 发现），窗口验证不可行；
     * 阶段性 shader 验证：stage 直挂探针。
     * 几何：bin = 窗 300x200 + pad 24×2 = 348x248，窗口矩形位于 bin 内 (24,24)。
     */
    _stageProbe() {
        const fx = new SdfShadowEffect();
        const WIN_W = 152, WIN_H = 52, PAD_ = 24;
        const bin = new St.Bin({x: 600, y: 300, width: WIN_W + PAD_ * 2, height: WIN_H + PAD_ * 2});
        bin.style = 'background-color: white;';
        bin.add_effect(fx);
        global.stage.add_child(bin);
        bin.show();
        fx.setParams(WIN_W, WIN_H, 15, PAD_, [
            {blur: 14, spread: 5, alpha: 0.15},
            {blur: 5, spread: 2, alpha: 0.10},
            {blur: 0, spread: 1, alpha: 0.05},
        ]);
        this._probe = {bin, fx};
        // 对照组：无 effect 的纯黄 bin（验证 stage 渲染链路本身）
        const plain = new St.Bin({x: 100, y: 800, width: 200, height: 100});
        plain.style = 'background-color: #ffff00;';
        global.stage.add_child(plain);
        plain.show();
        this._probe.plain = plain;
    }

    _removeStageProbe() {
        if (this._probeDelayId2) {
            GLib.Source.remove(this._probeDelayId2);
            this._probeDelayId2 = null;
        }
        if (this._probe) {
            this._probe.bin.destroy();
            this._probe = null;
        }
    }

    _track(win) {
        if (this._tracked.has(win) || win.get_client_type() !== Meta.WindowClientType.WAYLAND)
            return;
        const actor = win.get_compositor_private();
        if (!actor)
            return;

        const state = {actor, effects: [], signals: [], shadowBin: null, shadowEffect: null};
        this._tracked.set(win, state);

        // 1) 圆角裁剪 effect 挂窗口 actor
        const clip = new RoundedClipEffect();
        actor.add_effect(clip);
        state.effects.push([actor, clip]);

        // 2) 阴影 actor 垫窗口下：尺寸 = 窗口 + 2*PAD（给 fragment 留出窗外绘制区）
        const bin = new St.Bin({
            style: 'background-color: white;',  // 提供不透明像素供 shader 全覆盖
        });
        const shadowFx = new SdfShadowEffect();
        bin.add_effect(shadowFx);
        global.windowGroup.insert_child_below(bin, actor);
        state.shadowBin = bin;
        state.shadowEffect = shadowFx;

        // 移动跟随（高频）：X/Y 约束自动同步
        for (const coord of [Clutter.BindCoordinate.X, Clutter.BindCoordinate.Y]) {
            const c = new Clutter.BindConstraint({source: actor, coordinate: coord, offset: -PAD});
            bin.add_constraint(c);
        }

        const relayout = () => {
            const w = actor.width, h = actor.height;
            if (w === 0 || h === 0)  // 首帧未映射，等 allocation 信号再试
                return;
            clip.setParams(w, h, 15);
            bin.set_size(w + PAD * 2, h + PAD * 2);
            shadowFx.setParams(w, h, 15, PAD, [
                {blur: 14, spread: 5, alpha: 0.15},
                {blur: 5, spread: 2, alpha: 0.10},
                {blur: 0, spread: 1, alpha: 0.05},
            ]);
        };
        state.signals.push([actor, actor.connect('notify::allocation', relayout)]);
        relayout();
        log(`[sdf-poc] tracking ${win.get_wm_class()} ${actor.width}x${actor.height}`);
    }

    _untrack(win) {
        const state = this._tracked.get(win);
        if (!state)
            return;
        for (const [obj, id] of state.signals)
            obj.disconnect(id);
        for (const [actor, effect] of state.effects)
            actor.remove_effect(effect);
        if (state.shadowBin) {
            global.windowGroup.remove_child(state.shadowBin);
            state.shadowBin.destroy();
        }
    }
}
