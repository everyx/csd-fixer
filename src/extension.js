/**
 * CSD Fixer — 给 GNOME Wayland 下无 CSD 的窗口补齐 GNOME 原生装饰。
 *
 * 架构（模块职责）:
 *   detector  判定窗口是否需要补装饰（buffer==frame 判据，POC 1 已验证）
 *   style     样式状态机（固定跟随 libadwaita window.csd，生成产物）
 *   effects   圆角裁剪 + SDF 阴影（Shell.GLSLEffect）
 *   shadow    阴影 actor 生命周期与约束
 *   manager   信号状态机：窗口增删/状态切换/工作区切换
 */

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Manager} from './lib/manager.js';

export default class CsdFixerExtension extends Extension {
    enable() {
        this._manager = new Manager(this);
        this._manager.enable();
    }

    disable() {
        this._manager?.disable();
        this._manager = null;
    }
}
