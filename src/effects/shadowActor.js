/**
 * ShadowActor：垫在窗口 actor 下方的阴影载体。
 *
 * 为什么必须是独立 actor：GLSL fragment 只在 actor 自身矩形内执行，
 * 画不出 actor 边界外——阴影可绘制区必须由本 actor 的尺寸预留
 * （窗口尺寸 + PAD×2）。rwc 用 CSS box-shadow 可溢出绘制所以只需
 * 贴合窗口；SDF 方案必须自身外扩（POC 2 架构考据定稿）。
 *
 * 跟随机制（rwc 实现考据）：
 *   - 移动（高频）：X/Y BindConstraint offset=-PAD——约束系统内同步，零 JS
 *   - 尺寸（低频）：监听窗口 actor notify::allocation → set_size + 通知
 *     manager 更新 uniform（manager 持有 style/effect 参数）
 *
 * 本类自管信号与生命周期：destroy() 幂等（含窗口 actor 已销毁的兜底）。
 */

import Clutter from 'gi://Clutter';

/** 阴影可绘制余量：最大 blur 14 + spread 5 = 19px，+5 安全余量 */
export const SHADOW_PAD = 24;

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

        this._actor = new Clutter.Actor({
            reactive: false,
            opacity: 255,
        });

        // 移动跟随：X/Y 约束（约束在 mutter 内部同步，不占 JS 帧）
        for (const coordinate of [Clutter.BindCoordinate.X, Clutter.BindCoordinate.Y]) {
            this._actor.add_constraint(new Clutter.BindConstraint({
                source: windowActor,
                coordinate,
                offset: -SHADOW_PAD,
            }));
        }

        // 尺寸跟随：窗口 actor allocation 变化 → relayout
        this._allocId = windowActor.connect('notify::allocation',
            () => this._emitRelayout());
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

    /** 按窗口 actor 当前尺寸重排（manager 在 decorate 后调用一次） */
    relayout() {
        if (this._destroyed)
            return;
        const w = this._windowActor.width;
        const h = this._windowActor.height;
        if (w === 0 || h === 0)
            return;  // 尚未映射，等 allocation 信号
        this._actor.set_size(w + SHADOW_PAD * 2, h + SHADOW_PAD * 2);
        for (const cb of this._relayoutCallbacks)
            cb(w, h);
    }

    _emitRelayout() {
        this.relayout();
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._relayoutCallbacks = [];
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
