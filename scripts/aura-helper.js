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
