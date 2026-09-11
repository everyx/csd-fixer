// A subject for visual work in the nested session: a window the detector decorates.
//
//   ./tools/dev.sh app gjs tools/probe-window.js
//
// CSD is off, so the window declares no frame extents and the extension draws the
// decoration. The size is fixed and the content is the theme's box background, so
// two screenshots of the same session are comparable.
imports.gi.versions.Gtk = '4.0';

const Gtk = imports.gi.Gtk;

const app = new Gtk.Application({application_id: 'dev.csd.fixer.probe'});

app.connect('activate', () => {
    const win = new Gtk.ApplicationWindow({
        application: app,
        title: 'csd-fixer probe',
        default_width: 900,
        default_height: 600,
    });
    win.set_decorated(false);
    win.set_child(new Gtk.Box({orientation: Gtk.Orientation.VERTICAL}));
    win.present();
});

app.run([]);
