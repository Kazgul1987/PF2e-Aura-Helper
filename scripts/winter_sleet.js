const MODULE_ID = 'pf2e-aura-helper';
const AURA_FLAG = 'pf2e-aura-helper';
const AURA_SOURCE_FLAG = 'kinetic-source';
const WINTER_SLEET_REFRESH_EVENT_TYPE = 'WINTER_SLEET_REFRESH';
const WINTER_SLEET_BALANCE_EVENT_TYPE = 'WINTER_SLEET_BALANCE';
const WINTER_SLEET_AURA_SLUG = 'kinetic-aura';
const WINTER_SLEET_EFFECT_AURA_SLUG = 'effect-kinetic-aura';
const WINTER_SLEET_STANCE_SLUG = 'stance-winter-sleet';
const WINTER_SLEET_EVENT_TTL_MS = 5000;
const WINTER_SLEET_ITEM_REFRESH_DEBOUNCE_MS = 150;
const WINTER_SLEET_RELEVANT_SLUGS = new Set([
  WINTER_SLEET_EFFECT_AURA_SLUG,
  WINTER_SLEET_STANCE_SLUG,
]);

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

function hasKineticSleetAura() {
  return canvas.tokens.placeables.some((token) => {
    if (!token.actor) return false;
    return (
      token.actor.itemTypes.effect.some(
        (e) =>
          e.slug === WINTER_SLEET_EFFECT_AURA_SLUG ||
          e.slug === WINTER_SLEET_AURA_SLUG
      ) &&
      token.actor.itemTypes.effect.some((e) => e.slug === WINTER_SLEET_STANCE_SLUG)
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
    if (!isVisibleToParty(enemy)) return false;
    return (
      enemy.actor.itemTypes.effect.some(
        (e) =>
          e.slug === WINTER_SLEET_EFFECT_AURA_SLUG ||
          e.slug === WINTER_SLEET_AURA_SLUG
      ) &&
      enemy.actor.itemTypes.effect.some((e) => e.slug === WINTER_SLEET_STANCE_SLUG) &&
      getKineticAura(enemy.actor)
    );
  });
}

async function refreshPlayerAuras() {
  if (!game.user.isGM) return;

  const tokens = canvas.tokens.placeables.filter(
    (t) => t.actor && (t.isVisible ?? !t.document.hidden)
  );
  const partyMembers = game.actors.party?.members ?? [];
  const players = tokens.filter((t) =>
    partyMembers.some((member) => member.id === t.actor.id)
  );

  const active = new Map();
  for (const player of players) {
    const hasAura = player.actor.itemTypes.effect.some(
      (e) =>
        e.slug === WINTER_SLEET_EFFECT_AURA_SLUG ||
        e.slug === WINTER_SLEET_AURA_SLUG
    );
    const hasSleet = player.actor.itemTypes.effect.some((e) => e.slug === WINTER_SLEET_STANCE_SLUG);
    if (!hasAura || !hasSleet) continue;
    const aura = getKineticAura(player.actor);
    if (!aura) continue;
    active.set(player.id, { token: player, radius: aura.radius });
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
      const inRange = source && canvas.grid.measureDistance(source.token, token) <= source.radius;
      if (!inRange) await condition.delete();
    }
  }

  for (const [sourceId, data] of active) {
    for (const token of tokens) {
      if (!data.token.actor.isEnemyOf(token.actor)) continue;
      const distance = canvas.grid.measureDistance(data.token, token);
      if (distance > data.radius) continue;
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
  await ChatMessage.create({ content, speaker, whisper: gmIds() });
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
  if (game.user.isGM) return;
  if (!hasKineticSleetAura()) return;
  emitWinterSleetRefresh();
});

Hooks.on('updateToken', async (tokenDoc, change) => {
  if (game.user.isGM) return;
  if (change.x === undefined && change.y === undefined) return;
  if (!hasKineticSleetAura()) return;

  const token = tokenDoc.object;
  if (!token || !isResponsibleOwnerClient(token)) return;
  const partyMembers = game.actors.party?.members ?? [];
  const isPartyMember = partyMembers.some((member) => member.id === token.actor?.id);
  if (!isPartyMember) return;

  const sources = getWinterSleetSourcesForToken(token);

  if (token._movement) {
    if (!movementStarts.has(token.id)) {
      const startPoint = token._movement?.rays?.[0]?.A ?? token._movement?.ray?.A ?? token.center;
      const startMap = new Map();
      for (const source of sources) {
        const aura = source.actor.auras?.get(WINTER_SLEET_AURA_SLUG);
        const kineticAura = aura ?? getKineticAura(source.actor);
        if (!kineticAura) continue;
        const distance = canvas.grid.measureDistance(startPoint, source.center);
        startMap.set(source.id, distance <= kineticAura.radius);
      }
      movementStarts.set(token.id, startMap);
    }
    emitWinterSleetRefresh();
    return;
  }

  const startMap = movementStarts.get(token.id) ?? new Map();
  movementStarts.delete(token.id);

  for (const source of sources) {
    const aura = source.actor.auras?.get(WINTER_SLEET_AURA_SLUG);
    const kineticAura = aura ?? getKineticAura(source.actor);
    if (!kineticAura) continue;
    const startedInside = startMap.get(source.id) ?? false;
    const distance = canvas.grid.measureDistance(token.center, source.center);
    const endedInside = distance <= kineticAura.radius;

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
