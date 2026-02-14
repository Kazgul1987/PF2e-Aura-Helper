const movementStarts = new Map();
const currentAuraOccupancy = new Map();
const wasInAura = new Map();
const recentAuraEvents = new Map();
const recentEmitterAuraEvents = new Map();

const MODULE_ID = 'pf2e-aura-helper';
const AURA_EVENT_TYPE = 'AURA_EVENT';
const AURA_EVENT_KINDS = {
  START_TURN: 'START_TURN',
  ENTER: 'ENTER',
  WINTER_SLEET: 'WINTER_SLEET',
};
const AURA_EVENT_TTL_MS = 5000;
const WINTER_SLEET_AURA_SLUG = 'kinetic-aura';
const WINTER_SLEET_EFFECT_SLUG = 'effect-kinetic-aura';
const WINTER_SLEET_STANCE_SLUG = 'stance-winter-sleet';
const WINTER_SLEET_TRIGGER_ON_MOVE_WITHIN = true;
const SETTING_DEBUG_ENABLED = 'debugEnabled';
const SETTING_LOG_LEVEL = 'logLevel';
const SETTING_REQUIRE_VISIBLE_ENEMIES = 'requireVisibleEnemies';
const SETTING_PUBLIC_CHAT_MESSAGES = 'publicChatMessages';
const LOG_LEVELS = {
  OFF: 'off',
  INFO: 'info',
  DEBUG: 'debug',
};

function getLogLevel() {
  const configuredLogLevel = game.settings.get(MODULE_ID, SETTING_LOG_LEVEL);
  if (Object.values(LOG_LEVELS).includes(configuredLogLevel)) return configuredLogLevel;
  const debugEnabled = game.settings.get(MODULE_ID, SETTING_DEBUG_ENABLED);
  return debugEnabled ? LOG_LEVELS.DEBUG : LOG_LEVELS.OFF;
}

function logDebug(...args) {
  if (getLogLevel() !== LOG_LEVELS.DEBUG) return;
  console.debug('[Aura Helper]', ...args);
}

function logInfo(...args) {
  const logLevel = getLogLevel();
  if (logLevel !== LOG_LEVELS.INFO && logLevel !== LOG_LEVELS.DEBUG) return;
  console.info('[Aura Helper]', ...args);
}

function shouldRequireVisibleEnemies() {
  return game.settings.get(MODULE_ID, SETTING_REQUIRE_VISIBLE_ENEMIES);
}

function shouldWhisperToGm() {
  return !game.settings.get(MODULE_ID, SETTING_PUBLIC_CHAT_MESSAGES);
}

function getAuraEventKey({ combatId, eventKind, tokenId, enemyId, auraSlug, round, turn }) {
  return `${combatId ?? 'none'}:${eventKind}:${tokenId}:${enemyId}:${auraSlug}:${round}:${turn}`;
}

function isDuplicateAuraEvent(payload) {
  const key = getAuraEventKey(payload);
  const now = Date.now();
  for (const [cachedKey, expiresAt] of recentAuraEvents) {
    if (expiresAt <= now) recentAuraEvents.delete(cachedKey);
  }
  const cached = recentAuraEvents.get(key);
  if (cached && cached > now) return true;
  recentAuraEvents.set(key, now + AURA_EVENT_TTL_MS);
  return false;
}

function isDuplicateEmitterAuraEvent(payload) {
  const key = getAuraEventKey(payload);
  const now = Date.now();
  for (const [cachedKey, expiresAt] of recentEmitterAuraEvents) {
    if (expiresAt <= now) recentEmitterAuraEvents.delete(cachedKey);
  }
  const cached = recentEmitterAuraEvents.get(key);
  if (cached && cached > now) return true;
  recentEmitterAuraEvents.set(key, now + AURA_EVENT_TTL_MS);
  return false;
}

