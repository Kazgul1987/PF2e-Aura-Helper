import { MODULE_ID } from '../constants.js';

const prefix = `[${MODULE_ID}]`;

export const LOG_LEVELS = Object.freeze({
  OFF: 'off',
  INFO: 'info',
  DEBUG: 'debug',
  WINTER_SLEET: 'winter-sleet',
});

export const log = (...args) => console.info(prefix, ...args);
export const warn = (...args) => console.warn(prefix, ...args);
export const error = (...args) => console.error(prefix, ...args);

function isSettingExplicitlyConfigured(settingKey) {
  const fullKey = `${MODULE_ID}.${settingKey}`;
  const definition = game.settings?.settings?.get(fullKey);
  const storage = definition ? game.settings.storage?.get(definition.scope) : null;
  if (!storage) return false;
  if (typeof storage.has === 'function') return storage.has(fullKey);
  if (typeof storage.get === 'function') return storage.get(fullKey) !== undefined;
  return false;
}

export function getLogLevel() {
  const key = `${MODULE_ID}.logLevel`;
  if (game.settings?.settings?.has(key) && isSettingExplicitlyConfigured('logLevel')) {
    const level = game.settings.get(MODULE_ID, 'logLevel');
    if (Object.values(LOG_LEVELS).includes(level)) return level;
  }

  const legacyKey = `${MODULE_ID}.debugEnabled`;
  return game.settings?.settings?.has(legacyKey) && game.settings.get(MODULE_ID, 'debugEnabled')
    ? LOG_LEVELS.DEBUG
    : LOG_LEVELS.OFF;
}

export function debug(...args) {
  if (getLogLevel() !== LOG_LEVELS.DEBUG) return;
  console.debug(prefix, ...args);
}

export function info(...args) {
  const level = getLogLevel();
  if (level !== LOG_LEVELS.INFO && level !== LOG_LEVELS.DEBUG) return;
  console.info(prefix, ...args);
}

export function debugWinterSleet(...args) {
  const level = getLogLevel();
  if (level !== LOG_LEVELS.DEBUG && level !== LOG_LEVELS.WINTER_SLEET) return;
  console.debug(prefix, 'Winter Sleet', ...args);
}
