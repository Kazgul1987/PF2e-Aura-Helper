import { MODULE_ID } from '../constants.js';

const prefix = `[${MODULE_ID}]`;

export const log = (...args) => console.info(prefix, ...args);
export const warn = (...args) => console.warn(prefix, ...args);
export const error = (...args) => console.error(prefix, ...args);

export function debug(...args) {
  const key = `${MODULE_ID}.logLevel`;
  if (!game.settings?.settings?.has(key)) return;
  const level = game.settings.get(MODULE_ID, 'logLevel');
  if (level !== 'debug' && level !== 'winter-sleet') return;
  console.debug(prefix, ...args);
}
