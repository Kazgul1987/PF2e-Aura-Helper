import { getAuraDistanceMode, getAuraRangeCheck } from './aura-distance.js';
import { MODULE_ID } from './constants.js';
import { AuraEventType, SocketMessageType } from './constants.js';
import { EventDeduplicator } from './utils/deduplicator.js';
import { getGMIds, isResponsibleGM } from './utils/gm.js';
import { debugWinterSleet as logWinterSleetDebug } from './utils/logging.js';

const AURA_FLAG = 'pf2e-aura-helper';
const AURA_SOURCE_FLAG = 'kinetic-source';
const WINTER_SLEET_AURA_SLUG = 'kinetic-aura';
const WINTER_SLEET_EFFECT_AURA_SLUG = 'effect-kinetic-aura';
const WINTER_SLEET_STANCE_SLUG = 'stance-winter-sleet';
const WINTER_SLEET_AURA_SLUG_CANDIDATES = new Set([
  WINTER_SLEET_AURA_SLUG,
  WINTER_SLEET_EFFECT_AURA_SLUG,
  'kinetic aura',
  'effect kinetic aura',
]);
const WINTER_SLEET_AURA_NAME_CANDIDATES = new Set(['kinetic aura']);
const WINTER_SLEET_STANCE_EFFECT_SOURCE_IDS = new Set([
  'Compendium.pf2e.feat-effects.Item.lge4vtZdfZOCWAch',
]);
const WINTER_SLEET_EVENT_TTL_MS = 5000;
const SETTING_REQUIRE_VISIBLE_ENEMIES = 'requireVisibleEnemies';
const SETTING_PUBLIC_CHAT_MESSAGES = 'publicChatMessages';

const movementStartOccupancy = new Map();
const currentOccupancy = new Map();
const winterSleetEvents = new EventDeduplicator();

function getWinterSleetEventKey({ eventKind, tokenId, enemyId, combatId, round, turn, eventSequence }) {
  return ['winter-sleet', eventKind, combatId ?? 'no-combat', tokenId, enemyId, round, turn, eventSequence ?? 'none'].join(':');
}

function gmIds() {
  return getGMIds();
}

function shouldRequireVisibleEnemies() {
  if (!game.settings?.settings?.has(`${MODULE_ID}.${SETTING_REQUIRE_VISIBLE_ENEMIES}`)) return true;
  return game.settings.get(MODULE_ID, SETTING_REQUIRE_VISIBLE_ENEMIES);
}

function shouldWhisperToGm() {
  if (!game.settings?.settings?.has(`${MODULE_ID}.${SETTING_PUBLIC_CHAT_MESSAGES}`)) return true;
  return !game.settings.get(MODULE_ID, SETTING_PUBLIC_CHAT_MESSAGES);
}

