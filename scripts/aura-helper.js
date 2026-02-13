const movementStarts = new Map();
const currentAuraOccupancy = new Map();
const recentAuraEvents = new Map();

const MODULE_ID = 'pf2e-aura-helper';
const AURA_FLAG = 'pf2e-aura-helper';
const AURA_SOURCE_FLAG = 'kinetic-source';
const AURA_EVENT_TYPE = 'AURA_EVENT';
const WINTER_SLEET_REFRESH_EVENT_TYPE = 'WINTER_SLEET_REFRESH';
const AURA_EVENT_KINDS = {
  START_TURN: 'START_TURN',
  ENTER: 'ENTER',
};
const AURA_EVENT_TTL_MS = 5000;

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

    if (payload.type === WINTER_SLEET_REFRESH_EVENT_TYPE) {
      await refreshPlayerAuras();
      return;
    }

    if (payload.type !== AURA_EVENT_TYPE) return;
    if (
      payload.eventKind !== AURA_EVENT_KINDS.START_TURN &&
      payload.eventKind !== AURA_EVENT_KINDS.ENTER
    ) {
      return;
    }
    if (isDuplicateAuraEvent(payload)) return;

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

function hasKineticSleetAura() {
  return canvas.tokens.placeables.some(
    (t) =>
      t.actor &&
      t.actor.itemTypes.effect.some((e) => e.slug === 'effect-kinetic-aura') &&
      t.actor.itemTypes.effect.some((e) => e.slug === 'stance-winter-sleet')
  );
}

function gmIds() {
  return game.users.filter((u) => u.isGM).map((u) => u.id);
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
      (e) => e.slug === 'effect-kinetic-aura'
    );
    const hasSleet = player.actor.itemTypes.effect.some(
      (e) => e.slug === 'stance-winter-sleet'
    );
    if (hasAura && hasSleet) {
      const aura = player.actor.auras?.get('kinetic-aura');
      if (aura)
        active.set(player.id, {
          token: player,
          slug: 'kinetic-aura',
          radius: aura.radius,
        });
    }
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
      const inRange =
        source &&
        canvas.grid.measureDistance(source.token, token) <= source.radius;
      if (!inRange) {
        await condition.delete();
      }
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

