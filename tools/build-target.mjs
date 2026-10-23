/**
 * tools/build-target.mjs — build target configuration.
 *
 * Current target: build mvl14oup (version 0.8.29).
 * Legacy target: build mvilprw2 (version 0.8.13).
 */

export const DEFAULT_TARGET = Object.freeze({
  BUILD: 'mvl14oup',
  VERSION: '0.8.29',
  ENTRY: 'main-CB7jXRDe-mvl14oup.js',
  GAME: 'main-DEBvJLhQ-mvl14oup.js',
  INDEX: 'index.html',
});

export const LEGACY = Object.freeze({
  BUILD: 'mvilprw2',
  VERSION: '0.8.13',
  ENTRY: 'main-BcyzVqXo-mvilprw2.js',
  GAME: 'main-D5OUVqGK-mvilprw2.js',
  INDEX: 'index.html',
});

export function resolveBuildTarget(env = process.env) {
  return {
    BUILD: env.PB_BUILD || DEFAULT_TARGET.BUILD,
    VERSION: env.PB_VERSION || DEFAULT_TARGET.VERSION,
    ENTRY: env.PB_ENTRY || DEFAULT_TARGET.ENTRY,
    GAME: env.PB_GAME || DEFAULT_TARGET.GAME,
    INDEX: env.PB_INDEX || DEFAULT_TARGET.INDEX,
  };
}

const resolved = resolveBuildTarget();
export const BUILD = resolved.BUILD;
export const VERSION = resolved.VERSION;
export const ENTRY = resolved.ENTRY;
export const GAME = resolved.GAME;
export const INDEX = resolved.INDEX;

export default {
  BUILD,
  VERSION,
  ENTRY,
  GAME,
  INDEX,
  LEGACY,
  DEFAULT_TARGET,
  resolveBuildTarget,
};
