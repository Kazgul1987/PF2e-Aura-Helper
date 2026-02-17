const MODULE_ID = 'pf2e-aura-helper';
const AURA_FLAG = 'pf2e-aura-helper';
const AURA_SOURCE_FLAG = 'kinetic-source';
const WINTER_SLEET_REFRESH_EVENT_TYPE = 'WINTER_SLEET_REFRESH';
const WINTER_SLEET_BALANCE_EVENT_TYPE = 'WINTER_SLEET_BALANCE';
const WINTER_SLEET_AURA_SLUG = 'kinetic-aura';
const WINTER_SLEET_EFFECT_AURA_SLUG = 'effect-kinetic-aura';
const WINTER_SLEET_STANCE_SLUG = 'stance-winter-sleet';
const WINTER_SLEET_AURA_SLUG_CANDIDATES = new Set([
  WINTER_SLEET_AURA_SLUG,
  WINTER_SLEET_EFFECT_AURA_SLUG,
  'kinetic aura',
  'effect kinetic aura',
]);
const WINTER_SLEET_STANCE_SLUG_CANDIDATES = new Set([
  WINTER_SLEET_STANCE_SLUG,
  'winter-sleet',
  'winter sleet',
]);
const WINTER_SLEET_AURA_NAME_CANDIDATES = new Set(['kinetic aura']);
const WINTER_SLEET_STANCE_NAME_CANDIDATES = new Set(['winter sleet']);
const WINTER_SLEET_EVENT_TTL_MS = 5000;
const WINTER_SLEET_ITEM_REFRESH_DEBOUNCE_MS = 150;
const WINTER_SLEET_RELEVANT_SLUGS = new Set([
  WINTER_SLEET_AURA_SLUG,
  WINTER_SLEET_EFFECT_AURA_SLUG,
  WINTER_SLEET_STANCE_SLUG,
]);
const SETTING_DEBUG_ENABLED = 'debugEnabled';
const SETTING_LOG_LEVEL = 'logLevel';
const LOG_LEVELS = {
  OFF: 'off',
  INFO: 'info',
  DEBUG: 'debug',
  WINTER_SLEET: 'winter-sleet',
};
const SETTING_REQUIRE_VISIBLE_ENEMIES = 'requireVisibleEnemies';
const SETTING_PUBLIC_CHAT_MESSAGES = 'publicChatMessages';

const movementStarts = new Map();
const recentWinterSleetEvents = new Map();
let pendingWinterSleetRefresh = null;

function getWinterSleetEventKey({ type, tokenId, sourceId, round, turn }) {
  return `${type}:${tokenId}:${sourceId}:${round}:${turn}`;
}

function isDuplicateWinterSleetEvent(payload) {
  const key = getWinterSleetEventKey(payload);
  const now = Date.now();
  for (const [cachedKey, expiresAt] of recentWinterSleetEvents) {
    if (expiresAt <= now) recentWinterSleetEvents.delete(cachedKey);
  }
  const cached = recentWinterSleetEvents.get(key);
  if (cached && cached > now) return true;
  recentWinterSleetEvents.set(key, now + WINTER_SLEET_EVENT_TTL_MS);
  return false;
}

function gmIds() {
  return game.users.filter((u) => u.isGM).map((u) => u.id);
}

function shouldRequireVisibleEnemies() {
  if (!game.settings?.settings?.has(`${MODULE_ID}.${SETTING_REQUIRE_VISIBLE_ENEMIES}`)) return true;
  return game.settings.get(MODULE_ID, SETTING_REQUIRE_VISIBLE_ENEMIES);
}

function shouldWhisperToGm() {
  if (!game.settings?.settings?.has(`${MODULE_ID}.${SETTING_PUBLIC_CHAT_MESSAGES}`)) return true;
  return !game.settings.get(MODULE_ID, SETTING_PUBLIC_CHAT_MESSAGES);
}

function getLogLevel() {
  const key = `${MODULE_ID}.${SETTING_LOG_LEVEL}`;
  if (game.settings?.settings?.has(key)) {
    const configuredLogLevel = game.settings.get(MODULE_ID, SETTING_LOG_LEVEL);
    if (Object.values(LOG_LEVELS).includes(configuredLogLevel)) return configuredLogLevel;
  }

  if (!game.settings?.settings?.has(`${MODULE_ID}.${SETTING_DEBUG_ENABLED}`)) return LOG_LEVELS.OFF;
  return game.settings.get(MODULE_ID, SETTING_DEBUG_ENABLED) ? LOG_LEVELS.DEBUG : LOG_LEVELS.OFF;
}