async function handleAura({ token, enemy, aura, message, whisperToGm = false }) {
  const effect = aura.effects?.[0];
  console.debug('[Aura Helper] aura effect', effect);
  let originUuid =
    effect?.origin ??
    effect?.sourceId ??
    effect?.system?.context?.origin?.uuid ??
    null;
  let originItem = null;
  if (!originUuid) {
    originItem = enemy.actor.items.find((i) => i.slug === aura.slug) ?? null;
    console.debug('[Aura Helper] searched enemy items by slug', {
      slug: aura.slug,
      item: originItem,
    });
    if (!originItem) {
      const searchName = effect?.name ?? aura.slug.replace(/-/g, ' ');
      originItem = enemy.actor.items.find(
        (i) => i.name.toLowerCase() === searchName.toLowerCase()
      );
      console.debug('[Aura Helper] searched enemy items by name', {
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
  console.debug('[Aura Helper] resolved originUuid', originUuid);
  const origin = originItem ?? (originUuid ? await fromUuid(originUuid) : null);
  const auraName = origin?.name ?? aura.slug;
  const auraLink = originUuid ? `@UUID[${originUuid}]{${auraName}}` : auraName;
  const content = message(auraLink);
  console.debug('[Aura Helper] creating chat message', content);
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
  console.debug('[Aura Helper] pf2e.startTurn', { combatant });
  const token = combatant.token?.object ?? combatant.token;
  if (!isResponsibleOwnerClient(token)) return;
  const partyMembers = game.actors.party?.members ?? [];
  const isPartyMember = partyMembers.some(
    (member) => member.id === token.actor.id
  );

  if (isPartyMember) {
    const enemies = canvas.tokens.placeables.filter((t) => {
      const isHidden = t.document?.hidden ?? false;
      const isDefeated =
        t.combatant?.isDefeated ?? t.combatant?.defeated ?? false;
      return (
        !!t.actor &&
        t.actor.isEnemyOf(combatant.actor) &&
        !isHidden &&
        !isDefeated &&
        isVisibleToParty(t)
      );
    });
    console.debug('[Aura Helper] enemies in scene', enemies.map((e) => e.name));

    for (const enemy of enemies) {
      const auras = enemy.actor?.auras ? [...enemy.actor.auras.values()] : [];
      console.debug('[Aura Helper] checking enemy auras', {
        enemy: enemy.name,
        auras: auras.map((a) => a.slug),
      });
      for (const aura of auras) {
        const distance = canvas.grid.measureDistance(token, enemy);
        console.debug('[Aura Helper] evaluating aura', {
          aura: aura.slug,
          distance,
          radius: aura.radius,
        });
        if (distance > aura.radius) continue;
        game.socket.emit(`module.${MODULE_ID}`, {
          type: AURA_EVENT_TYPE,
          eventKind: AURA_EVENT_KINDS.START_TURN,
          tokenId: token.id,
          enemyId: enemy.id,
          auraSlug: aura.slug,
          round: game.combat?.round ?? 0,
          turn: game.combat?.turn ?? 0,
        });
      }
    }
  }

  if (hasKineticSleetAura()) emitWinterSleetRefresh();
});

Hooks.on('updateToken', async (tokenDoc, change, _options, _userId) => {
  if (game.user.isGM) return;
  if (change.x === undefined && change.y === undefined) return;
  const token = tokenDoc.object;
  if (!token) return;
  if (!isResponsibleOwnerClient(token)) return;
  const partyMembers = game.actors.party?.members ?? [];
  const isPartyMember = partyMembers.some(
    (member) => member.id === token.actor?.id
  );

  if (isPartyMember) {
    const potentialEnemies = canvas.tokens.placeables.filter((t) => {
      const isHidden = t.document?.hidden ?? false;
      const isDefeated =
        t.combatant?.isDefeated ?? t.combatant?.defeated ?? false;
      return (
        !!t.actor &&
        t.actor.isEnemyOf(token.actor) &&
        !isHidden &&
        !isDefeated
      );
    });

    const visibleEnemies = [];
    const invisibleEnemies = [];
    for (const enemy of potentialEnemies) {
      if (isVisibleToParty(enemy)) {
        visibleEnemies.push(enemy);
      } else {
        invisibleEnemies.push(enemy);
      }
    }

    let occupancyMap = currentAuraOccupancy.get(token.id) ?? new Map();
    if (invisibleEnemies.length > 0) {
      const startMap = movementStarts.get(token.id);
      for (const enemy of invisibleEnemies) {
        const auras = enemy.actor?.auras ? [...enemy.actor.auras.values()] : [];
        for (const aura of auras) {
          const key = `${enemy.id}-${aura.slug}`;
          occupancyMap.delete(key);
          startMap?.delete(key);
        }
      }
      if (startMap && startMap.size === 0) {
        movementStarts.delete(token.id);
      }
      if (occupancyMap.size === 0) {
        currentAuraOccupancy.delete(token.id);
      } else {
        currentAuraOccupancy.set(token.id, occupancyMap);
      }
    }

    const enemies = visibleEnemies;

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
        for (const enemy of enemies) {
          const auras = enemy.actor?.auras ? [...enemy.actor.auras.values()] : [];
          for (const aura of auras) {
            const key = `${enemy.id}-${aura.slug}`;
            const distance = canvas.grid.measureDistance(startPoint, enemy.center);
            const isInside = distance <= aura.radius;
            startMap.set(key, isInside);
            if (isInside) {
              occupancyMap.set(key, true);
            } else {
              occupancyMap.delete(key);
            }
            processedKeys.add(key);
          }
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
      if (hasKineticSleetAura()) emitWinterSleetRefresh();
      return;
    }

    const startMap = movementStarts.get(token.id) ?? new Map();
    movementStarts.delete(token.id);
    occupancyMap = currentAuraOccupancy.get(token.id) ?? new Map();
    const processedKeys = new Set();
    for (const enemy of enemies) {
      const auras = enemy.actor?.auras ? [...enemy.actor.auras.values()] : [];
      for (const aura of auras) {
        const key = `${enemy.id}-${aura.slug}`;
        processedKeys.add(key);
        const previousInside =
          (startMap.has(key) ? startMap.get(key) : occupancyMap.get(key)) ?? false;
        const newDistance = canvas.grid.measureDistance(token.center, enemy.center);
        const isInside = newDistance <= aura.radius;
        if (isInside) {
          if (!previousInside) {
            game.socket.emit(`module.${MODULE_ID}`, {
              type: AURA_EVENT_TYPE,
              eventKind: AURA_EVENT_KINDS.ENTER,
              tokenId: token.id,
              enemyId: enemy.id,
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
  }

  if (hasKineticSleetAura()) emitWinterSleetRefresh();
});

Hooks.on('deleteToken', (tokenDoc) => {
  movementStarts.delete(tokenDoc.id);
  currentAuraOccupancy.delete(tokenDoc.id);
});

Hooks.on('canvasReady', () => {
  movementStarts.clear();
  currentAuraOccupancy.clear();
});
