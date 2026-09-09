/**
 * 阴影效果：挂 shadow actor（纯 GPU 解析高斯积分输出，零离线贴图）。
 *
 * 渲染内核（由 tools/gen-shader.mjs 从 GTK4 GSK 原生 gskgpuboxshadow.glsl 自动转译）：
 *   - 二维解析高斯积分（erf 误差函数双重乘积）+ 4 角落 8 步缺角数值积分扣减；
 *   - CSS 标准参数换算（σ = blur / 2）；
 *   - 互补镂空遮罩（clipAlpha = clamp(d + 0.5, 0.0, 1.0)）：
 *     与窗口 RoundedClipEffect 严格互补（和恒为 1.000000），既物理杜绝任何漏光亮缝，
 *     又彻底消除了底层阴影透出导致浅色边缘发黑的暗圈；
 *   - blur=0 层：1px 抗锯齿轮廓线。
 *
 * 输出预乘格式（rgb = 0 ≤ a 恒成立）。
 */

import GObject from 'gi://GObject';
import Cogl from 'gi://Cogl';
import Shell from 'gi://Shell';

import {DECLARATIONS, CODE} from './shadowShader.generated.js';

export const SdfShadowEffect = GObject.registerClass({
    GTypeName: 'CsdFixerSdfShadowEffect',
}, class SdfShadowEffect extends Shell.GLSLEffect {
    _init() {
        super._init();
        for (const [k, n] of [['_uWinSize', 'uWinSize'], ['_uRadius', 'uRadius'],
            ['_uShadow1', 'uShadow1'], ['_uShadow2', 'uShadow2'],
            ['_uShadow3', 'uShadow3'], ['_uPad', 'uPad']])
            this[k] = this.get_uniform_location(n);
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT,
            DECLARATIONS, CODE, false);
    }

    /**
     * 更新阴影参数（窗口尺寸/半径/padding/阴影层，≤3 层，不足补零层）。
     */
    setParams(winW, winH, radius, pad, shadows) {
        this.set_uniform_float(this._uWinSize, 2, [winW, winH]);
        this.set_uniform_float(this._uRadius, 1, [radius]);
        this.set_uniform_float(this._uPad, 2, [pad, pad]);

        const zeros = [
            {blur: 0, spread: 0, alpha: 0},
            {blur: 0, spread: 0, alpha: 0},
            {blur: 0, spread: 0, alpha: 0},
        ];
        const layers = [...shadows.slice(0, 3), ...zeros.slice(shadows.length)];
        for (let i = 0; i < 3; i++) {
            const s = layers[i];
            this.set_uniform_float(this[`_uShadow${i + 1}`], 4,
                [s.blur, s.spread, s.alpha, 0]);
        }
        this.queue_repaint();
    }
});
