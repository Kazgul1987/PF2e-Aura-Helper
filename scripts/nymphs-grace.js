const MODULE_ID = 'pf2e-aura-helper';
const NGP_FLAG_KEY = 'nymphs-grace-aura';
const NGP_AURA_SLUG = 'nymphs-grace';
const NGP_AURA_ITEM_NAME = "Nymph's Grace (Aura)";
const NGP_NAME_RE = /nymph['’]s\s+grace/i;

const processedChatMessages = new Set();

function hasNymphsGraceSourceEffect(actor) {
  if (!actor) return false;
  return actor.itemTypes.effect.some((effect) => {
    const name = effect.name?.toLowerCase() ?? '';
    return (
      name.includes('nymph') &&
      name.includes('grace') &&
      effect.getFlag(MODULE_ID, NGP_FLAG_KEY) !== true
    );
  });
}

function getExistingNymphsGraceAuraItem(actor) {
  return (
    actor?.items.find(
      (item) =>
        item.type === 'effect' && item.getFlag(MODULE_ID, NGP_FLAG_KEY) === true
    ) ?? null
  );
}

async function ensureNymphsGraceAura(actor) {
  if (!game.user.isGM || !actor) return;

  const hasSource = hasNymphsGraceSourceEffect(actor);
  const existingAuraItem = getExistingNymphsGraceAuraItem(actor);

  if (hasSource && !existingAuraItem) {
    const auraEffect = {
      name: NGP_AURA_ITEM_NAME,
      type: 'effect',
      img: 'icons/magic/nature/leaf-glow-green.webp',
      system: {
        slug: NGP_AURA_SLUG,
        level: { value: 1 },
        duration: {
          value: -1,
          unit: 'unlimited',
          sustained: false,
          expiry: null,
        },
        rules: [
          {
            key: 'Aura',
            radius: 10,
            slug: NGP_AURA_SLUG,
            traits: ['emotion', 'mental', 'visual'],
            effects: [],
          },
        ],
      },
      flags: {
        [MODULE_ID]: {
          [NGP_FLAG_KEY]: true,
        },
      },
    };

    await actor.createEmbeddedDocuments('Item', [auraEffect]);
    return;
  }

  if (!hasSource && existingAuraItem) {
    await existingAuraItem.delete();
  }
}

async function isNymphsGraceCastMessage(msg) {
  const originUuid =
    msg.getFlag?.('pf2e', 'origin')?.uuid ?? msg.flags?.pf2e?.origin?.uuid ?? null;

  if (originUuid) {
    const origin = await fromUuid(originUuid);
    return origin?.type === 'spell' && NGP_NAME_RE.test(origin.name ?? '');
  }

  const text = (msg.content ?? '').replace(/<[^>]+>/g, ' ');
  return NGP_NAME_RE.test(text);
}

Hooks.on('createItem', (item) => ensureNymphsGraceAura(item.actor));
Hooks.on('deleteItem', (item) => ensureNymphsGraceAura(item.actor));
Hooks.on('updateItem', (item, change) => {
  if (change?.name !== undefined || change?.system?.slug !== undefined) {
    ensureNymphsGraceAura(item.actor);
  }
});

Hooks.on('createChatMessage', async (msg) => {
  if (!game.user.isGM || !msg) return;
  if (processedChatMessages.has(msg.id)) return;
  processedChatMessages.add(msg.id);

  const actor = msg.speakerActor ?? ChatMessage.getSpeakerActor(msg.speaker);
  if (!actor) return;

  if (await isNymphsGraceCastMessage(msg)) {
    await ensureNymphsGraceAura(actor);
  }
});

Hooks.on('canvasReady', () => {
  if (!game.user.isGM) return;

  const actors = new Set(
    canvas.tokens.placeables.map((token) => token.actor).filter(Boolean)
  );

  for (const actor of actors) {
    ensureNymphsGraceAura(actor);
  }
});
