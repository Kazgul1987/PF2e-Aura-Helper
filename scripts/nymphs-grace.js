import { MODULE_ID } from './constants.js';
import { EventDeduplicator } from './utils/deduplicator.js';
import { isResponsibleGM } from './utils/gm.js';
const NGP_FLAG_KEY = 'nymphs-grace-aura';
const NGP_AURA_SLUG = 'nymphs-grace';
const NGP_AURA_ITEM_NAME = "Nymph's Grace (Aura)";
const NGP_NAME_RE = /nymph['’]s\s+grace/i;

const processedChatMessages = new EventDeduplicator();

function hasNymphsGraceSourceEffect(actor) {
  if (!actor) return false;
  return actor.itemTypes.effect.some((effect) => {
    const slug = effect.slug ?? effect.system?.slug ?? '';
    const sourceSlug = effect.flags?.pf2e?.sourceId?.split('.').at(-1) ?? '';
    const isNymphsGrace = slug === NGP_AURA_SLUG || sourceSlug === NGP_AURA_SLUG || NGP_NAME_RE.test(effect.name ?? '');
    return isNymphsGrace && effect.getFlag(MODULE_ID, NGP_FLAG_KEY) !== true;
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

export async function ensureNymphsGraceAura(actor) {
  if (!isResponsibleGM() || !actor) return;

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
    return origin?.type === 'spell' && ((origin.slug ?? origin.system?.slug) === NGP_AURA_SLUG || NGP_NAME_RE.test(origin.name ?? ''));
  }

  const text = (msg.content ?? '').replace(/<[^>]+>/g, ' ');
  return NGP_NAME_RE.test(text);
}

export async function handleNymphsGraceChatMessage(msg) {
  if (!isResponsibleGM() || !msg) return;
  if (processedChatMessages.checkAndAdd(msg.id, 10_000)) return;

  const actor = msg.speakerActor ?? ChatMessage.getSpeakerActor(msg.speaker);
  if (actor && await isNymphsGraceCastMessage(msg)) await ensureNymphsGraceAura(actor);
}

export async function refreshNymphsGraceAuras() {
  if (!isResponsibleGM() || !canvas?.ready) return;
  const actors = new Set(canvas.tokens.placeables.map((token) => token.actor).filter(Boolean));
  await Promise.all([...actors].map(ensureNymphsGraceAura));
}
