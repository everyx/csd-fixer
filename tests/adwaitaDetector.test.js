import {
    clearAdwaitaCache,
    hasAdwaitaLibraries,
    isWindowAdwaita,
    probePidMaps,
} from '../src/lib/adwaitaDetector.js';

describe('adwaitaDetector', () => {
    beforeEach(() => {
        clearAdwaitaCache();
    });

    afterEach(() => {
        clearAdwaitaCache();
    });

    describe('hasAdwaitaLibraries', () => {
        it('detects libadwaita-1.so', () => {
            const maps = '7f9914000-7f9915000 r-xp 00000000 103:02 12345 /usr/lib/libadwaita-1.so.0\n';
            expect(hasAdwaitaLibraries(maps)).toBeTrue();
        });

        it('returns false for plain libgtk-4.so without libadwaita', () => {
            const maps = '7f9914000-7f9915000 r-xp 00000000 103:02 12345 /usr/lib/libgtk-4.so.1\n';
            expect(hasAdwaitaLibraries(maps)).toBeFalse();
        });

        it('detects libhandy-1.so', () => {
            const maps = '7f9914000-7f9915000 r-xp 00000000 103:02 12345 /usr/lib/libhandy-1.so.0\n';
            expect(hasAdwaitaLibraries(maps)).toBeTrue();
        });

        it('returns false for traditional GTK3, Qt, Electron, libc', () => {
            const maps = [
                '7f9914000-7f9915000 r-xp 00000000 103:02 12345 /usr/lib/libgtk-3.so.0\n',
                '7f9914000-7f9915000 r-xp 00000000 103:02 12345 /usr/lib/libc.so.6\n',
                '7f9914000-7f9915000 r-xp 00000000 103:02 12345 /usr/lib/libQt6Core.so\n',
            ].join('');
            expect(hasAdwaitaLibraries(maps)).toBeFalse();
        });

        it('returns false for null, undefined, or empty maps', () => {
            expect(hasAdwaitaLibraries(null)).toBeFalse();
            expect(hasAdwaitaLibraries(undefined)).toBeFalse();
            expect(hasAdwaitaLibraries('')).toBeFalse();
        });
    });

    describe('probePidMaps & caching', () => {
        it('returns false for invalid pid', () => {
            expect(probePidMaps(null)).toBeFalse();
            expect(probePidMaps(0)).toBeFalse();
            expect(probePidMaps(-1)).toBeFalse();
        });

        it('returns false when /proc/pid/maps does not exist or fails', () => {
            expect(probePidMaps(9999999)).toBeFalse();
        });

        it('reports linkage from the maps text', () => {
            expect(probePidMaps(424242, () => '/usr/lib/libadwaita-1.so.0\n')).toBeTrue();
        });

        it('reads a pid once, then serves the cache', () => {
            let reads = 0;
            const read = () => { reads++; return ''; };
            probePidMaps(515151, read);
            probePidMaps(515151, read);
            expect(reads).toBe(1);
        });

        it('re-reads a pid after its cache entry is cleared', () => {
            let reads = 0;
            const read = () => { reads++; return ''; };
            probePidMaps(616161, read);
            clearAdwaitaCache(616161);
            probePidMaps(616161, read);
            expect(reads).toBe(2);
        });

        it('returns false but does not cache when the read fails', () => {
            let reads = 0;
            const read = () => { reads++; throw new Error('EACCES'); };
            expect(probePidMaps(717171, read)).toBeFalse();
            expect(probePidMaps(717171, read)).toBeFalse();
            expect(reads).toBe(2);
        });
    });

    describe('isWindowAdwaita', () => {
        it('probes PID maps for a window with valid PID', () => {
            const win = {
                get_pid: () => 9999999,
            };
            expect(isWindowAdwaita(win)).toBeFalse();
        });

        it('returns false for window without valid PID', () => {
            const win = {
                get_pid: () => 0,
            };
            expect(isWindowAdwaita(win)).toBeFalse();
        });

        it('safely handles null/undefined window', () => {
            expect(isWindowAdwaita(null)).toBeFalse();
            expect(isWindowAdwaita(undefined)).toBeFalse();
        });
    });
});
