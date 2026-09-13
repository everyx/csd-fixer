#!/usr/bin/env node
/**
 * gen-mutter.mjs - Parses Mutter shadow parameters and algorithms from vendor/mutter/meta-shadow-factory.c
 * and MetaWindowType from vendor/mutter/window.h, generating src/lib/mutterRules.generated.js.
 *
 * Design: narrow parser + assertions. Parses the default_shadow_classes array and algorithms,
 * computing shadow radius and spread distance, plus window type enums to eliminate enum drift.
 *
 * Usage: node tools/gen-mutter.mjs [--check]
 *   --check: Verifies generated results match existing files (used by CI / check-style), exits with 1 if mismatch.
 */

import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor', 'mutter');
const OUT = path.join(ROOT, 'src', 'lib', 'mutterRules.generated.js');

const CHECK = process.argv.includes('--check');

function read(name) {
    const p = path.join(VENDOR, name);
    if (!existsSync(p))
        throw new Error(`[gen-mutter] Missing vendor file: ${name}`);
    return readFileSync(p, 'utf8');
}

// Gaussian blur filter size and spread algorithm from Mutter meta-shadow-factory.c
// get_box_filter_size: (int)(0.5 + radius * (0.75 * sqrt(2*M_PI)))
function getBoxFilterSize(radius) {
    return Math.floor(0.5 + radius * (0.75 * Math.sqrt(2 * Math.PI)));
}

// get_shadow_spread: odd: 3*(d/2), even: 3*(d/2)-1
function getShadowSpread(radius) {
    if (radius === 0)
        return 0;
    const d = getBoxFilterSize(radius);
    return d % 2 === 1 ? 3 * Math.floor(d / 2) : 3 * Math.floor(d / 2) - 1;
}

function parseParams(tupleStr) {
    // Format: { 10, -1, 0, 3, 128 }
    const nums = tupleStr.replace(/[{}]/g, '').split(',').map(s => parseInt(s.trim(), 10));
    if (nums.length !== 5 || nums.some(n => Number.isNaN(n)))
        throw new Error(`[gen-mutter] Cannot parse MetaShadowParams: "${tupleStr}"`);
    const [radius, top_fade, x_offset, y_offset, opacity] = nums;
    return {
        radius,
        topFade: top_fade,
        xOffset: x_offset,
        yOffset: y_offset,
        opacity,
        spread: getShadowSpread(radius),
    };
}

function parseShadowClasses(cCode) {
    const startIdx = cCode.indexOf('MetaShadowClassInfo default_shadow_classes[]');
    if (startIdx === -1)
        throw new Error('[gen-mutter] Assertion failed: default_shadow_classes definition not found');
    const braceStart = cCode.indexOf('{', startIdx);
    const braceEnd = cCode.indexOf('};', braceStart);
    if (braceStart === -1 || braceEnd === -1)
        throw new Error('[gen-mutter] Assertion failed: default_shadow_classes block not found');

    const body = cCode.slice(braceStart + 1, braceEnd);
    const itemRegex = /\{\s*"([^"]+)"\s*,\s*(\{[^}]+\})\s*,\s*(\{[^}]+\})\s*\}/g;
    const classes = {};
    let match;
    while ((match = itemRegex.exec(body)) !== null) {
        const [, name, focusedStr, unfocusedStr] = match;
        classes[name] = {
            focused: parseParams(focusedStr),
            unfocused: parseParams(unfocusedStr),
        };
    }

    if (!classes.normal || !classes.dialog)
        throw new Error('[gen-mutter] Assertion failed: classes missing normal or dialog');

    return classes;
}

function parseWindowTypes(headerCode) {
    const enumMatch = /typedef\s+enum\s*\{([^}]+)\}\s*MetaWindowType;/m.exec(headerCode);
    if (!enumMatch)
        throw new Error('[gen-mutter] Assertion failed: MetaWindowType enum not found in window.h');

    const lines = enumMatch[1].split('\n');
    const types = {};
    let currentIndex = 0;

    for (const rawLine of lines) {
        const line = rawLine.replace(/\/\*.*?\*\//g, '').trim();
        if (!line)
            continue;

        const match = /^META_WINDOW_([A-Z0-9_]+)(?:\s*=\s*(\d+))?,?$/.exec(line);
        if (match) {
            const name = match[1];
            if (match[2] !== undefined)
                currentIndex = parseInt(match[2], 10);
            types[name] = currentIndex;
            currentIndex++;
        }
    }

    if (types.NORMAL === undefined || types.DIALOG === undefined || types.MODAL_DIALOG === undefined)
        throw new Error('[gen-mutter] Assertion failed: Expected WindowType values missing');

    return types;
}

