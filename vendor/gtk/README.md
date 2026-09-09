# vendor/gtk

Authoritative source for shadow rendering algorithms (GSK GPU renderer analytical Gaussian integrals), vendored from upstream GTK4.

- Source: https://gitlab.gnome.org/GNOME/gtk
- Original file: gsk/gpu/shaders/gskgpuboxshadow.glsl
- COMMIT: See the COMMIT file in this directory (currently `cat COMMIT`)
- Purpose: Build scripts extract its 2D analytical integral algorithm (erf, erf_range, gauss, ellipse_x, blur_rect, blur_corner, blur_rounded_rect), generating shader code (do not edit the generated file directly).
- Update instructions:
  1. Re-vendor upstream files and update COMMIT
  2. Run the build script to regenerate
  3. Verify that the generated diff matches expectations
