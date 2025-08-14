Hooks.on('pf2e.startTurn', async (combatant) => {
  console.debug('[Aura Helper] pf2e.startTurn', { combatant });
  const token = combatant.token?.object ?? combatant.token;
  const partyMembers = game.actors.party?.members ?? [];
  if (!partyMembers.some((member) => member.id === token.actor.id)) return;

  const enemies = canvas.tokens.placeables.filter(
    (t) => t.actor && t.actor.isEnemyOf(combatant.actor)
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
      const effect = aura.effects?.[0];
      console.debug('[Aura Helper] aura effect', effect);
      let originUuid =
        effect?.origin ??
        effect?.sourceId ??
        effect?.system?.context?.origin?.uuid ??
        null;
      if (!originUuid) {
        const item = enemy.actor.items.find((i) => i.slug === aura.slug);
        console.debug('[Aura Helper] searched enemy items', {
          slug: aura.slug,
          item,
        });
        originUuid = item?.uuid ?? null;
      }
      console.debug('[Aura Helper] resolved originUuid', originUuid);
        originUuid =
          enemy.actor.items.find((i) => i.slug === aura.slug)?.uuid ?? null;
      }
      const origin = originUuid ? await fromUuid(originUuid) : null;
      const auraName = origin?.name ?? aura.slug;
      const auraLink = originUuid ? `@UUID[${originUuid}]{${auraName}}` : auraName;
      const content = `${token.name} beginnt seinen Zug innerhalb der Aura ${auraLink} von ${enemy.name}.`;
      console.debug('[Aura Helper] creating chat message', content);
      const speaker = ChatMessage.getSpeaker({ token: token.document });
      await ChatMessage.create({ content, speaker });
      if (origin) {
        await origin.toMessage({}, { speaker });
      }
    }
  }
});
