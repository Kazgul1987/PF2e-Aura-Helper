const movementStarts = new Map();
const currentAuraOccupancy = new Map();
const wasInAura = new Map();
const recentAuraEvents = new Map();
const recentEmitterAuraEvents = new Map();
const tokenMovementSequence = new Map();

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

function patchChatMessageUserAlias() {
  const chatMessageClass = CONFIG?.ChatMessage?.documentClass;
  const prototype = chatMessageClass?.prototype;
  if (!prototype) return;

  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'user');
  if (!descriptor?.get || descriptor.set) return;

  Object.defineProperty(prototype, 'user', {
    configurable: true,
    enumerable: descriptor.enumerable ?? false,
    get() {
      return this.author ?? null;
    },
  });
}

function getAuraEventKey({ combatId, eventKind, tokenId, enemyId, auraSlug, round, turn, eventSequence }) {
  return `${combatId ?? 'none'}:${eventKind}:${tokenId}:${enemyId}:${auraSlug}:${round}:${turn}:${eventSequence ?? 'none'}`;
}

function nextTokenMovementSequence(tokenId) {
  const current = tokenMovementSequence.get(tokenId) ?? 0;
  const next = current + 1;
  tokenMovementSequence.set(tokenId, next);
  return next;
}

function isPrimaryActiveGm() {
  if (!game.user.isGM) return false;
  const activeGms = game.users
    .filter((user) => user.isGM && user.active)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (activeGms.length === 0) return true;
  return activeGms[0].id === game.user.id;
}

function isDuplicate(cache, payload) {
  const key = getAuraEventKey(payload);
  const now = Date.now();
  for (const [cachedKey, expiresAt] of cache) {
    if (expiresAt <= now) cache.delete(cachedKey);
  }
  const cached = cache.get(key);
  if (cached && cached > now) return true;
  cache.set(key, now + AURA_EVENT_TTL_MS);
  return false;
}

