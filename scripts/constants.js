export const MODULE_ID = 'pf2e-aura-helper';

export const AuraEventType = Object.freeze({
  ENTER: 'enter',
  LEAVE: 'leave',
  START_TURN: 'startTurn',
  MOVE: 'move',
});

export const SocketMessageType = Object.freeze({
  AURA_EVENT: 'aura-event',
  UPDATE_SUPPRESSION: 'update-suppression',
  REFRESH_WINTER_SLEET: 'refresh-winter-sleet',
});