function emitAuraEvent(payload) {
  if (isDuplicateEmitterAuraEvent(payload)) {
    logDebug('skip duplicate emit (local)', {
      eventKind: payload.eventKind,
      tokenId: payload.tokenId,
      enemyId: payload.enemyId,
      auraSlug: payload.auraSlug,
      combatId: payload.combatId,
      round: payload.round,
      turn: payload.turn,
    });
    return;
  }

  logDebug('emit aura event', {
    eventKind: payload.eventKind,
    tokenId: payload.tokenId,
    enemyId: payload.enemyId,
    auraSlug: payload.auraSlug,
    combatId: payload.combatId,
    round: payload.round,
    turn: payload.turn,
  });

  game.socket.emit(`module.${MODULE_ID}`, payload);
}

Hooks.once('ready', () => {
  game.socket.on(`module.${MODULE_ID}`, async (payload) => {
    if (!payload) return;

    if (payload.type !== AURA_EVENT_TYPE) return;
    if (
      payload.eventKind !== AURA_EVENT_KINDS.START_TURN &&
      payload.eventKind !== AURA_EVENT_KINDS.ENTER &&
      payload.eventKind !== AURA_EVENT_KINDS.WINTER_SLEET
    ) {
      return;
    }
    if (isDuplicateAuraEvent(payload)) {
      logDebug('skip duplicate incoming aura event', {
        eventKind: payload.eventKind,
        tokenId: payload.tokenId,
        enemyId: payload.enemyId,
        auraSlug: payload.auraSlug,
        combatId: payload.combatId,
        round: payload.round,
        turn: payload.turn,
      });
      return;
    }

    const token = canvas.tokens.get(payload.tokenId);
    const enemy = canvas.tokens.get(payload.enemyId);
    logDebug('Aura event received', {
      eventKind: payload.eventKind,
      tokenId: payload.tokenId,
      tokenName: token?.name ?? null,
      sourceId: payload.enemyId,
      sourceName: enemy?.name ?? null,
      auraSlug: payload.auraSlug,
      round: payload.round,
      turn: payload.turn,
    });

    if (payload.eventKind === AURA_EVENT_KINDS.WINTER_SLEET) {
      const token = canvas.tokens.get(payload.tokenId);
      const source = canvas.tokens.get(payload.enemyId);
      await createWinterSleetChatMessage({ token, source, whisperToGm: shouldWhisperToGm() });
      return;
    }

    if (!token?.actor || !enemy?.actor) return;
    const aura = enemy?.actor?.auras?.get(payload.auraSlug);
    if (!token || !enemy || !aura) return;

    await handleAura({
      token,
      enemy,
      aura,
      message: (auraLink) =>
        payload.eventKind === AURA_EVENT_KINDS.START_TURN
          ? `${token.name} beginnt seinen Zug innerhalb der Aura ${auraLink} von ${enemy.name}.`
          : `${token.name} betritt die Aura ${auraLink} von ${enemy.name}.`,
      whisperToGm: shouldWhisperToGm(),
    });
  });
});