function parseClientTypes(headerCode) {
    const enumMatch = /typedef\s+enum\s*\{([^}]+)\}\s*MetaWindowClientType;/m.exec(headerCode);
    if (!enumMatch)
        throw new Error('[gen-mutter] Assertion failed: MetaWindowClientType enum not found in window.h');

    const types = {};
    let currentIndex = 0;

    for (const rawLine of enumMatch[1].split('\n')) {
        const line = rawLine.replace(/\/\*.*?\*\//g, '').trim();
        if (!line)
            continue;

        const match = /^META_WINDOW_CLIENT_TYPE_([A-Z0-9_]+)(?:\s*=\s*(\d+))?,?$/.exec(line);
        if (match) {
            const name = match[1];
            if (match[2] !== undefined)
                currentIndex = parseInt(match[2], 10);
            types[name] = currentIndex;
            currentIndex++;
        }
    }

    if (types.WAYLAND === undefined || types.X11 === undefined)
        throw new Error('[gen-mutter] Assertion failed: Expected WindowClientType values missing');

    return types;
}

function main() {
    const cCode = read('meta-shadow-factory.c');
    const headerCode = read('window.h');
    const classes = parseShadowClasses(cCode);
    const windowTypes = parseWindowTypes(headerCode);
    const clientTypes = parseClientTypes(headerCode);

    const normalUnfocused = classes.normal.unfocused;
    const normalFocused = classes.normal.focused;

    // Minimum shadow radius for normal window (unfocused: 8px, focused: 10px)
    const minNormalRadius = normalUnfocused.radius;
    const minNormalSpread = normalUnfocused.spread;

    const banner = `/**
 * mutterRules.generated.js - Automatically parsed and generated from:
 *   - vendor/mutter/meta-shadow-factory.c
 *   - vendor/mutter/window.h
 *
 * Do not edit this file directly! To regenerate run:
 *   node tools/gen-mutter.mjs
 */`;

    const code = `${banner}

/**
 * Mutter Window Type enum (MetaWindowType from vendor/mutter/window.h)
 */
export const WindowType = Object.freeze(${JSON.stringify(windowTypes, null, 4)});

/**
 * Mutter Window Client Type enum (MetaWindowClientType from vendor/mutter/window.h)
 */
export const WindowClientType = Object.freeze(${JSON.stringify(clientTypes, null, 4)});

/**
 * Mutter preset shadow style class metadata (MetaShadowClassInfo default_shadow_classes)
 */
export const MUTTER_SHADOW_CLASSES = Object.freeze(${JSON.stringify(classes, null, 4)});

/**
 * Mutter normal window unfocused minimum shadow radius (px)
 * Source: default_shadow_classes["normal"].unfocused.radius
 */
export const MUTTER_MIN_NORMAL_SHADOW_RADIUS = ${minNormalRadius};

/**
 * Mutter normal window unfocused minimum shadow outward spread distance (px)
 * Calculated from get_shadow_spread(8)
 */
export const MUTTER_MIN_NORMAL_SHADOW_SPREAD = ${minNormalSpread};

/**
 * Mutter normal window focused shadow radius (px)
 * Source: default_shadow_classes["normal"].focused.radius
 */
export const MUTTER_FOCUSED_NORMAL_SHADOW_RADIUS = ${normalFocused.radius};

/**
 * Mutter normal window focused shadow outward spread distance (px)
 * Calculated from get_shadow_spread(10)
 */
export const MUTTER_FOCUSED_NORMAL_SHADOW_SPREAD = ${normalFocused.spread};

/**
 * Minimum threshold for CSD decoration determination (logical pixels).
 *
 * In Mutter's definition, even an unfocused normal window has a shadow radius of ${minNormalRadius}px
 * and a spread extent of ${minNormalSpread}px.
 * If a window's declared content margin (Insets / Frame Extents) on any side is less than ${minNormalRadius}px
 * (e.g. 4px declared by WeChat/CEF frameless windows), the geometry physically cannot accommodate
 * a normal window shadow. Such margins are merely mouse resize grips or micro-borders, meaning
 * the window does not draw its own full CSD shadow.
 */
export const MUTTER_CSD_MIN_INSET_THRESHOLD = ${minNormalRadius};
`;

    if (CHECK) {
        if (!existsSync(OUT)) {
            console.error(`[gen-mutter] --check failed: ${OUT} does not exist`);
            process.exit(1);
        }
        const existing = readFileSync(OUT, 'utf8');
        if (existing !== code) {
            console.error(`[gen-mutter] --check failed: ${OUT} does not match vendor/mutter sources`);
            process.exit(1);
        }
        console.log('[gen-mutter] --check passed: generated file matches vendor source code');
        return;
    }

    writeFileSync(OUT, code, 'utf8');
    console.log(`[gen-mutter] Successfully parsed and generated: ${path.relative(ROOT, OUT)}`);
    console.log(`  - Normal window minimum shadow radius: ${minNormalRadius}px (spread: ${minNormalSpread}px)`);
    console.log(`  - Normal window focused shadow radius: ${normalFocused.radius}px (spread: ${normalFocused.spread}px)`);
    console.log(`  - CSD genuine shadow threshold: >= ${minNormalRadius}px`);
}

main();
