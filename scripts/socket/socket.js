import { MODULE_ID } from '../constants.js';
import { warn } from '../utils/logging.js';

const handlers = new Map();
let initialized = false;

export function registerSocketHandler(type, handler) {
  if (!type || typeof handler !== 'function') return;
  handlers.set(type, handler);
}

export function emitSocket(type, data = {}) {
  const message = { type, data };
  game.socket.emit(`module.${MODULE_ID}`, message);
  return dispatchSocketMessage(message);
}

export async function dispatchSocketMessage(message) {
  if (!message?.type) return;
  const handler = handlers.get(message.type);
  if (!handler) {
    warn('Unknown socket message type', message.type);
    return;
  }
  await handler(message.data ?? {});
}

export function initializeSocket() {
  if (initialized) return;
  initialized = true;
  game.socket.on(`module.${MODULE_ID}`, dispatchSocketMessage);
}