Hooks.once('init', () => {
  game.settings.register(MODULE_ID, SETTING_DEBUG_ENABLED, {
    name: 'Enable debug logging',
    hint: 'Activates detailed debug logging for PF2e Aura Helper.',
    scope: 'client',
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, SETTING_LOG_LEVEL, {
    name: 'Log level',
    hint: 'Controls how much PF2e Aura Helper writes to the browser console.',
    scope: 'client',
    config: true,
    type: String,
    choices: {
      [LOG_LEVELS.OFF]: 'Off',
      [LOG_LEVELS.INFO]: 'Info',
      [LOG_LEVELS.DEBUG]: 'Debug',
    },
    default: LOG_LEVELS.OFF,
  });

  game.settings.register(MODULE_ID, SETTING_REQUIRE_VISIBLE_ENEMIES, {
    name: 'Only trigger visible enemy auras',
    hint: 'If enabled, aura reminders trigger only for enemy tokens visible to the party.',
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, SETTING_PUBLIC_CHAT_MESSAGES, {
    name: 'Send aura chat messages publicly',
    hint: 'If enabled, aura reminders are posted to public chat instead of GM whisper.',
    scope: 'world',
    config: true,
    type: Boolean,
    default: false,
  });
});


function getClassDcFromActor(actor) {
  const classDC = Number(actor?.system?.attributes?.classDC?.value);
  if (!Number.isFinite(classDC)) return null;
  return classDC - 2;
}

function isPrimaryUpdaterForToken(token) {
  const actor = token?.actor;
  return !!actor && actor.primaryUpdater === game.user;
}

async function createWinterSleetChatMessage({ token, source, whisperToGm = false }) {
  if (!token?.actor || !source?.actor) return;
  if (!isPrimaryUpdaterForToken(token)) {
    logDebug('skip winter sleet chat message: not primary updater', {
      tokenId: token.id,
      tokenName: token.name,
      currentUserId: game.user.id,
      primaryUpdaterId: token.actor.primaryUpdater?.id ?? null,
    });
    return;
  }
  const stance = source.actor.items.find((item) => item.slug === WINTER_SLEET_STANCE_SLUG);
  const sourceName = stance?.name ?? 'Winter Sleet';
  const sourceLink = stance?.uuid ? `@UUID[${stance.uuid}]{${sourceName}}` : sourceName;
  const dc = getClassDcFromActor(source.actor);
  const check = dc !== null ? `@Check[acrobatics|dc:${dc}]` : '@Check[acrobatics]';
  const content = `${token.name} bewegt sich in der Aura ${sourceLink} von ${source.name}: ${check}`;
  const speaker = ChatMessage.getSpeaker({ token: token.document, actor: token.actor });
  await ChatMessage.create({
    content,
    speaker,
    whisper: whisperToGm ? gmIds() : undefined,
  });
}

function getWinterSleetSources() {
  const partyMembers = game.actors.party?.members ?? [];
  if (partyMembers.length === 0) return [];

  return canvas.tokens.placeables.filter((token) => {
    if (!token.actor) return false;
    const isPartyMember = partyMembers.some((member) => member.id === token.actor.id);
    if (!isPartyMember) return false;
    const effects = token.actor.itemTypes?.effect ?? [];
    const hasKineticAura = effects.some((effect) => effect.slug === WINTER_SLEET_EFFECT_SLUG);
    const hasWinterSleet = effects.some((effect) => effect.slug === WINTER_SLEET_STANCE_SLUG);
    return hasKineticAura && hasWinterSleet && !!token.actor.auras?.get(WINTER_SLEET_AURA_SLUG);
  });
}

function getPartyTokens() {
  const partyMembers = game.actors.party?.members ?? [];
  if (partyMembers.length === 0) return [];
  return canvas.tokens.placeables.filter((token) => {
    if (!token.actor) return false;
    if (!(token.isVisible ?? !token.document.hidden)) return false;
    return partyMembers.some((member) => member.id === token.actor.id);
  });
}

function isVisibleToParty(enemyToken) {
  if (!enemyToken) return false;
  const partyTokens = getPartyTokens();
  if (partyTokens.length === 0) return false;
  const visibility = canvas.visibility ?? canvas.effects?.visibility;
  if (!visibility) return false;
  return partyTokens.some((playerToken) =>
    visibility.testVisibility(enemyToken.center, { object: playerToken })
  );
}

function isCombatRelevantToken(token) {
  if (!token?.actor) return false;
  const isHidden = token.document?.hidden ?? false;
  const isDefeated = token.combatant?.isDefeated ?? token.combatant?.defeated ?? false;
  return !isHidden && !isDefeated;
}

function isPartyMemberActor(actor) {
  if (!actor) return false;
  const partyMembers = game.actors.party?.members ?? [];
  return partyMembers.some((member) => member.id === actor.id);
}

function getStandardAuraSources(activeToken) {
  if (!activeToken?.actor) return [];

  const isActivePartyMember = isPartyMemberActor(activeToken.actor);
  const requireVisibleEnemies = shouldRequireVisibleEnemies();
  return canvas.tokens.placeables.filter((candidate) => {
    if (!isCombatRelevantToken(candidate)) return false;
    if (!candidate.actor.isEnemyOf(activeToken.actor)) return false;

    if (requireVisibleEnemies && isActivePartyMember) {
      return isVisibleToParty(candidate);
    }

    return candidate.isVisible ?? !candidate.document?.hidden;
  });
}

function getStandardAuraChecks(activeToken) {
  const sources = getStandardAuraSources(activeToken);
  const checks = [];

  for (const source of sources) {
    const auras = source.actor?.auras ? [...source.actor.auras.values()] : [];
    for (const aura of auras) {
      checks.push({ source, aura });
    }
  }

  return checks;
}

function isTokenInsideAura(token, source, aura) {
  if (typeof aura?.containsToken === 'function') {
    return aura.containsToken(token);
  }

  const distance = canvas.grid.measureDistance(token.center, source.center);
  return distance <= aura.radius;
}

function getCurrentStandardAuraHits(token) {
  const auraChecks = getStandardAuraChecks(token);
  const hits = [];

  for (const { source, aura } of auraChecks) {
    if (!isTokenInsideAura(token, source, aura)) continue;
    const auraKey = `${source.id}-${aura.slug}`;
    hits.push({ auraKey, source, aura });
  }

  return hits;
}

function gmIds() {
  return game.users.filter((u) => u.isGM).map((u) => u.id);
}

function isEmitterForTokenChange(token, userId) {
  if (!token?.actor) return false;

  if (userId !== undefined && userId !== null) {
    return userId === game.user.id;
  }

  return isPrimaryUpdaterForToken(token);
}

async function handleAura({ token, enemy, aura, message, whisperToGm = false }) {
  if (!isPrimaryUpdaterForToken(token)) {
    logDebug('skip standard aura chat message: not primary updater', {
      tokenId: token?.id ?? null,
      tokenName: token?.name ?? null,
      currentUserId: game.user.id,
      primaryUpdaterId: token?.actor?.primaryUpdater?.id ?? null,
    });
    return;
  }
  const effect = aura.effects?.[0];
  logDebug('aura effect', effect);
  let originUuid =
    effect?.origin ??
    effect?.sourceId ??
    effect?.system?.context?.origin?.uuid ??
    null;
  let originItem = null;
  if (!originUuid) {
    originItem = enemy.actor.items.find((i) => i.slug === aura.slug) ?? null;
    logDebug('searched enemy items by slug', {
      slug: aura.slug,
      item: originItem,
    });
    if (!originItem) {
      const searchName = effect?.name ?? aura.slug.replace(/-/g, ' ');
      originItem = enemy.actor.items.find(
        (i) => i.name.toLowerCase() === searchName.toLowerCase()
      );
      logDebug('searched enemy items by name', {
        search: searchName,
        item: originItem,
      });
    }
    originUuid = originItem?.uuid ?? null;
    if (!originItem) {
      console.warn('[Aura Helper] no matching item found for aura', {
        aura: aura.slug,
        enemy: enemy.name,
      });
    }
  }
  logDebug('resolved originUuid', originUuid);
  const origin = originItem ?? (originUuid ? await fromUuid(originUuid) : null);
  const auraName = origin?.name ?? aura.slug;
  const auraLink = originUuid ? `@UUID[${originUuid}]{${auraName}}` : auraName;
  const content = message(auraLink);
  logDebug('creating chat message', content);
  const speaker = ChatMessage.getSpeaker({
    token: token.document,
    actor: token.actor,
  });
  await ChatMessage.create({
    content,
    speaker,
    whisper: whisperToGm ? gmIds() : undefined,
  });
  if (!origin) {
    console.warn('[Aura Helper] no item to post for aura', {
      aura: aura.slug,
      enemy: enemy.name,
    });
  }
}

Hooks.on('pf2e.startTurn', async (combatant) => {
  const token = combatant.token?.object ?? combatant.token;
  logDebug('hook entry', {
    hookType: 'pf2e.startTurn',
    tokenName: token?.name ?? null,
    userId: null,
    isGM: game.user.isGM,
  });
  const isEmitter = isEmitterForTokenChange(token);
  logDebug('emitter check', {
    hookType: 'startTurn',
    userId: game.user.id,
    userName: game.user.name,
    isGm: game.user.isGM,
    tokenId: token?.id ?? null,
    tokenName: token?.name ?? null,
    isEmitterForTokenChange: isEmitter,
  });
  if (!isEmitter) {
    logDebug('skip emit: emitter selection denied', {
      hookType: 'pf2e.startTurn',
      reason: 'Current client is not selected emitter',
      tokenId: token?.id ?? null,
      tokenName: token?.name ?? null,
    });
    return;
  }
  const currentHits = getCurrentStandardAuraHits(token);
  const currentSet = new Set(currentHits.map(({ auraKey }) => auraKey));
  logDebug(
    'standard aura sources in scene',
    currentHits.map(({ source, aura }) => `${source.name}:${aura.slug}`)
  );

  for (const { source, aura } of currentHits) {
    const distance = canvas.grid.measureDistance(token, source);
    logDebug('evaluating aura', {
      source: source.name,
      aura: aura.slug,
      distance,
      radius: aura.radius,
    });
    if (distance > aura.radius) continue;
    const round = game.combat?.round ?? 0;
    const turn = game.combat?.turn ?? 0;
    logDebug('Aura detected (start-turn)', {
      tokenId: token.id,
      tokenName: token.name,
      sourceId: source.id,
      sourceName: source.name,
      auraSlug: aura.slug,
      distance,
      radius: aura.radius,
      round,
      turn,
    });
    emitAuraEvent({
      type: AURA_EVENT_TYPE,
      eventKind: AURA_EVENT_KINDS.START_TURN,
      tokenId: token.id,
      enemyId: source.id,
      auraSlug: aura.slug,
      combatId: game.combat?.id ?? null,
      round,
      turn,
    });
  }

  wasInAura.set(token.id, currentSet);

});

Hooks.on('updateToken', async (tokenDoc, change, _options, userId) => {
  const token = tokenDoc.object;
  logDebug('hook entry', {
    hookType: 'updateToken',
    tokenName: token?.name ?? null,
    userId: userId ?? null,
    isGM: game.user.isGM,
  });
  if (change.x === undefined && change.y === undefined) return;
  if (!token) return;
  const isEmitter = isEmitterForTokenChange(token, userId);
  logDebug('emitter check', {
    hookType: 'updateToken',
    userId: game.user.id,
    userName: game.user.name,
    isGm: game.user.isGM,
    hookUserId: userId ?? null,
    tokenId: token?.id ?? null,
    tokenName: token?.name ?? null,
    isEmitterForTokenChange: isEmitter,
  });
  if (!isEmitter) {
    logDebug('skip emit: emitter selection denied', {
      hookType: 'updateToken',
      reason: 'Current client is not selected emitter',
      tokenId: token?.id ?? null,
      tokenName: token?.name ?? null,
      hookUserId: userId ?? null,
    });
    return;
  }
  const currentHits = getCurrentStandardAuraHits(token);
  const currentSet = new Set(currentHits.map(({ auraKey }) => auraKey));
  const prevSet = wasInAura.get(token.id) ?? new Set();
  const entered = [...currentSet].filter((auraKey) => !prevSet.has(auraKey));

  if (entered.length > 0) {
    const currentByKey = new Map(currentHits.map((hit) => [hit.auraKey, hit]));
    for (const auraKey of entered) {
      const hit = currentByKey.get(auraKey);
      if (!hit) continue;
      const { source, aura } = hit;
      const round = game.combat?.round ?? 0;
      const turn = game.combat?.turn ?? 0;
      const distance = canvas.grid.measureDistance(token, source);
      logDebug('Aura detected (enter)', {
        tokenId: token.id,
        tokenName: token.name,
        sourceId: source.id,
        sourceName: source.name,
        auraSlug: aura.slug,
        distance,
        radius: aura.radius,
        round,
        turn,
      });
      emitAuraEvent({
        type: AURA_EVENT_TYPE,
        eventKind: AURA_EVENT_KINDS.ENTER,
        tokenId: token.id,
        enemyId: source.id,
        auraSlug: aura.slug,
        combatId: game.combat?.id ?? null,
        round,
        turn,
      });
    }
  }

  wasInAura.set(token.id, currentSet);

  const winterSleetSources = getWinterSleetSources();
  if (winterSleetSources.length === 0) return;

  if (token._movement) {
    let startMap = movementStarts.get(token.id);
    if (!startMap) {
      startMap = new Map();
      movementStarts.set(token.id, startMap);
    }
    const startPoint = token._movement?.rays?.[0]?.A ?? token._movement?.ray?.A ?? token.center;
    const wsOccupancyMap = currentAuraOccupancy.get(token.id) ?? new Map();

    for (const source of winterSleetSources) {
      if (!source.actor?.isEnemyOf(token.actor)) continue;
      const aura = source.actor.auras?.get(WINTER_SLEET_AURA_SLUG);
      if (!aura) continue;
      const key = `${source.id}-winter-sleet`;
      const startDistance = canvas.grid.measureDistance(startPoint, source.center);
      const startedInside = startDistance <= aura.radius;
      startMap.set(key, startedInside);
      if (startedInside) {
        wsOccupancyMap.set(key, true);
      } else {
        wsOccupancyMap.delete(key);
      }
    }

    if (wsOccupancyMap.size > 0) {
      currentAuraOccupancy.set(token.id, wsOccupancyMap);
    } else {
      currentAuraOccupancy.delete(token.id);
    }
    return;
  }

  const startMap = movementStarts.get(token.id) ?? new Map();
  movementStarts.delete(token.id);
  const wsOccupancyMap = currentAuraOccupancy.get(token.id) ?? new Map();

  for (const source of winterSleetSources) {
    if (!source.actor?.isEnemyOf(token.actor)) continue;
    const aura = source.actor.auras?.get(WINTER_SLEET_AURA_SLUG);
    if (!aura) continue;

    const key = `${source.id}-winter-sleet`;
    const previousInside =
      (startMap.has(key) ? startMap.get(key) : wsOccupancyMap.get(key)) ?? false;
    const distance = canvas.grid.measureDistance(token.center, source.center);
    const isInside = distance <= aura.radius;
    const shouldTrigger =
      (!previousInside && isInside) ||
      (WINTER_SLEET_TRIGGER_ON_MOVE_WITHIN && previousInside && isInside);

    if (shouldTrigger) {
      emitAuraEvent({
        type: AURA_EVENT_TYPE,
        eventKind: AURA_EVENT_KINDS.WINTER_SLEET,
        tokenId: token.id,
        enemyId: source.id,
        auraSlug: WINTER_SLEET_AURA_SLUG,
        combatId: game.combat?.id ?? null,
        round: game.combat?.round ?? 0,
        turn: game.combat?.turn ?? 0,
      });
    }

    if (isInside) {
      wsOccupancyMap.set(key, true);
    } else {
      wsOccupancyMap.delete(key);
    }
  }

  if (wsOccupancyMap.size > 0) {
    currentAuraOccupancy.set(token.id, wsOccupancyMap);
  } else {
    currentAuraOccupancy.delete(token.id);
  }


});

Hooks.on('deleteToken', (tokenDoc) => {
  movementStarts.delete(tokenDoc.id);
  currentAuraOccupancy.delete(tokenDoc.id);
  wasInAura.delete(tokenDoc.id);
});

Hooks.on('canvasReady', () => {
  movementStarts.clear();
  currentAuraOccupancy.clear();
  wasInAura.clear();
});
