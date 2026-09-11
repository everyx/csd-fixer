// A subject for visual work in the nested session: a window the detector decorates.
//
//   ./tools/dev.sh app gjs tools/probe-window.js
//
// CSD is off, so the window declares no frame extents and the extension draws the
// decoration. The size is fixed and the content is the theme's box background, so
// two screenshots of the same session are comparable.
//
// With CSD_FIXER_BACKDROP=1 it becomes the uniform surface a shadow is measured
// against instead: white, a separate application id so it can run beside the subject,
// and meant to be maximized, which is a state the detector never decorates.
imports.gi.versions.Gtk = '4.0';

const GLib = imports.gi.GLib;
const Gdk = imports.gi.Gdk;
const Gtk = imports.gi.Gtk;

const backdrop = Boolean(GLib.getenv('CSD_FIXER_BACKDROP'));
const app = new Gtk.Application({
    application_id: backdrop ? 'dev.csd.fixer.backdrop' : 'dev.csd.fixer.probe',
});

app.connect('activate', () => {
    if (backdrop) {
        const css = new Gtk.CssProvider();
        css.load_from_string('window { background-color: #ffffff; }');
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    }

    const win = new Gtk.ApplicationWindow({
        application: app,
        title: backdrop ? 'csd-fixer backdrop' : 'csd-fixer probe',
        default_width: 900,
        default_height: 600,
    });
    win.set_decorated(false);
    win.set_child(new Gtk.Box({orientation: Gtk.Orientation.VERTICAL}));
    win.present();
});

app.run([]);
