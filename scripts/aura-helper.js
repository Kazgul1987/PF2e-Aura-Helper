const movementStarts = new Map();
const currentAuraOccupancy = new Map();
const recentAuraEvents = new Map();

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

function getAuraEventKey({ eventKind, tokenId, enemyId, auraSlug, round, turn }) {
  return `${eventKind}:${tokenId}:${enemyId}:${auraSlug}:${round}:${turn}`;
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

Hooks.once('ready', () => {
  game.socket.on(`module.${MODULE_ID}`, async (payload) => {
    if (!game.user.isGM) return;
    if (!payload) return;

    if (payload.type !== AURA_EVENT_TYPE) return;
    if (
      payload.eventKind !== AURA_EVENT_KINDS.START_TURN &&
      payload.eventKind !== AURA_EVENT_KINDS.ENTER &&
      payload.eventKind !== AURA_EVENT_KINDS.WINTER_SLEET
    ) {
      return;
    }
    if (isDuplicateAuraEvent(payload)) return;

    if (payload.eventKind === AURA_EVENT_KINDS.WINTER_SLEET) {
      const token = canvas.tokens.get(payload.tokenId);
      const source = canvas.tokens.get(payload.enemyId);
      await createWinterSleetChatMessage({ token, source, whisperToGm: true });
      return;
    }

    const token = canvas.tokens.get(payload.tokenId);
    const enemy = canvas.tokens.get(payload.enemyId);
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
      whisperToGm: true,
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
});


function getClassDcFromActor(actor) {
  const classDC = Number(actor?.system?.attributes?.classDC?.value);
  if (!Number.isFinite(classDC)) return null;
  return classDC - 2;
}

async function createWinterSleetChatMessage({ token, source, whisperToGm = false }) {
  if (!token?.actor || !source?.actor) return;
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
  return canvas.tokens.placeables.filter((candidate) => {
    if (!isCombatRelevantToken(candidate)) return false;
    if (!candidate.actor.isEnemyOf(activeToken.actor)) return false;

    if (isActivePartyMember) {
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

function gmIds() {
  return game.users.filter((u) => u.isGM).map((u) => u.id);
}

function isResponsibleOwnerClient(token) {
  if (!token?.actor || game.user.isGM) return false;
  if (!token.actor.testUserPermission(game.user, 'OWNER')) return false;

  const ownership = token.actor.ownership ?? {};
  const ownerUsers = game.users.filter((user) => {
    if (user.isGM || !user.active) return false;
    const level = ownership[user.id] ?? ownership.default ?? 0;
    return level >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  });

  if (ownerUsers.length === 0) return true;
  ownerUsers.sort((a, b) => a.id.localeCompare(b.id));
  return ownerUsers[0].id === game.user.id;
}

async function handleAura({ token, enemy, aura, message, whisperToGm = false }) {
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
  if (game.user.isGM) return;
  logDebug('pf2e.startTurn', { combatant });
  const token = combatant.token?.object ?? combatant.token;
  if (!isResponsibleOwnerClient(token)) return;
  const auraChecks = getStandardAuraChecks(token);
  logDebug(
    'standard aura sources in scene',
    auraChecks.map(({ source, aura }) => `${source.name}:${aura.slug}`)
  );

  for (const { source, aura } of auraChecks) {
    const distance = canvas.grid.measureDistance(token, source);
    logDebug('evaluating aura', {
      source: source.name,
      aura: aura.slug,
      distance,
      radius: aura.radius,
    });
    if (distance > aura.radius) continue;
    game.socket.emit(`module.${MODULE_ID}`, {
      type: AURA_EVENT_TYPE,
      eventKind: AURA_EVENT_KINDS.START_TURN,
      tokenId: token.id,
      enemyId: source.id,
      auraSlug: aura.slug,
      round: game.combat?.round ?? 0,
      turn: game.combat?.turn ?? 0,
    });
  }

});

Hooks.on('updateToken', async (tokenDoc, change, _options, _userId) => {
  logInfo('updateToken received', { tokenId: tokenDoc.id, change });
  if (game.user.isGM) return;
  if (change.x === undefined && change.y === undefined) return;
  const token = tokenDoc.object;
  if (!token) return;
  if (!isResponsibleOwnerClient(token)) return;
  const auraChecks = getStandardAuraChecks(token);
  let occupancyMap = currentAuraOccupancy.get(token.id) ?? new Map();

  if (token._movement) {
    if (!movementStarts.has(token.id)) {
      const processedKeys = new Set();
      const startPoint =
        token._movement?.rays?.[0]?.A ??
        token._movement?.ray?.A ?? {
          x: token.center.x,
          y: token.center.y,
        };
      const startMap = new Map();
      occupancyMap = currentAuraOccupancy.get(token.id) ?? new Map();
      for (const { source, aura } of auraChecks) {
        const key = `${source.id}-${aura.slug}`;
        const distance = canvas.grid.measureDistance(startPoint, source.center);
        const isInside = distance <= aura.radius;
        startMap.set(key, isInside);
        if (isInside) {
          occupancyMap.set(key, true);
        } else {
          occupancyMap.delete(key);
        }
        processedKeys.add(key);
      }
      for (const key of [...occupancyMap.keys()]) {
        if (!processedKeys.has(key)) occupancyMap.delete(key);
      }
      if (occupancyMap.size > 0) {
        currentAuraOccupancy.set(token.id, occupancyMap);
      } else {
        currentAuraOccupancy.delete(token.id);
      }
      movementStarts.set(token.id, startMap);
    }
    return;
  }

  const standardStartMap = movementStarts.get(token.id) ?? new Map();
  movementStarts.delete(token.id);
  occupancyMap = currentAuraOccupancy.get(token.id) ?? new Map();
  const processedKeys = new Set();
  for (const { source, aura } of auraChecks) {
    const key = `${source.id}-${aura.slug}`;
    processedKeys.add(key);
    const previousInside =
      (standardStartMap.has(key) ? standardStartMap.get(key) : occupancyMap.get(key)) ?? false;
    // Einmalige Distanzmessung für die Auswertung von isInside.
    const newDistance = canvas.grid.measureDistance(token.center, source.center);
    const isInside = newDistance <= aura.radius;
    if (isInside) {
      if (!previousInside) {
        game.socket.emit(`module.${MODULE_ID}`, {
          type: AURA_EVENT_TYPE,
          eventKind: AURA_EVENT_KINDS.ENTER,
          tokenId: token.id,
          enemyId: source.id,
          auraSlug: aura.slug,
          round: game.combat?.round ?? 0,
          turn: game.combat?.turn ?? 0,
        });
      }
      occupancyMap.set(key, true);
    } else if (occupancyMap.get(key)) {
      occupancyMap.delete(key);
    }
  }
  for (const key of [...occupancyMap.keys()]) {
    if (!processedKeys.has(key)) {
      occupancyMap.delete(key);
    }
  }
  if (occupancyMap.size > 0) {
    currentAuraOccupancy.set(token.id, occupancyMap);
  } else {
    currentAuraOccupancy.delete(token.id);
  }

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
      game.socket.emit(`module.${MODULE_ID}`, {
        type: AURA_EVENT_TYPE,
        eventKind: AURA_EVENT_KINDS.WINTER_SLEET,
        tokenId: token.id,
        enemyId: source.id,
        auraSlug: WINTER_SLEET_AURA_SLUG,
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
});

Hooks.on('canvasReady', () => {
  movementStarts.clear();
  currentAuraOccupancy.clear();
});