function isTokenInsideAura(aura, source, tokenLike) {
  return getAuraRangeCheck(aura, source, tokenLike, { mode: getAuraDistanceMode() }).inRange;
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

function collectWinterSleetSourceDebugEffects(actor) {
  return actor?.itemTypes?.effect?.map((effect) => ({
    slug: effect.slug ?? null,
    name: effect.name ?? null,
    normalizedSlug: normalizeWinterSleetIdentifier(effect.slug),
    normalizedName: normalizeWinterSleetIdentifier(effect.name),
  })) ?? [];
}

function hasWinterSleetStance(actor) {
  return hasActiveWinterSleetStanceEffect(actor);
}

function hasActiveWinterSleetStanceEffect(actor) {
  if (!actor) return false;
  return actor.itemTypes.effect.some((effect) =>
    WINTER_SLEET_STANCE_EFFECT_SOURCE_IDS.has(effect.sourceId)
  );
}

function hasActiveKineticAuraEffect(actor) {
  if (!actor) return false;
  return actor.itemTypes.effect.some((effect) => isWinterSleetAuraItem(effect));
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

export function getWinterSleetSourcesForToken(token) {
  if (!token?.actor) return [];
  return canvas.tokens.placeables.filter((enemy) => {
    const isHidden = enemy.document?.hidden ?? false;
    const isDefeated = enemy.combatant?.isDefeated ?? enemy.combatant?.defeated ?? false;
    if (!enemy.actor || isHidden || isDefeated) return false;
    if (!enemy.actor.isEnemyOf(token.actor)) return false;
    if (shouldRequireVisibleEnemies() && !isVisibleToParty(enemy)) return false;
    const aura = getKineticAura(enemy.actor);
    const sourceEffects = collectWinterSleetSourceDebugEffects(enemy.actor);
    const hasAura = hasActiveKineticAuraEffect(enemy.actor);
    const hasStanceFeat = hasWinterSleetStance(enemy.actor);
    const hasActiveStance = hasActiveWinterSleetStanceEffect(enemy.actor);
    logWinterSleetDebug('Source candidate checked', {
      targetToken: token.id,
      sourceToken: enemy.id,
      auraFound: !!aura,
      hasAura,
      hasStanceFeat,
      hasActiveStance,
      sourceEffects,
    });
    return hasAura && hasActiveStance && !!aura;
  });
}

export function getWinterSleetSuppressionEntries(target) {
  return getWinterSleetSourcesForToken(target).map((source) => ({
    source,
    auraIdentifier: WINTER_SLEET_AURA_SLUG,
    auraName: 'Winter Sleet',
  }));
}

/**
 * Handles the Winter Sleet rule for a generic completed token movement.
 * The Foundry hook remains registered by aura-helper; all feature decisions live here.
 */
export function handleAuraMovement({ targetToken, movementSequence, emitAuraEvent }) {
  if (!targetToken?.actor) return;
  const sources = getWinterSleetSourcesForToken(targetToken);

  if (targetToken._movement) {
    const starts = new Map();
    const movementStartDocument = getDocumentAtMovementStart(targetToken) ?? targetToken.document;
    const occupancy = currentOccupancy.get(targetToken.id) ?? new Map();
    for (const source of sources) {
      const aura = getKineticAura(source.actor);
      if (!aura) continue;
      const key = source.id;
      const startedInside = isTokenInsideAura(aura, source, movementStartDocument);
      starts.set(key, startedInside);
      startedInside ? occupancy.set(key, true) : occupancy.delete(key);
    }
    movementStartOccupancy.set(targetToken.id, starts);
    occupancy.size ? currentOccupancy.set(targetToken.id, occupancy) : currentOccupancy.delete(targetToken.id);
    return;
  }

  const starts = movementStartOccupancy.get(targetToken.id) ?? new Map();
  movementStartOccupancy.delete(targetToken.id);
  const occupancy = currentOccupancy.get(targetToken.id) ?? new Map();
  for (const source of sources) {
    const aura = getKineticAura(source.actor);
    if (!aura) continue;
    const previousInside = (starts.has(source.id) ? starts.get(source.id) : occupancy.get(source.id)) ?? false;
    const currentInside = isTokenInsideAura(aura, source, targetToken);
    if ((!previousInside && currentInside) || (previousInside && currentInside)) {
      emitAuraEvent({
        type: SocketMessageType.AURA_EVENT,
        eventKind: AuraEventType.MOVE,
        tokenId: targetToken.id,
        enemyId: source.id,
        auraSlug: aura.slug ?? WINTER_SLEET_AURA_SLUG,
        auraIdentifier: WINTER_SLEET_AURA_SLUG,
        combatId: game.combat?.id ?? null,
        round: game.combat?.round ?? 0,
        turn: game.combat?.turn ?? 0,
        eventSequence: movementSequence,
      });
    }
    currentInside ? occupancy.set(source.id, true) : occupancy.delete(source.id);
  }
  occupancy.size ? currentOccupancy.set(targetToken.id, occupancy) : currentOccupancy.delete(targetToken.id);
}

export async function handleWinterSleetTurn() {
  if (isResponsibleGM()) await refreshWinterSleetEffects();
}

export async function handleWinterSleetTokenUpdate({ change }) {
  if ((change?.x !== undefined || change?.y !== undefined) && isResponsibleGM()) {
    await refreshWinterSleetEffects();
  }
}

export async function handleWinterSleetItemChange() {
  if (isResponsibleGM()) await refreshWinterSleetEffects();
}

export async function handleWinterSleetCanvasReady() {
  clearWinterSleetMovementState();
  if (isResponsibleGM()) await refreshWinterSleetEffects();
}

export async function handleWinterSleetAuraEvent(payload, { token, source } = {}) {
  if (![AuraEventType.ENTER, AuraEventType.MOVE, AuraEventType.START_TURN].includes(payload?.eventKind)) return false;
  if (!token?.actor || !source?.actor || !getWinterSleetSourcesForToken(token).some((candidate) => candidate.id === source.id)) {
    return false;
  }
  // The updateToken movement pipeline owns entry/within triggers for this feature.
  if (payload.eventKind === AuraEventType.ENTER) return true;
  if (winterSleetEvents.checkAndAdd(getWinterSleetEventKey(payload), WINTER_SLEET_EVENT_TTL_MS)) return true;
  await createWinterSleetChatMessage({ token, source, eventKind: payload.eventKind });
  return true;
}

export function clearWinterSleetMovementState(tokenId = null) {
  if (tokenId) {
    movementStartOccupancy.delete(tokenId);
    currentOccupancy.delete(tokenId);
    return;
  }
  movementStartOccupancy.clear();
  currentOccupancy.clear();
  winterSleetEvents.clear();
}

export async function refreshWinterSleetEffects() {
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

    const hasStanceFeat = hasWinterSleetStance(token.actor);
    const hasActiveStance = hasActiveWinterSleetStanceEffect(token.actor);
    if (!hasActiveStance) {
      reasons.push('missing-active-winter-sleet-stance-effect');
    }

    const sourceEffects = collectWinterSleetSourceDebugEffects(token.actor);
    const hasAuraSourceItem = hasActiveKineticAuraEffect(token.actor);
    if (!hasAuraSourceItem) reasons.push('missing-active-kinetic-aura-effect');

    if (reasons.length > 0) {
      logWinterSleetDebug('Skipping active source candidate', {
        sourceToken: token.id,
        reasons,
        hasAuraSourceItem,
        hasStanceFeat,
        hasActiveStance,
        auraSlug: aura?.slug ?? null,
        sourceEffects,
      });
      continue;
    }

    logWinterSleetDebug('Kinetic Aura erkannt + Winter Sleet Stance aktiv', {
      sourceToken: token.id,
      auraSlug: aura.slug,
      hasAuraSourceItem,
      hasStanceFeat,
      hasActiveStance,
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
      const rangeCheck = source
        ? getAuraRangeCheck(source.aura, source.token, token, { mode: getAuraDistanceMode() })
        : null;
      const inRange = rangeCheck?.inRange ?? false;
      logWinterSleetDebug('Checking existing off-guard source range', {
        token: token.id,
        sourceId,
        distance: rangeCheck?.distance ?? null,
        centerDistance: rangeCheck?.centerDistance ?? null,
        edgeDistance: rangeCheck?.edgeDistance ?? null,
        radius: rangeCheck?.radius ?? null,
        modeApplied: rangeCheck?.modeApplied ?? null,
        inRange,
      });
      if (!inRange) await condition.delete();
    }
  }

  for (const [sourceId, data] of active) {
    for (const token of tokens) {
      if (!data.token.actor.isEnemyOf(token.actor)) continue;
      const rangeCheck = getAuraRangeCheck(data.aura, data.token, token, { mode: getAuraDistanceMode() });
      const inRange = rangeCheck.inRange;
      logWinterSleetDebug('Checking token against active source aura', {
        sourceId,
        token: token.id,
        distance: rangeCheck.distance,
        centerDistance: rangeCheck.centerDistance,
        edgeDistance: rangeCheck.edgeDistance,
        radius: rangeCheck.radius,
        modeApplied: rangeCheck.modeApplied,
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

export async function createWinterSleetChatMessage({ token, source, eventKind = AuraEventType.MOVE }) {
  if (!token?.actor || !source?.actor) return;
  if (!isResponsibleGM()) return;
  const stance = source.actor.items.find((i) => i.slug === WINTER_SLEET_STANCE_SLUG) ?? null;
  const sourceName = stance?.name ?? 'Winter Sleet';
  const sourceLink = stance?.uuid ? `@UUID[${stance.uuid}]{${sourceName}}` : sourceName;
  const content = eventKind === AuraEventType.START_TURN
    ? `${token.name} beginnt seinen Zug innerhalb der Aura ${sourceLink} von ${source.name}.`
    : `${token.name} bewegt sich in der Aura ${sourceLink} von ${source.name} und muss einen Balance-Check ablegen.`;

  const speaker = ChatMessage.getSpeaker({ token: token.document, actor: token.actor });
  await ChatMessage.create({ content, speaker, whisper: shouldWhisperToGm() ? gmIds() : undefined });
}
