/**
 * Adwaita Detector - Probes whether a window process links Libadwaita or Libhandy.
 *
 * Windows built with Libadwaita or Libhandy already draw their own native rounded
 * corners and drop shadows. This detector probes /proc/{pid}/maps and caches
 * the result per PID in memory to skip redundant decoration.
 *
 * Shell-side probe (IO-dependent, not pure).
 */

import Gio from 'gi://Gio';

const pidAdwaitaCache = new Map();

/**
 * Checks whether text from /proc/pid/maps includes libraries that provide native rounded corners.
 *
 * @param {string} mapsText - Contents of /proc/pid/maps
 * @returns {boolean}
 */
export function hasAdwaitaLibraries(mapsText) {
    if (!mapsText || typeof mapsText !== 'string')
        return false;
    return mapsText.includes('libadwaita-1.so') ||
           mapsText.includes('libhandy-1.so');
}

/** Reads /proc/<pid>/maps; throws when it cannot be read. */
function readMaps(pid) {
    const file = Gio.File.new_for_path(`/proc/${pid}/maps`);
    const [ok, bytes] = file.load_contents(null);
    if (!ok || !bytes)
        throw new Error(`could not read /proc/${pid}/maps`);
    return new TextDecoder().decode(bytes);
}

/**
 * Probes /proc/{pid}/maps for a process to check for native Libadwaita or Libhandy.
 * Results are cached in-memory per PID for fast subsequent lookups.
 *
 * @param {number} pid - Process ID
 * @param {(pid: number) => string} [read=readMaps] - maps reader, injectable for tests
 * @returns {boolean}
 */
export function probePidMaps(pid, read = readMaps) {
    if (!pid || typeof pid !== 'number' || pid <= 0)
        return false;
    if (pidAdwaitaCache.has(pid))
        return pidAdwaitaCache.get(pid);

    let isAdw;
    try {
        isAdw = hasAdwaitaLibraries(read(pid));
    } catch {
        // Permission denied, dead process, or sandbox restriction. Not cached: the
        // read may succeed next time, and a cached "not linked" would decorate a
        // native libadwaita window a second time.
        return false;
    }

    pidAdwaitaCache.set(pid, isAdw);
    return isAdw;
}

/**
 * Clears cached PID information.
 *
 * @param {number} [pid] - If specified, deletes only that PID; otherwise clears all.
 */
export function clearAdwaitaCache(pid) {
    if (pid !== undefined)
        pidAdwaitaCache.delete(pid);
    else
        pidAdwaitaCache.clear();
}

/**
 * Checks whether a window is a native Libadwaita / Libhandy application.
 *
 * Per-process heuristic: /proc/pid/maps only proves linkage, so mixed
 * CSD/SSD windows of one process share one answer.
 *
 * @param {object} win - Meta.Window instance
 * @returns {boolean}
 */
export function isWindowAdwaita(win) {
    if (!win)
        return false;

    return probePidMaps(win.get_pid?.());
}
