Hooks.on('pf2e.startTurn', async (combatant) => {
  const token = combatant.token?.object ?? combatant.token;
  const partyMembers = game.actors.party?.members ?? [];
  if (!partyMembers.some((member) => member === token.actor)) return;

  const enemies = canvas.tokens.placeables.filter(
    (t) => t.actor && t.actor.isEnemyOf(combatant.actor)
  );

  for (const enemy of enemies) {
    const auras = enemy.actor?.auras ? [...enemy.actor.auras.values()] : [];
    for (const aura of auras) {
      const distance = canvas.grid.measureDistance(token, enemy);
      if (distance > aura.radius) continue;
      const originUuid = aura.origin?.uuid ?? aura.uuid ?? '';
      const link = originUuid ? ` @UUID[${originUuid}]` : '';
      const content = `${token.name} beginnt seinen Zug innerhalb der Aura ${aura.name} von ${enemy.name}.${link}`;
      const speaker = ChatMessage.getSpeaker({ token: token.document });
      await ChatMessage.create({ content, speaker });
    }
  }
});
