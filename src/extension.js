/**
 * CSD Fixer - restores GNOME native rounded corners and drop shadows to non-CSD applications.
 *
 * Architecture (module responsibilities):
 *   detector  determines whether a window needs decoration (geometry criteria)
 *   style     decoration style state machine (tracks libadwaita window.csd)
 *   effects   rounded clipping + SDF analytical Gaussian shadows (Shell.GLSLEffect)
 *   shadow    shadow actor lifecycle and constraints
 *   manager   state machine responding to window lifecycle, focus, and display changes
 */

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Manager} from './lib/manager.js';
import {InspectorService} from './lib/inspector.js';

export default class CsdFixerExtension extends Extension {
    enable() {
        this._manager = new Manager(this);
        this._manager.enable();

        this._inspector = new InspectorService(this._manager);
    }

    disable() {
        this._inspector?.destroy();
        this._inspector = null;

        this._manager?.disable();
        this._manager = null;
    }
}