function emitAuraEvent(payload) {
  if (isDuplicate(recentEmitterAuraEvents, payload)) {
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

function resolveAuraFromSource(sourceToken, auraSlug) {
  if (!sourceToken?.actor?.auras) return null;
  const directAura = sourceToken.actor.auras.get(auraSlug);
  if (directAura) return directAura;

  const auras = [...sourceToken.actor.auras.values()];
  return auras.find((aura) => aura.slug === auraSlug) ?? null;
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
    if (isDuplicate(recentAuraEvents, payload)) {
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
    const aura = resolveAuraFromSource(enemy, payload.auraSlug);
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
  patchChatMessageUserAlias();

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
    default: false,
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
function isResponsiblePosterForToken(token) {
  const actor = token?.actor;
  if (!actor) return false;

  const primaryUpdaterId = actor.primaryUpdater?.id ?? null;
  if (primaryUpdaterId) {
    return primaryUpdaterId === game.user.id;
  }

  const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  const activeNonGmOwnerIds = Object.entries(actor.ownership ?? {})
    .filter(([id, level]) => {
      if (id === 'default') return false;
      if (level < ownerLevel) return false;
      const user = game.users.get(id);
      return !!user?.active && !user.isGM;
    })
    .map(([id]) => id)
    .sort((leftId, rightId) => leftId.localeCompare(rightId));

  if (activeNonGmOwnerIds.length === 0) {
    return game.user.isGM;
  }

  return activeNonGmOwnerIds[0] === game.user.id;
}

async function createWinterSleetChatMessage({ token, source, whisperToGm = false }) {
  if (!token?.actor || !source?.actor) return;
  if (!isResponsiblePosterForToken(token)) {
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

    return true;
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

function isTokenInsideAura(aura, tokenLike) {
  if (!aura || typeof aura.containsToken !== 'function' || !tokenLike) return false;
  const tokenOrDocument = tokenLike.document ?? tokenLike;
  if (!tokenOrDocument) return false;

  return !!aura.containsToken(tokenOrDocument);
}

function getCurrentStandardAuraHits(token) {
  const auraChecks = getStandardAuraChecks(token);
  const hits = [];

  for (const { source, aura } of auraChecks) {
    if (!isTokenInsideAura(aura, token)) continue;
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

  return isResponsiblePosterForToken(token);
}

function getDocumentAtMovementStart(token) {
  if (!token?.document || !token._movement) return null;

  const startPoint = token._movement?.rays?.[0]?.A ?? token._movement?.ray?.A;
  if (!startPoint) return null;

  const width = token.w ?? token.document.width * canvas.grid.size;
  const height = token.h ?? token.document.height * canvas.grid.size;
  const x = startPoint.x - width / 2;
  const y = startPoint.y - height / 2;

  return token.document.clone({ x, y }, { keepId: true });
}

async function handleAura({ token, enemy, aura, message, whisperToGm = false }) {
  if (!isResponsiblePosterForToken(token)) {
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

async function checkAllCurrentAuraOccupancy({ eventKind = AURA_EVENT_KINDS.ENTER } = {}) {
  const tokens = canvas.tokens?.placeables ?? [];
  if (tokens.length === 0) return;

  const activeCombatTokenId = game.combat?.combatant?.tokenId ?? null;
  for (const token of tokens) {
    if (!isCombatRelevantToken(token)) continue;

    const currentHits = getCurrentStandardAuraHits(token);
    const currentSet = new Set(currentHits.map(({ auraKey }) => auraKey));
    wasInAura.set(token.id, currentSet);

    if (eventKind === AURA_EVENT_KINDS.START_TURN && token.id !== activeCombatTokenId) continue;

    for (const { source, aura } of currentHits) {
      emitAuraEvent({
        type: AURA_EVENT_TYPE,
        eventKind,
        tokenId: token.id,
        enemyId: source.id,
        auraSlug: aura.slug,
        combatId: game.combat?.id ?? null,
        round: game.combat?.round ?? 0,
        turn: game.combat?.turn ?? 0,
      });
    }
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
  const isEmitter = isPrimaryActiveGm();
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
      reason: 'Current client is not selected start-turn emitter',
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
    const inside = isTokenInsideAura(aura, token);
    logDebug('evaluating aura', {
      source: source.name,
      aura: aura.slug,
      inside,
    });
    if (!inside) continue;
    const round = game.combat?.round ?? 0;
    const turn = game.combat?.turn ?? 0;
    logDebug('Aura detected (start-turn)', {
      tokenId: token.id,
      tokenName: token.name,
      sourceId: source.id,
      sourceName: source.name,
      auraSlug: aura.slug,
      inside,
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
  const movementSequence = nextTokenMovementSequence(token.id);
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
      const inside = isTokenInsideAura(aura, token);
      logDebug('Aura detected (enter)', {
        tokenId: token.id,
        tokenName: token.name,
        sourceId: source.id,
        sourceName: source.name,
        auraSlug: aura.slug,
        inside,
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
        eventSequence: movementSequence,
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
    const movementStartDocument = getDocumentAtMovementStart(token) ?? token.document;
    const wsOccupancyMap = currentAuraOccupancy.get(token.id) ?? new Map();

    for (const source of winterSleetSources) {
      if (!source.actor?.isEnemyOf(token.actor)) continue;
      const aura = source.actor.auras?.get(WINTER_SLEET_AURA_SLUG);
      if (!aura) continue;
      const key = `${source.id}-winter-sleet`;
      const startedInside = isTokenInsideAura(aura, movementStartDocument);
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
    const isInside = isTokenInsideAura(aura, token);
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
        eventSequence: movementSequence,
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
  tokenMovementSequence.delete(tokenDoc.id);
});

Hooks.on('canvasReady', async () => {
  movementStarts.clear();
  currentAuraOccupancy.clear();
  wasInAura.clear();
  tokenMovementSequence.clear();
  await checkAllCurrentAuraOccupancy({ eventKind: AURA_EVENT_KINDS.START_TURN });
});
