const movementStarts = new Map();

async function handleAura({ token, enemy, aura, message }) {
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
    if (originItem) {
      await originItem.toMessage(undefined, { create: true });
    } else {
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
  await ChatMessage.create({ content, speaker });
  if (!originItem && origin) {
    await origin.toMessage(undefined, {
      create: true,
      data: { speaker },
    });
  } else if (!origin) {
    console.warn('[Aura Helper] no item to post for aura', {
      aura: aura.slug,
      enemy: enemy.name,
    });
  }
}

Hooks.on('pf2e.startTurn', async (combatant) => {
  console.debug('[Aura Helper] pf2e.startTurn', { combatant });
  const token = combatant.token?.object ?? combatant.token;
  const partyMembers = game.actors.party?.members ?? [];
  if (!partyMembers.some((member) => member.id === token.actor.id)) return;

  const enemies = canvas.tokens.placeables.filter(
    (t) =>
      t.actor &&
      t.actor.isEnemyOf(combatant.actor) &&
      (t.isVisible ?? !t.document.hidden)
  );
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
      await handleAura({
        token,
        enemy,
        aura,
        message: (auraLink) =>
          `${token.name} beginnt seinen Zug innerhalb der Aura ${auraLink} von ${enemy.name}.`,
      });
    }
  }
});

Hooks.on('updateToken', async (tokenDoc, change, _options, userId) => {
  if (change.x === undefined && change.y === undefined) return;
  const token = tokenDoc.object;
  if (!token) return;
  const partyMembers = game.actors.party?.members ?? [];
  if (!partyMembers.some((member) => member.id === token.actor?.id)) return;

  const enemies = canvas.tokens.placeables.filter(
    (t) =>
      t.actor &&
      t.actor.isEnemyOf(token.actor) &&
      (t.isVisible ?? !t.document.hidden)
  );

  if (token._movement) {
    if (!movementStarts.has(token.id)) {
      const startPoint =
        token._movement?.rays?.[0]?.A ??
        token._movement?.ray?.A ?? {
          x: token.center.x,
          y: token.center.y,
        };
      const startMap = new Map();
      for (const enemy of enemies) {
        const auras = enemy.actor?.auras ? [...enemy.actor.auras.values()] : [];
        for (const aura of auras) {
          const distance = canvas.grid.measureDistance(startPoint, enemy.center);
          startMap.set(`${enemy.id}-${aura.slug}`, distance <= aura.radius);
        }
      }
      movementStarts.set(token.id, startMap);
    }
    return;
  }

  const startMap = movementStarts.get(token.id) ?? new Map();
  movementStarts.delete(token.id);
  for (const enemy of enemies) {
    const auras = enemy.actor?.auras ? [...enemy.actor.auras.values()] : [];
    for (const aura of auras) {
      const key = `${enemy.id}-${aura.slug}`;
      const wasInside = startMap.get(key) ?? false;
      const newDistance = canvas.grid.measureDistance(token.center, enemy.center);
      if (newDistance > aura.radius || wasInside) continue;
      await handleAura({
        token,
        enemy,
        aura,
        message: (auraLink) =>
          `${token.name} betritt die Aura ${auraLink} von ${enemy.name}.`,
      });
    }
  }
});