function shouldLogWinterSleetDebug() {
  const logLevel = getLogLevel();
  return logLevel === LOG_LEVELS.DEBUG || logLevel === LOG_LEVELS.WINTER_SLEET;
}

function logWinterSleetDebug(...args) {
  if (!shouldLogWinterSleetDebug()) return;
  console.debug('[Aura Helper:Winter Sleet]', ...args);
}

function isTokenInsideAura(aura, tokenLike) {
  if (!aura || typeof aura.containsToken !== 'function' || !tokenLike) return false;
  const tokenOrDocument = tokenLike.document ?? tokenLike;
  if (!tokenOrDocument) return false;
  return !!aura.containsToken(tokenOrDocument);
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

function getKineticAura(actor) {
  return (
    actor?.auras?.get(WINTER_SLEET_EFFECT_AURA_SLUG) ??
    actor?.auras?.get(WINTER_SLEET_AURA_SLUG) ??
    null
  );
}

function normalizeWinterSleetIdentifier(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function matchesWinterSleetCandidates(item, slugCandidates, nameCandidates) {
  if (!item) return false;
  const normalizedSlug = normalizeWinterSleetIdentifier(item.slug);
  const normalizedName = normalizeWinterSleetIdentifier(item.name);
  return slugCandidates.has(normalizedSlug) || nameCandidates.has(normalizedName);
}

function isWinterSleetAuraItem(item) {
  return matchesWinterSleetCandidates(
    item,
    WINTER_SLEET_AURA_SLUG_CANDIDATES,
    WINTER_SLEET_AURA_NAME_CANDIDATES
  );
}

function isWinterSleetStanceItem(item) {
  return matchesWinterSleetCandidates(
    item,
    WINTER_SLEET_STANCE_SLUG_CANDIDATES,
    WINTER_SLEET_STANCE_NAME_CANDIDATES
  );
}

function collectWinterSleetSourceDebugEffects(actor) {
  return actor?.itemTypes?.effect?.map((effect) => ({
    slug: effect.slug ?? null,
    name: effect.name ?? null,
    normalizedSlug: normalizeWinterSleetIdentifier(effect.slug),
    normalizedName: normalizeWinterSleetIdentifier(effect.name),
  })) ?? [];
}

function hasWinterSleetStance(actor) {
  if (!actor) return false;
  return actor.items.some((item) => isWinterSleetStanceItem(item));
}

function hasKineticSleetAura() {
  return canvas.tokens.placeables.some((token) => {
    if (!token.actor) return false;
    const sourceEffects = collectWinterSleetSourceDebugEffects(token.actor);
    const hasAura = token.actor.itemTypes.effect.some((effect) => isWinterSleetAuraItem(effect));
    const hasStance = token.actor.itemTypes.effect.some((effect) => isWinterSleetStanceItem(effect));
    logWinterSleetDebug('hasKineticSleetAura source candidate', {
      sourceToken: token.id,
      hasAura,
      hasStance,
      sourceEffects,
    });
    return (
      hasAura &&
      hasStance
    );
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
  const visibility = canvas.effects?.visibility;
  if (!visibility) return false;
  return partyTokens.some((playerToken) =>
    visibility.testVisibility(enemyToken.center, { object: playerToken })
  );
}

function getWinterSleetSourcesForToken(token) {
  if (!token?.actor) return [];
  return canvas.tokens.placeables.filter((enemy) => {
    const isHidden = enemy.document?.hidden ?? false;
    const isDefeated = enemy.combatant?.isDefeated ?? enemy.combatant?.defeated ?? false;
    if (!enemy.actor || isHidden || isDefeated) return false;
    if (!enemy.actor.isEnemyOf(token.actor)) return false;
    if (shouldRequireVisibleEnemies() && !isVisibleToParty(enemy)) return false;
    const aura = getKineticAura(enemy.actor);
    const sourceEffects = collectWinterSleetSourceDebugEffects(enemy.actor);
    const hasAura = enemy.actor.itemTypes.effect.some((effect) => isWinterSleetAuraItem(effect));
    const hasStance = enemy.actor.itemTypes.effect.some((effect) => isWinterSleetStanceItem(effect));
    logWinterSleetDebug('Source candidate checked', {
      targetToken: token.id,
      sourceToken: enemy.id,
      auraFound: !!aura,
      hasAura,
      hasStance,
      sourceEffects,
    });
    return hasAura && hasStance && aura;
  });
}

async function refreshPlayerAuras() {
  if (!game.user.isGM) return;

  const tokens = canvas.tokens.placeables.filter(
    (t) => t.actor && (t.isVisible ?? !t.document.hidden)
  );

  const active = new Map();
  for (const token of canvas.tokens.placeables) {
    const reasons = [];
    if (!token.actor) reasons.push('missing-actor');

    const isVisible = token.isVisible ?? !token.document.hidden;
    if (!isVisible) reasons.push('hidden-or-not-visible');

    const aura = getKineticAura(token.actor);
    if (!aura) {
      reasons.push('missing-kinetic-aura');
    }

    const hasStance = hasWinterSleetStance(token.actor);
    if (!hasStance) {
      reasons.push('missing-winter-sleet-stance');
    }

    const sourceEffects = collectWinterSleetSourceDebugEffects(token.actor);
    const hasAuraSourceItem = token.actor.itemTypes.effect.some((effect) => isWinterSleetAuraItem(effect));
    const hasStanceSourceItem = token.actor.itemTypes.effect.some((effect) => isWinterSleetStanceItem(effect));
    if (!hasAuraSourceItem) reasons.push('missing-aura-effect-item');
    if (!hasStanceSourceItem) reasons.push('missing-stance-effect-item');

    if (reasons.length > 0) {
      logWinterSleetDebug('Skipping active source candidate', {
        sourceToken: token.id,
        reasons,
        hasAuraSourceItem,
        hasStanceSourceItem,
        auraSlug: aura?.slug ?? null,
        sourceEffects,
      });
      continue;
    }

    logWinterSleetDebug('Kinetic Aura erkannt + Winter Sleet Stance aktiv', {
      sourceToken: token.id,
      auraSlug: aura.slug,
      hasAuraSourceItem,
      hasStanceSourceItem,
      sourceEffects,
    });
    active.set(token.id, { token, aura });
  }

  for (const token of tokens) {
    const conditions =
      token.actor?.items.filter(
        (i) =>
          i.slug === 'off-guard' &&
          i.getFlag(AURA_FLAG, AURA_SOURCE_FLAG) !== undefined
      ) ?? [];

    for (const condition of conditions) {
      const sourceId = condition.getFlag(AURA_FLAG, AURA_SOURCE_FLAG);
      const source = active.get(sourceId);
      const inRange = source && isTokenInsideAura(source.aura, token);
      logWinterSleetDebug('Checking existing off-guard source range', {
        token: token.id,
        sourceId,
        inRange: !!inRange,
      });
      if (!inRange) await condition.delete();
    }
  }

  for (const [sourceId, data] of active) {
    for (const token of tokens) {
      if (!data.token.actor.isEnemyOf(token.actor)) continue;
      const inRange = isTokenInsideAura(data.aura, token);
      logWinterSleetDebug('Checking token against active source aura', {
        sourceId,
        token: token.id,
        inRange,
      });
      if (!inRange) continue;
      logWinterSleetDebug('Gegner in Winter-Sleet-Aura erkannt', {
        sourceId,
        sourceToken: data.token.id,
        enemyToken: token.id,
      });
      const existing =
        token.actor.items.find(
          (i) =>
            i.slug === 'off-guard' &&
            i.getFlag(AURA_FLAG, AURA_SOURCE_FLAG) === sourceId
        ) ?? null;
      if (existing) continue;
      const offGuard = game.pf2e.ConditionManager.getCondition('off-guard');
      if (!offGuard) continue;
      const condition = offGuard.toObject();
      condition.flags ??= {};
      condition.flags[AURA_FLAG] = { [AURA_SOURCE_FLAG]: sourceId };
      await token.actor.createEmbeddedDocuments('Item', [condition]);
      logWinterSleetDebug('Off-guard appliziert durch Winter Sleet', {
        sourceId,
        sourceToken: data.token.id,
        enemyToken: token.id,
      });
    }
  }
}

function emitWinterSleetRefresh() {
  game.socket.emit(`module.${MODULE_ID}`, {
    type: WINTER_SLEET_REFRESH_EVENT_TYPE,
  });
}

function scheduleWinterSleetRefresh() {
  if (!game.user.isGM) return;
  if (pendingWinterSleetRefresh) {
    clearTimeout(pendingWinterSleetRefresh);
  }
  pendingWinterSleetRefresh = setTimeout(async () => {
    pendingWinterSleetRefresh = null;
    await refreshPlayerAuras();
  }, WINTER_SLEET_ITEM_REFRESH_DEBOUNCE_MS);
}

function isRelevantWinterSleetItem(item) {
  return WINTER_SLEET_RELEVANT_SLUGS.has(item?.slug);
}

function emitWinterSleetBalance({ tokenId, sourceId }) {
  game.socket.emit(`module.${MODULE_ID}`, {
    type: WINTER_SLEET_BALANCE_EVENT_TYPE,
    tokenId,
    sourceId,
    round: game.combat?.round ?? 0,
    turn: game.combat?.turn ?? 0,
  });
}

async function createBalanceChatMessage({ token, source }) {
  if (!token?.actor || !source?.actor) return;
  const stance = source.actor.items.find((i) => i.slug === WINTER_SLEET_STANCE_SLUG) ?? null;
  const sourceName = stance?.name ?? 'Winter Sleet';
  const sourceLink = stance?.uuid ? `@UUID[${stance.uuid}]{${sourceName}}` : sourceName;
  const content = `${token.name} bewegt sich in der Aura ${sourceLink} von ${source.name} und muss einen Balance-Check ablegen.`;

  const speaker = ChatMessage.getSpeaker({ token: token.document, actor: token.actor });
  await ChatMessage.create({ content, speaker, whisper: shouldWhisperToGm() ? gmIds() : undefined });
}

Hooks.once('ready', () => {
  game.socket.on(`module.${MODULE_ID}`, async (payload) => {
    if (!game.user.isGM || !payload) return;

    if (payload.type === WINTER_SLEET_REFRESH_EVENT_TYPE) {
      await refreshPlayerAuras();
      return;
    }

    if (payload.type !== WINTER_SLEET_BALANCE_EVENT_TYPE) return;
    if (isDuplicateWinterSleetEvent(payload)) return;

    const token = canvas.tokens.get(payload.tokenId);
    const source = canvas.tokens.get(payload.sourceId);
    if (!token || !source) return;
    await createBalanceChatMessage({ token, source });
  });
});

Hooks.on('pf2e.startTurn', async () => {
  if (!hasKineticSleetAura()) return;
  if (game.user.isGM) {
    await refreshPlayerAuras();
    return;
  }
  emitWinterSleetRefresh();
});

Hooks.on('updateToken', async (tokenDoc, change) => {
  if (change.x === undefined && change.y === undefined) return;

  const token = tokenDoc.object;
  if (!token) return;

  if (game.user.isGM) {
    scheduleWinterSleetRefresh();
    return;
  }

  if (!hasKineticSleetAura()) return;

  if (!isResponsibleOwnerClient(token)) return;
  const partyMembers = game.actors.party?.members ?? [];
  const isPartyMember = partyMembers.some((member) => member.id === token.actor?.id);

  const sources = getWinterSleetSourcesForToken(token);

  if (token._movement) {
    if (!movementStarts.has(token.id)) {
      const startMap = new Map();
      const movementStartDocument = getDocumentAtMovementStart(token) ?? token.document;
      for (const source of sources) {
        const aura = source.actor.auras?.get(WINTER_SLEET_AURA_SLUG);
        const kineticAura = aura ?? getKineticAura(source.actor);
        if (!kineticAura) continue;
        startMap.set(source.id, isTokenInsideAura(kineticAura, movementStartDocument));
      }
      movementStarts.set(token.id, startMap);
    }
    emitWinterSleetRefresh();
    return;
  }

  const startMap = movementStarts.get(token.id) ?? new Map();
  movementStarts.delete(token.id);

  for (const source of sources) {
    if (!isPartyMember) continue;
    const aura = source.actor.auras?.get(WINTER_SLEET_AURA_SLUG);
    const kineticAura = aura ?? getKineticAura(source.actor);
    if (!kineticAura) continue;
    const startedInside = startMap.get(source.id) ?? false;
    const endedInside = isTokenInsideAura(kineticAura, token);

    if (startedInside || endedInside) {
      emitWinterSleetBalance({ tokenId: token.id, sourceId: source.id });
    }
  }

  emitWinterSleetRefresh();
});

Hooks.on('createItem', (item) => {
  if (!game.user.isGM || !isRelevantWinterSleetItem(item)) return;
  scheduleWinterSleetRefresh();
});

Hooks.on('deleteItem', (item) => {
  if (!game.user.isGM || !isRelevantWinterSleetItem(item)) return;
  scheduleWinterSleetRefresh();
});

Hooks.on('updateItem', (item, changed) => {
  if (!game.user.isGM) return;
  const changedSlug = changed?.slug;
  if (!isRelevantWinterSleetItem(item) && !WINTER_SLEET_RELEVANT_SLUGS.has(changedSlug)) {
    return;
  }
  scheduleWinterSleetRefresh();
});

Hooks.on('deleteToken', (tokenDoc) => {
  movementStarts.delete(tokenDoc.id);
});

Hooks.on('canvasReady', () => {
  movementStarts.clear();
  if (!game.user.isGM) return;
  refreshPlayerAuras();
});
