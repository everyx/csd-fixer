/**
 * ShadowActor：垫在窗口 actor 下方的阴影载体。
 *
 * 为什么必须是独立 actor：GLSL fragment 只在 actor 自身矩形内执行，
 * 画不出 actor 边界外——阴影可绘制区必须由本 actor 的尺寸预留
 * （窗口尺寸 + PAD×2）。
 *
 * 跟随机制：
 *   - 几何跟随（位置与尺寸）：X/Y/WIDTH/HEIGHT 4 维全部由 Clutter.BindConstraint
 *     在合成器 C 核心内原子完成同步，零 JS 帧开销，绝不触发 needs_allocation 警告。
 *   - 动效跟随（打开/关闭/最小化动画）：通过 GObject.bind_property 绑定
 *     scale-x/y、pivot-point、translation-x/y、opacity、visible，
 *     确保阴影严丝合缝地跟随窗口弹出、收缩与淡入淡出动效。
 *   - z 序（restack）：由 manager 的 display 'restacked' 信号统一维护
 *     （set_child_below_sibling），本类只管创建与自毁。
 *
 * 本类自管信号与生命周期：随 windowActor 的 destroy 信号自然自毁，零内存泄漏。
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

/** 阴影可绘制余量：最大 blur 14 (σ=7) + spread 5 = 26px (3σ)，+2 安全余量 */
export const SHADOW_PAD = 28;

export class ShadowActor {
    /**
     * @param {Clutter.Actor} windowActor 被装饰窗口的 actor
     * @param {Clutter.Actor} container   挂载容器（windowGroup），
     *                                    阴影插入在 windowActor 之下
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

        // 位置与尺寸跟随：X/Y/WIDTH/HEIGHT 4 维约束全部由 Clutter 内部 C 语言原生同步
        // 彻底杜绝在 notify::allocation 回调中调用 set_size 破坏 layout 顺序抛出
        // "Can't update stage views actor unnamed [StBin] is on because it needs an allocation" 警告。
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

        // 属性与动画跟随：透明度/可见性/缩放/支点/平移全部与窗口同步
        // 确保窗口在打开（map）、关闭（destroy）、最小化等动画期间，阴影严丝合缝地跟随窗口缩放动画
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

        // 尺寸跟随：仅负责在 allocation 就绪后驱动着色器 uniform 更新，不干扰 actor 自身尺寸
        this._lastW = 0;
        this._lastH = 0;
        this._allocId = windowActor.connect('notify::allocation',
            () => this._notifySizeChange());
        // 窗口 actor 销毁 → 兜底自杀（manager 正常路径也会先调 destroy）
        this._destroyId = windowActor.connect('destroy', () => this.destroy());

        container.insert_child_below(this._actor, windowActor);

        this._relayoutCallbacks = [];
    }

    get actor() {
        return this._actor;
    }

    /** 尺寸变化回调（manager 注册：驱动 effect uniform 更新） */
    onRelayout(cb) {
        this._relayoutCallbacks.push(cb);
    }

    /** 按窗口 actor 当前尺寸刷新 uniform（manager 在 decorate 后调用一次） */
    relayout() {
        this._notifySizeChange(true);
    }

    _notifySizeChange(force = false) {
        if (this._destroyed)
            return;
        const w = this._windowActor.width;
        const h = this._windowActor.height;
        if (w === 0 || h === 0)
            return;  // 尚未映射，等 allocation 信号
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
        // 窗口 actor 可能已销毁（destroy 信号路径），disconnect 会抛错
        try {
            this._windowActor.disconnect(this._allocId);
            this._windowActor.disconnect(this._destroyId);
        } catch (e) {
            // actor 已销毁——信号随之释放，无需处理
        }
        try {
            this._container.remove_child(this._actor);
        } catch (e) {
            // container 可能已销毁
        }
        this._actor.destroy();
        this._actor = null;
    }
}
