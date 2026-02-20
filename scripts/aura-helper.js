import { AURA_DISTANCE_MODES, getAuraDistanceMode, getAuraRangeCheck } from './aura-distance.js';

const movementStarts = new Map();
const currentAuraOccupancy = new Map();
const wasInAura = new Map();
const recentAuraEvents = new Map();
const recentEmitterAuraEvents = new Map();
const tokenMovementSequence = new Map();

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
const AURA_ITEM_SLUG_MAPPINGS = {
  [WINTER_SLEET_AURA_SLUG]: [WINTER_SLEET_STANCE_SLUG, WINTER_SLEET_EFFECT_SLUG],
};
const NYMPHS_GRACE_AURA_SLUG = 'nymphs-grace';
const NYMPHS_GRACE_NAME_RE = /nymph['’]s\s+grace/i;
const WINTER_SLEET_TRIGGER_ON_MOVE_WITHIN = true;
const SETTING_DEBUG_ENABLED = 'debugEnabled';
const SETTING_LOG_LEVEL = 'logLevel';
const SETTING_REQUIRE_VISIBLE_ENEMIES = 'requireVisibleEnemies';
const SETTING_PUBLIC_CHAT_MESSAGES = 'publicChatMessages';
const SETTING_INCLUDE_ALLIED_AURAS = 'includeAlliedAuras';
const SETTING_DEBUG_AURA_TRAIT_SCAN = 'debugAuraTraitScan';
const SETTING_AURA_DISTANCE_MODE = 'auraDistanceMode';
const COMBAT_SUPPRESSION_FLAG_KEY = 'suppressedAuras';
const SETTINGS_KEY_PREFIX = `${MODULE_ID}.`;
const LOG_LEVELS = {
  OFF: 'off',
  INFO: 'info',
  DEBUG: 'debug',
  WINTER_SLEET: 'winter-sleet',
};
const loggedAuraTraitScanByCombat = new Set();

function getSettingStorageKey(settingKey) {
  return `${SETTINGS_KEY_PREFIX}${settingKey}`;
}

function isSettingExplicitlyConfigured(settingKey) {
  const definition = game.settings.settings.get(getSettingStorageKey(settingKey));
  if (!definition) return false;

  const storage = game.settings.storage.get(definition.scope);
  if (!storage) return false;

  const fullSettingKey = getSettingStorageKey(settingKey);
  if (typeof storage.has === 'function') {
    return storage.has(fullSettingKey);
  }

  if (typeof storage.get === 'function') {
    return storage.get(fullSettingKey) !== undefined;
  }

  return false;
}

function getLogLevel() {
  const hasExplicitLogLevel = isSettingExplicitlyConfigured(SETTING_LOG_LEVEL);
  const configuredLogLevel = game.settings.get(MODULE_ID, SETTING_LOG_LEVEL);

  if (hasExplicitLogLevel && Object.values(LOG_LEVELS).includes(configuredLogLevel)) {
    return configuredLogLevel;
  }

  const debugEnabled = game.settings.get(MODULE_ID, SETTING_DEBUG_ENABLED);
  return debugEnabled ? LOG_LEVELS.DEBUG : LOG_LEVELS.OFF;
}

function logDebug(...args) {
  if (getLogLevel() === LOG_LEVELS.WINTER_SLEET) return;
  if (getLogLevel() !== LOG_LEVELS.DEBUG) return;
  console.debug('[Aura Helper]', ...args);
}

function logInfo(...args) {
  const logLevel = getLogLevel();
  if (logLevel === LOG_LEVELS.WINTER_SLEET) return;
  if (logLevel !== LOG_LEVELS.INFO && logLevel !== LOG_LEVELS.DEBUG) return;
  console.info('[Aura Helper]', ...args);
}

function shouldRequireVisibleEnemies() {
  return game.settings.get(MODULE_ID, SETTING_REQUIRE_VISIBLE_ENEMIES);
}

function shouldWhisperToGm() {
  return !game.settings.get(MODULE_ID, SETTING_PUBLIC_CHAT_MESSAGES);
}

function shouldIncludeAlliedAuras() {
  return game.settings.get(MODULE_ID, SETTING_INCLUDE_ALLIED_AURAS);
}

function shouldLogAuraTraitScan() {
  return game.settings.get(MODULE_ID, SETTING_DEBUG_AURA_TRAIT_SCAN);
}

function getSpellSaveDc(actor) {
  const spellDc = Number(
    actor?.system?.attributes?.spellDC?.value ??
      actor?.system?.attributes?.spellDC?.dc ??
      actor?.system?.attributes?.spelldc?.value ??
      actor?.system?.attributes?.spelldc?.dc
  );

  return Number.isFinite(spellDc) ? spellDc : null;
}

function getNymphsGraceWillSaveInlineLink(sourceActor) {
  const spellDc = getSpellSaveDc(sourceActor);
  if (spellDc === null) return null;
  return `@Check[type:will|dc:${spellDc}]`;
}

function isNymphsGraceAura({ aura, origin }) {
  const auraSlug = aura?.slug ?? '';
  if (auraSlug === NYMPHS_GRACE_AURA_SLUG) return true;

  const auraName = origin?.name ?? aura?.name ?? '';
  return NYMPHS_GRACE_NAME_RE.test(auraName);
}

function appendNymphsGraceSavePrompt(content, { aura, origin, sourceActor }) {
  if (!isNymphsGraceAura({ aura, origin })) return content;

  const willSaveInlineLink = getNymphsGraceWillSaveInlineLink(sourceActor);
  if (!willSaveInlineLink) return content;

  return `${content} ${willSaveInlineLink}{Will Save} gegen den Zauber-SG (${getSpellSaveDc(sourceActor)}).`;
}

function getChatDeliveryTargets(whisperToGm) {
  if (!whisperToGm) {
    return {
      channel: 'public',
      recipients: ['all players'],
      whisper: undefined,
    };
  }

  const whisperRecipients = gmIds();
  return {
    channel: 'whisper',
    recipients: whisperRecipients,
    whisper: whisperRecipients,
  };
}

function patchChatMessageUserAlias() {
  const chatMessageClass = CONFIG?.ChatMessage?.documentClass;
  const prototype = chatMessageClass?.prototype;
  if (!prototype) return;

  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'user');
  if (!descriptor?.get || descriptor.set) return;

  Object.defineProperty(prototype, 'user', {
    configurable: true,
    enumerable: descriptor.enumerable ?? false,
    get() {
      return this.author ?? null;
    },
  });
}

function getAuraEventKey({ combatId, eventKind, tokenId, enemyId, auraSlug, round, turn, eventSequence }) {
  return `${combatId ?? 'none'}:${eventKind}:${tokenId}:${enemyId}:${auraSlug}:${round}:${turn}:${eventSequence ?? 'none'}`;
}

function nextTokenMovementSequence(tokenId) {
  const current = tokenMovementSequence.get(tokenId) ?? 0;
  const next = current + 1;
  tokenMovementSequence.set(tokenId, next);
  return next;
}

function isPrimaryActiveGm() {
  if (!game.user.isGM) return false;
  const activeGms = game.users
    .filter((user) => user.isGM && user.active)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (activeGms.length === 0) return true;
  return activeGms[0].id === game.user.id;
}

function isDuplicate(cache, payload) {
  const key = getAuraEventKey(payload);
  const now = Date.now();
  for (const [cachedKey, expiresAt] of cache) {
    if (expiresAt <= now) cache.delete(cachedKey);
  }
  const cached = cache.get(key);
  if (cached && cached > now) return true;
  cache.set(key, now + AURA_EVENT_TTL_MS);
  return false;
}

function emitAuraEvent(payload) {
  if (isDuplicate(recentEmitterAuraEvents, payload)) {
    logDebug('skip duplicate emit (local)', {
      eventKind: payload.eventKind,
      tokenId: payload.tokenId,
      enemyId: payload.enemyId,
      auraSlug: payload.auraSlug,
      auraIdentifier: payload.auraIdentifier,
      combatId: payload.combatId,
      round: payload.round,
      turn: payload.turn,
    });
    return;
  }

  logDebug('emit aura event', {
    eventKind: payload.eventKind,
    tokenId: payload.tokenId,
    enemyId: payload.enemyId,
    auraSlug: payload.auraSlug,
    auraIdentifier: payload.auraIdentifier,
    combatId: payload.combatId,
    round: payload.round,
    turn: payload.turn,
  });

  game.socket.emit(`module.${MODULE_ID}`, payload);

  // Foundry may not deliver socket emissions back to the sender in single-client sessions.
  // Process locally as well so chat reminders still fire when only one GM client is connected.
  handleIncomingAuraEvent(payload);
}

function normalizeAuraString(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function buildAuraIdentifier(aura, containerAuraKey) {
  const directSlug = normalizeAuraString(aura?.slug);
  if (directSlug) return directSlug;

  const mappedKey = normalizeAuraString(containerAuraKey);
  if (mappedKey) return mappedKey;

  const effect = aura?.effects?.[0];
  const effectSlug = normalizeAuraString(effect?.slug);
  if (effectSlug) return effectSlug;

  const effectUuid =
    normalizeAuraString(effect?.uuid) ??
    normalizeAuraString(effect?.origin) ??
    normalizeAuraString(effect?.sourceId) ??
    normalizeAuraString(effect?.system?.context?.origin?.uuid);
  if (effectUuid) return effectUuid;

  const fallbackName = normalizeAuraString(aura?.name) ?? 'unnamed-aura';
  const fallbackRadius = Number.isFinite(Number(aura?.radius)) ? Number(aura.radius) : 'unknown-radius';
  return `name:${fallbackName}|radius:${fallbackRadius}`;
}

function getAuraEntriesFromContainer(container) {
  if (!container) return [];

  if (typeof container.entries === 'function') {
    return [...container.entries()];
  }

  if (Array.isArray(container)) {
    return container.map((aura, index) => [String(index), aura]);
  }

  if (typeof container === 'object') {
    return Object.entries(container);
  }

  return [];
}

function resolveAuraFromSource(sourceToken, auraSlug, auraIdentifier) {
  if (!sourceToken?.actor?.auras) return null;
  const directAura = auraSlug ? sourceToken.actor.auras.get(auraSlug) : null;
  if (directAura) return directAura;

  if (auraIdentifier) {
    const keyedAura = sourceToken.actor.auras.get(auraIdentifier);
    if (keyedAura) return keyedAura;
  }

  const auraEntries = getAuraEntriesFromContainer(sourceToken.actor.auras);
  if (auraIdentifier) {
    for (const [containerAuraKey, aura] of auraEntries) {
      if (buildAuraIdentifier(aura, containerAuraKey) === auraIdentifier) {
        return aura;
      }
    }
  }

  if (!auraSlug) return null;
  return auraEntries.find(([, aura]) => aura?.slug === auraSlug)?.[1] ?? null;
}

function getTokenUuid(tokenLike) {
  const tokenDocument = tokenLike?.document ?? tokenLike;
  return tokenDocument?.uuid ?? null;
}

function getTokenId(tokenLike) {
  if (!tokenLike) return null;
  return tokenLike.id ?? tokenLike.document?.id ?? tokenLike.token?.id ?? null;
}

function getTokenSceneId(tokenLike) {
  if (!tokenLike) return null;

  const sceneIdCandidates = [
    tokenLike.scene?.id,
    tokenLike.document?.scene?.id,
    tokenLike.parent?.id,
    tokenLike.document?.parent?.id,
    tokenLike.sceneId,
    tokenLike.document?.sceneId,
  ];

  return sceneIdCandidates.find((value) => normalizeAuraString(value)) ?? null;
}

function getTokenSuppressionIdentity(tokenLike) {
  const tokenId = normalizeAuraString(getTokenId(tokenLike));
  if (!tokenId) return null;

  const sceneId = normalizeAuraString(getTokenSceneId(tokenLike));
  return sceneId ? `${sceneId}:${tokenId}` : tokenId;
}

function buildLegacyAuraSuppressionKey({ source, auraIdentifier, target }) {
  const sourceUuid = getTokenUuid(source);
  const targetUuid = getTokenUuid(target);
  const normalizedAuraIdentifier = normalizeAuraString(auraIdentifier);
  if (!sourceUuid || !targetUuid || !normalizedAuraIdentifier) return null;
  return `${sourceUuid}|${normalizedAuraIdentifier}|${targetUuid}`;
}

function buildAuraSuppressionKey({ source, auraIdentifier, target }) {
  const sourceIdentity = getTokenSuppressionIdentity(source);
  const targetIdentity = getTokenSuppressionIdentity(target);
  const normalizedAuraIdentifier = normalizeAuraString(auraIdentifier);
  if (!sourceIdentity || !targetIdentity || !normalizedAuraIdentifier) return null;
  return `${sourceIdentity}|${normalizedAuraIdentifier}|${targetIdentity}`;
}

function getCombatAuraSuppressionMap(combat = game.combat) {
  if (!combat) return {};
  const suppressionMap = combat.getFlag(MODULE_ID, COMBAT_SUPPRESSION_FLAG_KEY);
  if (!suppressionMap || typeof suppressionMap !== 'object') return {};
  return suppressionMap;
}

function parseAuraSuppressionKey(key) {
  if (typeof key !== 'string') return null;
  const [sourcePart, auraPart, targetPart, ...rest] = key.split('|');
  if (rest.length > 0) return null;

  const sourceIdentity = normalizeAuraString(sourcePart);
  const auraIdentifier = normalizeAuraString(auraPart);
  const targetIdentity = normalizeAuraString(targetPart);
  if (!sourceIdentity || !auraIdentifier || !targetIdentity) return null;

  return {
    sourceIdentity,
    auraIdentifier,
    targetIdentity,
  };
}

function getSuppressionIdentityVariants(tokenLike) {
  const variants = new Set();
  const tokenIdentity = normalizeAuraString(getTokenSuppressionIdentity(tokenLike));
  const tokenUuid = normalizeAuraString(getTokenUuid(tokenLike));
  if (tokenIdentity) variants.add(tokenIdentity);
  if (tokenUuid) variants.add(tokenUuid);
  return variants;
}

function getMatchingSuppressionKeys({ suppressionMap, source, auraIdentifier, target }) {
  const normalizedAuraIdentifier = normalizeAuraString(auraIdentifier);
  if (!normalizedAuraIdentifier || !suppressionMap || typeof suppressionMap !== 'object') return [];

  const sourceVariants = getSuppressionIdentityVariants(source);
  const targetVariants = getSuppressionIdentityVariants(target);
  const suppressionKey = buildAuraSuppressionKey({ source, auraIdentifier: normalizedAuraIdentifier, target });
  const legacySuppressionKey = buildLegacyAuraSuppressionKey({
    source,
    auraIdentifier: normalizedAuraIdentifier,
    target,
  });

  if (suppressionKey) sourceVariants.add(suppressionKey.split('|')[0]);
  if (suppressionKey) targetVariants.add(suppressionKey.split('|')[2]);
  if (legacySuppressionKey) sourceVariants.add(legacySuppressionKey.split('|')[0]);
  if (legacySuppressionKey) targetVariants.add(legacySuppressionKey.split('|')[2]);

  return Object.keys(suppressionMap).filter((key) => {
    if (key === suppressionKey || key === legacySuppressionKey) return true;
    const parsedKey = parseAuraSuppressionKey(key);
    if (!parsedKey) return false;
    if (parsedKey.auraIdentifier !== normalizedAuraIdentifier) return false;
    return sourceVariants.has(parsedKey.sourceIdentity) && targetVariants.has(parsedKey.targetIdentity);
  });
}

function isAuraSuppressed({ source, auraIdentifier, target, combat = game.combat }) {
  const suppressionKey = buildAuraSuppressionKey({ source, auraIdentifier, target });
  const suppressionMap = getCombatAuraSuppressionMap(combat);

  if (suppressionKey) {
    const hasSceneTokenEntry = Object.hasOwn(suppressionMap, suppressionKey);
    if (hasSceneTokenEntry) {
      const isSuppressed = suppressionMap[suppressionKey] === true;
      logDebug('read aura suppression state', {
        suppressionKey,
        isSuppressed,
        format: 'scene-token',
      });
      return isSuppressed;
    }
  }

  const legacySuppressionKey = buildLegacyAuraSuppressionKey({ source, auraIdentifier, target });
  if (!legacySuppressionKey) return false;
  const isLegacySuppressed = suppressionMap[legacySuppressionKey] === true;
  logDebug('read aura suppression state', {
    suppressionKey: legacySuppressionKey,
    isSuppressed: isLegacySuppressed,
    format: 'uuid',
  });
  return isLegacySuppressed;
}

async function setAuraSuppression({ source, auraIdentifier, target, suppressed, combat = game.combat }) {
  if (!combat) return;
  const suppressionKey = buildAuraSuppressionKey({ source, auraIdentifier, target });
  const legacySuppressionKey = buildLegacyAuraSuppressionKey({ source, auraIdentifier, target });
  const effectiveSuppressionKey = suppressionKey ?? legacySuppressionKey;
  if (!effectiveSuppressionKey) return;

  const suppressionMap = { ...getCombatAuraSuppressionMap(combat) };
  const previousSuppressionMap = { ...suppressionMap };

  logDebug('set aura suppression calculated keys', {
    suppressionKey,
    legacySuppressionKey,
    effectiveSuppressionKey,
    suppressed,
  });

  if (suppressed) {
    suppressionMap[effectiveSuppressionKey] = true;
    if (legacySuppressionKey && legacySuppressionKey !== effectiveSuppressionKey) delete suppressionMap[legacySuppressionKey];
    logDebug('set aura suppression map update', {
      suppressionKey: effectiveSuppressionKey,
      suppressed: true,
      previousSuppressionMap,
      nextSuppressionMap: suppressionMap,
    });
    await combat.setFlag(MODULE_ID, COMBAT_SUPPRESSION_FLAG_KEY, suppressionMap);
    return;
  }

  const matchingKeys = getMatchingSuppressionKeys({ suppressionMap, source, auraIdentifier, target });
  for (const key of matchingKeys) {
    delete suppressionMap[key];
  }
  logDebug('set aura suppression map update', {
    suppressionKey: effectiveSuppressionKey,
    suppressed: false,
    removedKeys: matchingKeys,
    previousSuppressionMap,
    nextSuppressionMap: suppressionMap,
  });
  if (Object.keys(suppressionMap).length === 0) {
    await combat.unsetFlag(MODULE_ID, COMBAT_SUPPRESSION_FLAG_KEY);
    return;
  }
  await combat.setFlag(MODULE_ID, COMBAT_SUPPRESSION_FLAG_KEY, suppressionMap);
}

async function migrateLegacyAuraSuppressionMap(combat = game.combat) {
  if (!combat) return false;

  const suppressionMap = { ...getCombatAuraSuppressionMap(combat) };
  const updatedMap = { ...suppressionMap };
  let didChange = false;

  for (const [key, value] of Object.entries(suppressionMap)) {
    if (value !== true) {
      delete updatedMap[key];
      didChange = true;
      continue;
    }

    const parsedKey = parseAuraSuppressionKey(key);
    if (!parsedKey) {
      delete updatedMap[key];
      didChange = true;
      continue;
    }

    const sourceDoc = await fromUuid(parsedKey.sourceIdentity).catch(() => null);
    const targetDoc = await fromUuid(parsedKey.targetIdentity).catch(() => null);
    if (!sourceDoc || !targetDoc) continue;

    const source = sourceDoc?.object ?? sourceDoc;
    const target = targetDoc?.object ?? targetDoc;
    const migratedKey = buildAuraSuppressionKey({
      source,
      auraIdentifier: parsedKey.auraIdentifier,
      target,
    });

    delete updatedMap[key];
    if (migratedKey) {
      updatedMap[migratedKey] = true;
    }
    didChange = true;
    logDebug('migrated legacy aura suppression key', {
      previousKey: key,
      migratedKey: migratedKey ?? null,
      format: migratedKey ? 'scene-token' : 'removed',
    });
  }

  if (!didChange) return false;

  if (Object.keys(updatedMap).length === 0) {
    await combat.unsetFlag(MODULE_ID, COMBAT_SUPPRESSION_FLAG_KEY);
    return true;
  }

  await combat.setFlag(MODULE_ID, COMBAT_SUPPRESSION_FLAG_KEY, updatedMap);
  return true;
}

async function verifyAuraSuppressionState({
  source,
  auraIdentifier,
  target,
  suppressed,
  combat = game.combat,
  attempts = 3,
  delayMs = 75,
}) {
  const maxAttempts = Math.max(1, Number(attempts) || 1);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const verifiedSuppressed = isAuraSuppressed({ source, auraIdentifier, target, combat });
    if (verifiedSuppressed === suppressed) {
      return { success: true, verifiedSuppressed, attempt };
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  const verifiedSuppressed = isAuraSuppressed({ source, auraIdentifier, target, combat });
  return { success: false, verifiedSuppressed, attempt: maxAttempts };
}

function getArrayFromUnknown(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [value];
  if (value instanceof Set) return [...value];
  if (value && typeof value === 'object') {
    if (Array.isArray(value.value)) return value.value;
    if (Array.isArray(value.values)) return value.values;
  }
  return [];
}

function itemHasAuraTrait(item) {
  if (!item) return false;

  const traitSources = [
    item.system?.traits?.value,
    item.system?.traits?.values,
    item.system?.traits,
    item.system?.trait,
    item.traits,
    item.system?.details?.traits?.value,
  ];

  return traitSources.some((source) =>
    getArrayFromUnknown(source)
      .map((trait) => String(trait ?? '').toLowerCase().trim())
      .includes('aura')
  );
}

function isAuraTraitItemActive(item) {
  if (!item) return false;
  if (item.system?.active === false) return false;
  if (item.active === false) return false;
  if (item.system?.suppressed === true) return false;
  if (item.disabled === true) return false;
  return true;
}

function extractNumericDistance(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const match = value.match(/\d+(?:[\.,]\d+)?/);
    if (!match) return null;
    const normalized = match[0].replace(',', '.');
    const numeric = Number(normalized);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}

function getAuraRadiusFromItem(item) {
  if (!item) return null;

  const auraRule = (item.system?.rules ?? []).find((rule) =>
    String(rule?.key ?? '').toLowerCase() === 'aura'
  );

  const radiusCandidates = [
    item.system?.aura?.radius,
    item.system?.aura?.value,
    item.system?.aura?.distance,
    item.system?.details?.aura?.radius,
    item.system?.range?.value,
    item.system?.radius,
    auraRule?.radius,
    auraRule?.distance,
    auraRule?.range,
  ];

  for (const candidate of radiusCandidates) {
    const numeric = extractNumericDistance(candidate);
    if (numeric !== null) return numeric;
  }

  return null;
}

function buildTraitAuraFromItem(item) {
  const radius = getAuraRadiusFromItem(item);
  if (!Number.isFinite(radius)) {
    return {
      slug: item.slug ?? null,
      name: item.name,
      radius: null,
      effects: [{ origin: item.uuid, sourceId: item.uuid, name: item.name, slug: item.slug ?? null }],
      __diagnosticOnly: true,
    };
  }

  return {
    slug: item.slug ?? null,
    name: item.name,
    radius,
    effects: [{ origin: item.uuid, sourceId: item.uuid, name: item.name, slug: item.slug ?? null }],
    __diagnosticOnly: false,
  };
}

function getNpcAuraTraitItems(sourceToken) {
  if (sourceToken?.actor?.type !== 'npc') return [];
  const items = sourceToken.actor?.items ?? [];
  return items.filter((item) => isAuraTraitItemActive(item) && itemHasAuraTrait(item));
}

function logCombatNpcAuraTraitSummary(combat = game.combat) {
  if (!combat) return;
  if (getLogLevel() !== LOG_LEVELS.DEBUG) return;
  if (!shouldLogAuraTraitScan()) return;

  const combatants = combat.combatants ?? [];
  const summary = [];

  for (const combatant of combatants) {
    const token = combatant.token?.object ?? combatant.token ?? canvas.tokens?.get(combatant.tokenId) ?? null;
    const actor = token?.actor ?? combatant.actor ?? null;
    if (!actor || actor.type !== 'npc') continue;

    const auraItems = getNpcAuraTraitItems({ actor });
    const auraItemSummaries = auraItems.map((item) => ({
      name: item.name,
      slug: item.slug ?? null,
      uuid: item.uuid ?? null,
      radius: getAuraRadiusFromItem(item),
    }));

    summary.push({
      npcName: token?.name ?? actor.name,
      auraTraitItemCount: auraItemSummaries.length,
      auraTraitItems: auraItemSummaries,
    });
  }

  logDebug('Combat NPC Aura-Trait summary', {
    combatId: combat.id ?? null,
    combatName: combat.name ?? null,
    npcCount: summary.length,
    npcs: summary,
  });
}

function logCombatNpcAuraTraitSummaryOnce(combat = game.combat, trigger = 'unknown') {
  if (!combat?.id) return;
  if (loggedAuraTraitScanByCombat.has(combat.id)) return;
  loggedAuraTraitScanByCombat.add(combat.id);
  logDebug('running combat aura-trait diagnostic scan', {
    combatId: combat.id,
    trigger,
  });
  logCombatNpcAuraTraitSummary(combat);
}

function getOriginItemFromAuraIdentifier(sourceToken, auraIdentifier) {
  if (!sourceToken?.actor || !auraIdentifier) return null;
  if (!String(auraIdentifier).startsWith('trait-item:')) return null;
  const itemUuid = String(auraIdentifier).slice('trait-item:'.length);
  if (!itemUuid) return null;
  return sourceToken.actor.items.find((item) => item.uuid === itemUuid) ?? null;
}

async function handleIncomingAuraEvent(payload) {
  if (!payload) return;

  if (payload.type !== AURA_EVENT_TYPE) return;
  if (
    payload.eventKind !== AURA_EVENT_KINDS.START_TURN &&
    payload.eventKind !== AURA_EVENT_KINDS.ENTER &&
    payload.eventKind !== AURA_EVENT_KINDS.WINTER_SLEET
  ) {
    return;
  }
  if (isDuplicate(recentAuraEvents, payload)) {
    logDebug('skip duplicate incoming aura event', {
      eventKind: payload.eventKind,
      tokenId: payload.tokenId,
      enemyId: payload.enemyId,
      auraSlug: payload.auraSlug,
      auraIdentifier: payload.auraIdentifier,
      combatId: payload.combatId,
      round: payload.round,
      turn: payload.turn,
    });
    return;
  }

  const token = canvas.tokens.get(payload.tokenId);
  const enemy = canvas.tokens.get(payload.enemyId);

  if (payload.eventKind === AURA_EVENT_KINDS.START_TURN) {
    const activeCombatant = game.combat?.combatant ?? null;
    const activeTokenId = activeCombatant?.tokenId ?? activeCombatant?.token?.id ?? null;
    if (!activeTokenId || payload.tokenId !== activeTokenId) {
      logDebug('skip start-turn aura event for non-active token', {
        payloadTokenId: payload.tokenId,
        activeTokenId,
        combatId: game.combat?.id ?? null,
      });
      return;
    }
  }

  logDebug('Aura event received', {
    eventKind: payload.eventKind,
    tokenId: payload.tokenId,
    tokenName: token?.name ?? null,
    sourceId: payload.enemyId,
    sourceName: enemy?.name ?? null,
    auraSlug: payload.auraSlug,
    auraIdentifier: payload.auraIdentifier,
    round: payload.round,
    turn: payload.turn,
  });

  const suppressionIdentifier = payload.auraIdentifier ?? payload.auraSlug;
  if (isAuraSuppressed({ source: enemy, auraIdentifier: suppressionIdentifier, target: token })) {
    logDebug('skip aura event due to suppression', {
      eventKind: payload.eventKind,
      tokenId: payload.tokenId,
      tokenName: token?.name ?? null,
      sourceId: payload.enemyId,
      sourceName: enemy?.name ?? null,
      auraIdentifier: suppressionIdentifier ?? null,
      combatId: game.combat?.id ?? null,
    });
    return;
  }

  if (payload.eventKind === AURA_EVENT_KINDS.WINTER_SLEET) {
    const token = canvas.tokens.get(payload.tokenId);
    const source = canvas.tokens.get(payload.enemyId);
    await createWinterSleetChatMessage({ token, source, whisperToGm: shouldWhisperToGm() });
    return;
  }

  if (!token?.actor || !enemy?.actor) return;
  const aura = resolveAuraFromSource(enemy, payload.auraSlug, payload.auraIdentifier);
  const originItem = getOriginItemFromAuraIdentifier(enemy, payload.auraIdentifier);
  const resolvedAura = aura ?? (originItem ? buildTraitAuraFromItem(originItem) : null);
  if (!token || !enemy || !resolvedAura) return;

  await handleAura({
    token,
    enemy,
    aura: resolvedAura,
    auraIdentifier: payload.auraIdentifier,
    originItem,
    message: (auraLink) =>
      payload.eventKind === AURA_EVENT_KINDS.START_TURN
        ? `${token.name} beginnt seinen Zug innerhalb der Aura ${auraLink} von ${enemy.name}.`
        : `${token.name} betritt die Aura ${auraLink} von ${enemy.name}.`,
    whisperToGm: shouldWhisperToGm(),
  });
}

function getCombatTokens(combat = game.combat) {
  if (!combat) return [];
  return (combat.combatants ?? [])
    .map((combatant) =>
      combatant.token?.object ?? combatant.token ?? canvas.tokens?.get(combatant.tokenId) ?? null
    )
    .filter((token) => !!token?.id && !!token.actor);
}

async function getAuraSuppressionMenuData(combat = game.combat) {
  if (!combat) {
    return {
      hasCombat: false,
      sources: [],
    };
  }

  await migrateLegacyAuraSuppressionMap(combat);

  const sourceMap = new Map();
  const tokens = getCombatTokens(combat);

  const registerSourceAuraTarget = ({ source, target, auraIdentifier, auraName }) => {
    const sourceUuid = getTokenUuid(source);
    const targetUuid = getTokenUuid(target);
    if (!sourceUuid || !targetUuid || !normalizeAuraString(auraIdentifier)) return;

    const sourceName = source?.name ?? source?.actor?.name ?? 'Unbekannte Quelle';
    const targetName = target?.name ?? target?.actor?.name ?? 'Unbekanntes Ziel';
    const resolvedAuraName = auraName ?? auraIdentifier;

    let sourceEntry = sourceMap.get(sourceUuid);
    if (!sourceEntry) {
      sourceEntry = {
        uuid: sourceUuid,
        name: sourceName,
        auraMap: new Map(),
      };
      sourceMap.set(sourceUuid, sourceEntry);
    }

    let auraEntry = sourceEntry.auraMap.get(auraIdentifier);
    if (!auraEntry) {
      auraEntry = {
        id: auraIdentifier,
        identifier: auraIdentifier,
        name: resolvedAuraName,
        targetMap: new Map(),
      };
      sourceEntry.auraMap.set(auraIdentifier, auraEntry);
    }

    if (auraEntry.targetMap.has(targetUuid)) return;
    auraEntry.targetMap.set(targetUuid, {
      uuid: targetUuid,
      name: targetName,
      isSuppressed: isAuraSuppressed({ source, auraIdentifier, target, combat }),
    });
  };

  for (const target of tokens) {
    const auraChecks = getStandardAuraChecks(target);
    for (const { source, aura, auraIdentifier } of auraChecks) {
      registerSourceAuraTarget({
        source,
        target,
        auraIdentifier,
        auraName: aura?.name ?? aura?.slug ?? auraIdentifier,
      });
    }

    for (const source of getWinterSleetSources()) {
      if (!source?.actor?.isEnemyOf(target.actor)) continue;
      registerSourceAuraTarget({
        source,
        target,
        auraIdentifier: WINTER_SLEET_AURA_SLUG,
        auraName: 'Winter Sleet',
      });
    }
  }

  const sources = [...sourceMap.values()]
    .map((sourceEntry) => ({
      uuid: sourceEntry.uuid,
      name: sourceEntry.name,
      auras: [...sourceEntry.auraMap.values()]
        .map((auraEntry) => ({
          id: auraEntry.id,
          identifier: auraEntry.identifier,
          name: auraEntry.name,
          targets: [...auraEntry.targetMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
        }))
        .sort((a, b) => `${a.name}|${a.identifier}`.localeCompare(`${b.name}|${b.identifier}`)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    hasCombat: true,
    sources,
  };
}

class AuraSuppressionMenuApplication extends Application {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: `${MODULE_ID}-suppression-menu`,
      title: 'PF2e Aura Helper',
      template: `modules/${MODULE_ID}/templates/aura-helper-tab.hbs`,
      classes: ['pf2e-aura-helper', 'pf2e-aura-helper-tab-window'],
      width: 520,
      height: 'auto',
      resizable: true,
      popOut: true,
    });
  }

  async getData() {
    return await getAuraSuppressionMenuData(game.combat);
  }

  activateListeners(html) {
    super.activateListeners(html);

    const root = html?.[0] ?? html;
    root?.addEventListener('change', (event) => this.onTargetSuppressionChange(event));
  }

  async onTargetSuppressionChange(event) {
    const checkbox = event.target?.closest?.('.aura-helper-tab__target-checkbox');
    if (!checkbox) return;

    const combat = game.combat;
    if (!combat) return;

    const sourceDoc = await fromUuid(checkbox.dataset.sourceUuid);
    const targetDoc = await fromUuid(checkbox.dataset.targetUuid);
    const source = sourceDoc?.object ?? sourceDoc;
    const target = targetDoc?.object ?? targetDoc;
    const auraIdentifier = checkbox.dataset.auraId;
    const suppressed = !!checkbox.checked;
    const previousSuppressed = !suppressed;
    const errorContext = {
      combatId: combat?.id ?? null,
      sourceUuid: checkbox.dataset.sourceUuid ?? null,
      targetUuid: checkbox.dataset.targetUuid ?? null,
      auraIdentifier,
    };

    if (!sourceDoc || !targetDoc || !normalizeAuraString(auraIdentifier)) {
      checkbox.checked = previousSuppressed;
      logDebug('invalid suppression payload in onTargetSuppressionChange', {
        ...errorContext,
        hasSourceDoc: !!sourceDoc,
        hasTargetDoc: !!targetDoc,
        hasAuraIdentifier: !!normalizeAuraString(auraIdentifier),
      });

      if (game.user?.isGM) {
        ui.notifications?.error('Aura-Unterdrückung: Quelle, Ziel oder Aura-ID fehlt.');
      }
      return;
    }

    try {
      await setAuraSuppression({ source, auraIdentifier, target, suppressed, combat });
      const verificationResult = await verifyAuraSuppressionState({
        source,
        auraIdentifier,
        target,
        suppressed,
        combat,
      });
      if (!verificationResult.success) {
        const suppressionKey = buildAuraSuppressionKey({ source, auraIdentifier, target });
        const legacySuppressionKey = buildLegacyAuraSuppressionKey({ source, auraIdentifier, target });
        checkbox.checked = previousSuppressed;
        console.error('[Aura Helper] aura suppression verification mismatch', {
          ...errorContext,
          expectedSuppressed: suppressed,
          verifiedSuppressed: verificationResult.verifiedSuppressed,
          attempts: verificationResult.attempt,
          suppressionKey,
          legacySuppressionKey,
        });
        logDebug('aura suppression verification mismatch', {
          ...errorContext,
          expectedSuppressed: suppressed,
          verifiedSuppressed: verificationResult.verifiedSuppressed,
          attempts: verificationResult.attempt,
          suppressionKey,
          legacySuppressionKey,
        });
        if (game.user?.isGM) {
          ui.notifications?.error('Aura-Unterdrückung konnte nicht verifiziert werden.');
        }
        return;
      }

      refreshAuraSuppressionMenu();
    } catch (error) {
      checkbox.checked = previousSuppressed;
      console.error('[Aura Helper] failed to update aura suppression', {
        ...errorContext,
        suppressed,
        error,
      });
      logDebug('failed to update aura suppression', {
        ...errorContext,
        suppressed,
        error,
      });

      if (game.user?.isGM) {
        ui.notifications?.error('Aura-Unterdrückung konnte nicht gespeichert werden.');
      }
      return;
    }

    logDebug('updated aura suppression', {
      ...errorContext,
      auraIdentifier,
      suppressed,
    });
  }
}

let auraSuppressionMenuApplication = null;

function refreshAuraSuppressionMenu() {
  if (!auraSuppressionMenuApplication?.rendered) return;
  auraSuppressionMenuApplication.render(false);
}

function openAuraSuppressionMenu() {
  if (!game.user?.isGM) return;

  auraSuppressionMenuApplication ??= new AuraSuppressionMenuApplication();
  auraSuppressionMenuApplication.render(true, { focus: true });
}

function addGmAuraControlsButton(_app, html) {
  if (!game.user?.isGM) return;

  const isV13 = Number(game.release?.generation ?? 0) >= 13;
  const existingControl = document.getElementById('pf2e-aura-helper-chat-control');
  if (existingControl) return;

  if (isV13) {
    const tabsFlexcol =
      document.getElementsByClassName('tabs')[0]?.getElementsByClassName('flexcol')[0];
    if (!tabsFlexcol) return;

    const buttonElement = document.createElement('button');
    buttonElement.type = 'button';
    buttonElement.className = 'pf2e-aura-helper-control';
    buttonElement.id = 'pf2e-aura-helper-chat-control';
    buttonElement.title = 'PF2e Aura Helper';

    const iconElement = document.createElement('i');
    iconElement.className = 'fas fa-circle-radiation';
    iconElement.setAttribute('aria-hidden', 'true');
    buttonElement.append(iconElement);

    buttonElement.onclick = (event) => {
      event.preventDefault();
      openAuraSuppressionMenu();
    };

    tabsFlexcol.append(buttonElement);
    return;
  }

  const htmlElement = html?.[0] ?? html;
  const chatControlLeft =
    htmlElement?.querySelector?.('.chat-control-icon') ??
    htmlElement?.find?.('.chat-control-icon')?.[0] ??
    document.getElementsByClassName('chat-control-icon')[0];
  if (!chatControlLeft) return;

  const buttonElement = document.createElement('a');
  buttonElement.className = 'chat-control-icon pf2e-aura-helper-control';
  buttonElement.id = 'pf2e-aura-helper-chat-control';
  buttonElement.title = 'PF2e Aura Helper';

  const iconElement = document.createElement('i');
  iconElement.className = 'fas fa-circle-radiation';
  iconElement.setAttribute('aria-hidden', 'true');
  buttonElement.append(iconElement);

  buttonElement.onclick = (event) => {
    event.preventDefault();
    openAuraSuppressionMenu();
  };

  chatControlLeft.insertBefore(buttonElement, chatControlLeft.firstElementChild);
}

Hooks.once('ready', () => {
  if (
    game.settings.get(MODULE_ID, SETTING_DEBUG_ENABLED) === true &&
    !isSettingExplicitlyConfigured(SETTING_LOG_LEVEL)
  ) {
    game.settings.set(MODULE_ID, SETTING_LOG_LEVEL, LOG_LEVELS.DEBUG);
  }

  const whisperToGm = shouldWhisperToGm();
  const activeChatChannel = whisperToGm ? 'GM-Whisper (nur Spielleitung)' : 'Öffentlicher Chat (alle Spieler)';

  logInfo(`Aktiver Chat-Kanal für Aura-Nachrichten: ${activeChatChannel}`);

  logInfo('Aura helper mode active', {
    chatOutput: activeChatChannel,
    auraFilter: shouldIncludeAlliedAuras() ? 'Feindliche + verbündete Auren' : 'Nur feindliche Auren',
    visibilityFilter: shouldRequireVisibleEnemies() ? 'aktiv' : 'inaktiv',
  });

  game.socket.on(`module.${MODULE_ID}`, handleIncomingAuraEvent);
});

Hooks.on('renderSceneNavigation', addGmAuraControlsButton);
Hooks.on('createCombat', refreshAuraSuppressionMenu);
Hooks.on('updateCombat', refreshAuraSuppressionMenu);
Hooks.on('deleteCombat', refreshAuraSuppressionMenu);
Hooks.on('createCombatant', refreshAuraSuppressionMenu);
Hooks.on('updateCombatant', refreshAuraSuppressionMenu);
Hooks.on('deleteCombatant', refreshAuraSuppressionMenu);
Hooks.on('createToken', refreshAuraSuppressionMenu);
Hooks.on('updateToken', refreshAuraSuppressionMenu);
Hooks.on('deleteToken', refreshAuraSuppressionMenu);

Hooks.once('init', () => {
  patchChatMessageUserAlias();

  game.settings.register(MODULE_ID, SETTING_DEBUG_ENABLED, {
    name: 'Enable debug logging (Legacy fallback)',
    hint: 'Legacy option used only if Log level has never been explicitly set.',
    scope: 'client',
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, SETTING_LOG_LEVEL, {
    name: 'Log level',
    hint: 'Controls how much PF2e Aura Helper writes to the browser console.',
    scope: 'client',
    config: true,
    type: String,
    choices: {
      [LOG_LEVELS.OFF]: 'Off',
      [LOG_LEVELS.INFO]: 'Info',
      [LOG_LEVELS.DEBUG]: 'Debug',
      [LOG_LEVELS.WINTER_SLEET]: 'Winter Sleet',
    },
    default: LOG_LEVELS.OFF,
  });

  game.settings.register(MODULE_ID, SETTING_REQUIRE_VISIBLE_ENEMIES, {
    name: 'Only trigger visible enemy auras',
    hint: 'If enabled, aura reminders trigger only for enemy tokens visible to the party.',
    scope: 'world',
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, SETTING_PUBLIC_CHAT_MESSAGES, {
    name: 'Post aura reminders in public chat (instead of GM whisper)',
    hint: 'If disabled, only GMs see aura reminders as a whisper.',
    scope: 'world',
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, SETTING_INCLUDE_ALLIED_AURAS, {
    name: 'Also check allied auras',
    hint: 'If enabled, aura reminders also trigger for allied tokens, not only enemies.',
    scope: 'world',
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, SETTING_DEBUG_AURA_TRAIT_SCAN, {
    name: 'Debug: Log NPC aura-trait scan at combat start',
    hint: 'When enabled (and log level is Debug), prints a structured list of NPC aura-trait items at combat start/first turn.',
    scope: 'world',
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, SETTING_AURA_DISTANCE_MODE, {
    name: 'Aura distance mode',
    hint: 'Chooses how aura distance is measured. "Edge" keeps current behavior, while the hybrid mode uses center distance for 1x1 tokens and edge distance for larger tokens.',
    scope: 'world',
    config: true,
    type: String,
    choices: {
      [AURA_DISTANCE_MODES.EDGE]: 'Edge (current behavior)',
      [AURA_DISTANCE_MODES.MEDIUM_CENTER_LARGE_EDGE]: 'Hybrid: 1x1 center, larger tokens edge',
      [AURA_DISTANCE_MODES.CENTER]: 'Center (diagnostic)',
    },
    default: AURA_DISTANCE_MODES.EDGE,
  });
});


function getClassDcFromActor(actor) {
  const classDC = Number(actor?.system?.attributes?.classDC?.value);
  if (!Number.isFinite(classDC)) return null;
  return classDC - 2;
}
function isResponsiblePosterForToken(token) {
  if (!token?.actor) return false;
  return isPrimaryActiveGm();
}

async function createWinterSleetChatMessage({ token, source, whisperToGm = false }) {
  if (!token?.actor || !source?.actor) return;
  if (!isResponsiblePosterForToken(token)) {
    logDebug('skip winter sleet chat message', {
      reason: 'emitter/poster mismatch',
      tokenId: token.id,
      tokenName: token.name,
      currentUserId: game.user.id,
      isPrimaryActiveGm: isPrimaryActiveGm(),
    });
    return;
  }
  const stance = source.actor.items.find((item) => item.slug === WINTER_SLEET_STANCE_SLUG);
  const sourceName = stance?.name ?? 'Winter Sleet';
  const sourceLink = stance?.uuid ? `@UUID[${stance.uuid}]{${sourceName}}` : sourceName;
  const dc = getClassDcFromActor(source.actor);
  const check = dc !== null ? `@Check[acrobatics|dc:${dc}]` : '@Check[acrobatics]';
  const content = `${token.name} bewegt sich in der Aura ${sourceLink} von ${source.name}: ${check}`;
  const speaker = ChatMessage.getSpeaker({ token: token.document, actor: token.actor });
  const delivery = getChatDeliveryTargets(whisperToGm);
  logDebug('creating winter sleet chat message', {
    channel: delivery.channel,
    recipients: delivery.recipients,
    tokenId: token.id,
    tokenName: token.name,
    sourceId: source.id,
    sourceName: source.name,
  });
  await ChatMessage.create({
    content,
    speaker,
    whisper: delivery.whisper,
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

function isCombatRelevantToken(token) {
  if (!token?.actor) return false;
  const isHidden = token.document?.hidden ?? false;
  const isDefeated = token.combatant?.isDefeated ?? token.combatant?.defeated ?? false;
  return !isHidden && !isDefeated;
}

function isPartyMemberActor(actor) {
  if (!actor) return false;
  const partyMembers = game.actors.party?.members ?? [];
  return partyMembers.some((member) => member.id === actor.id);
}

function getTokenRoleLabel(token) {
  return isPartyMemberActor(token?.actor) ? 'PC' : 'NPC';
}

function getTokenDisposition(token) {
  return token?.document?.disposition ?? token?.actor?.prototypeToken?.disposition ?? null;
}

function isEnemyTokenForAura(candidate, activeToken) {
  if (!candidate?.actor || !activeToken?.actor) return false;

  if (candidate.actor.isEnemyOf(activeToken.actor)) return true;

  const candidateAlliance = candidate.actor.alliance ?? null;
  const activeAlliance = activeToken.actor.alliance ?? null;
  if (candidateAlliance !== null && activeAlliance !== null) return false;

  const candidateDisposition = getTokenDisposition(candidate);
  const activeDisposition = getTokenDisposition(activeToken);
  if (candidateDisposition === null || activeDisposition === null) return false;

  return candidateDisposition !== activeDisposition;
}

function getStandardAuraSources(activeToken) {
  if (!activeToken?.actor) return [];

  const isActivePartyMember = isPartyMemberActor(activeToken.actor);
  const requireVisibleEnemies = shouldRequireVisibleEnemies();
  const includeAlliedAuras = shouldIncludeAlliedAuras();
  return canvas.tokens.placeables.filter((candidate) => {
    if (!isCombatRelevantToken(candidate)) return false;
    const isEnemyAura = isEnemyTokenForAura(candidate, activeToken);
    if (!isEnemyAura && !includeAlliedAuras) return false;

    if (requireVisibleEnemies && isActivePartyMember && isEnemyAura) {
      return isVisibleToParty(candidate);
    }

    return true;
  });
}

function getStandardAuraChecks(activeToken) {
  const sources = getStandardAuraSources(activeToken);
  const checks = [];

  const auraContainerCandidates = [
    { key: 'actor.auras', resolver: (source) => source.actor?.auras },
    { key: 'token.document.actor.auras', resolver: (source) => source.document?.actor?.auras },
    { key: 'token.document.auras', resolver: (source) => source.document?.auras },
    { key: 'token.auras', resolver: (source) => source.auras },
  ];

  const getSourceContainerAuras = (source) => {
    const primaryAuraEntries = getAuraEntriesFromContainer(source.actor?.auras);
    if (primaryAuraEntries.length > 0) {
      return [{ containerKey: 'actor.auras', auraEntries: primaryAuraEntries }];
    }

    const fallbackContainers = [];
    for (const candidate of auraContainerCandidates) {
      if (candidate.key === 'actor.auras') continue;
      const auraEntries = getAuraEntriesFromContainer(candidate.resolver(source));
      if (auraEntries.length === 0) continue;
      fallbackContainers.push({ containerKey: candidate.key, auraEntries });
    }

    return fallbackContainers;
  };

  for (const source of sources) {
    const auraContainers = getSourceContainerAuras(source);
    const realAuraIds = new Set();
    logDebug('resolved aura containers for source', {
      sourceId: source.id,
      sourceName: source.name,
      containers: auraContainers.map(({ containerKey, auraEntries }) => ({
        container: containerKey,
        auraCount: auraEntries.length,
      })),
    });

    for (const { containerKey, auraEntries } of auraContainers) {
      for (const [containerAuraKey, aura] of auraEntries) {
        const auraIdentifier = buildAuraIdentifier(aura, containerAuraKey);
        if (!auraIdentifier) {
          logDebug('skip invalid aura object', {
            sourceId: source.id,
            sourceName: source.name,
            container: containerKey,
            containerAuraKey,
            aura,
          });
          continue;
        }

        checks.push({ source, aura, auraIdentifier });
        realAuraIds.add(auraIdentifier);
        const auraSlug = normalizeAuraString(aura?.slug);
        if (auraSlug) realAuraIds.add(auraSlug);
        logDebug('queued aura check', {
          sourceId: source.id,
          sourceName: source.name,
          container: containerKey,
          containerAuraKey,
          auraSlug: aura.slug,
          auraIdentifier,
        });
      }
    }

    for (const item of getNpcAuraTraitItems(source)) {
      const auraRules = (item.system?.rules ?? []).filter(
        (rule) => String(rule?.key ?? '').toLowerCase() === 'aura'
      );
      const matchingRuleSlug = auraRules
        .map((rule) => normalizeAuraString(rule?.slug))
        .find((slug) => slug && realAuraIds.has(slug));
      const itemSlug = normalizeAuraString(item.slug);
      const skipForRealAura = !!matchingRuleSlug || (itemSlug ? realAuraIds.has(itemSlug) : false);
      if (skipForRealAura) {
        logDebug('skip trait-item aura check due to existing real aura', {
          sourceId: source.id,
          sourceName: source.name,
          itemId: item.id,
          itemName: item.name,
          matchingRuleSlug: matchingRuleSlug ?? null,
          itemSlug: itemSlug ?? null,
        });
        continue;
      }

      const traitAura = buildTraitAuraFromItem(item);
      const auraIdentifier = `trait-item:${item.uuid}`;
      checks.push({ source, aura: traitAura, auraIdentifier, originItem: item, diagnosticOnly: traitAura.__diagnosticOnly });
      logDebug('queued trait-item aura check', {
        sourceId: source.id,
        sourceName: source.name,
        itemId: item.id,
        itemName: item.name,
        auraIdentifier,
        diagnosticOnly: traitAura.__diagnosticOnly,
        radius: traitAura.radius,
      });
    }
  }

  return checks;
}

function isTokenInsideAura(aura, source, tokenLike) {
  if (!aura || !source || !tokenLike) return false;

  const tokenDocument = tokenLike.document ?? tokenLike;
  const rangeCheck = getAuraRangeCheck(aura, source, tokenLike, {
    mode: getAuraDistanceMode(),
    onContainsTokenError: (error, failedTokenDocument) => {
      logDebug('aura.containsToken failed; falling back to distance mode evaluation', {
        aura,
        tokenId: failedTokenDocument?.id ?? null,
        tokenName: failedTokenDocument?.name ?? null,
        error: error?.message ?? String(error),
      });
    },
  });

  logDebug('aura distance evaluation', {
    auraSlug: aura?.slug ?? null,
    auraRadius: rangeCheck.radius,
    containsTokenResult: rangeCheck.containsTokenResult,
    modeApplied: rangeCheck.modeApplied,
    centerDistance: rangeCheck.centerDistance,
    edgeDistance: rangeCheck.edgeDistance,
    sourceId: source?.id ?? source?.document?.id ?? null,
    tokenId: tokenDocument?.id ?? null,
    inside: rangeCheck.inRange,
  });

  return rangeCheck.inRange;
}

function getCurrentStandardAuraHits(token) {
  const auraChecks = getStandardAuraChecks(token);
  const hits = [];

  for (const { source, aura, auraIdentifier, originItem, diagnosticOnly } of auraChecks) {
    if (diagnosticOnly) {
      logDebug('diagnostic trait-based aura found without usable geometry', {
        sourceId: source.id,
        sourceName: source.name,
        auraIdentifier,
        itemId: originItem?.id ?? null,
        itemName: originItem?.name ?? null,
      });
      continue;
    }
    if (!isTokenInsideAura(aura, source, token)) continue;
    const auraKey = `${source.id}-${auraIdentifier}`;
    hits.push({ auraKey, source, aura, auraIdentifier, originItem });
  }

  return hits;
}

function gmIds() {
  return game.users.filter((u) => u.isGM).map((u) => u.id);
}

function isEmitterForTokenChange(token, userId) {
  if (!token?.actor) return false;

  if (userId !== undefined && userId !== null) {
    return userId === game.user.id;
  }

  return isPrimaryActiveGm();
}

function shouldEmitFromMoveTokenHook() {
  if (game.user.isGM) return isPrimaryActiveGm();
  const hasActiveGm = game.users.some((user) => user.isGM && user.active);
  return !hasActiveGm;
}

function getMovementEventSequence(tokenId, movement, operation) {
  return (
    operation?.id ??
    operation?._id ??
    movement?.id ??
    movement?._id ??
    movement?.operationId ??
    nextTokenMovementSequence(tokenId)
  );
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

async function handleAura({ token, enemy, aura, auraIdentifier, originItem: providedOriginItem = null, message, whisperToGm = false }) {
  if (!isResponsiblePosterForToken(token)) {
    logDebug('skip standard aura chat message', {
      reason: 'emitter/poster mismatch',
      tokenId: token?.id ?? null,
      tokenName: token?.name ?? null,
      currentUserId: game.user.id,
      isPrimaryActiveGm: isPrimaryActiveGm(),
    });
    return;
  }
  const effect = aura.effects?.[0];
  logDebug('aura effect', effect);

  const findEnemyItemBySlug = (slug) => {
    if (!slug) return null;
    return (
      enemy.actor.items.find((i) => i.slug === slug || i.system?.slug === slug) ?? null
    );
  };

  const getAuraSourceOriginUuid = () => {
    const directAura =
      enemy.actor.auras?.get?.(aura.slug) ??
      (auraIdentifier ? enemy.actor.auras?.get?.(auraIdentifier) : null) ??
      null;

    const directAuraEffect = directAura?.effects?.[0];
    if (directAuraEffect) {
      const directAuraOriginUuid =
        directAuraEffect.origin ??
        directAuraEffect.sourceId ??
        directAuraEffect.system?.context?.origin?.uuid ??
        null;
      if (directAuraOriginUuid) return directAuraOriginUuid;
    }

    const effectOrigin =
      enemy.actor.itemTypes?.effect
        ?.find((actorEffect) => {
          const effectSlug = actorEffect.slug ?? actorEffect.system?.slug;
          return effectSlug === aura.slug || effectSlug === auraIdentifier;
        })
        ?.getFlag?.('pf2e', 'origin') ??
      enemy.actor.itemTypes?.effect
        ?.find((actorEffect) => {
          const effectSlug = actorEffect.slug ?? actorEffect.system?.slug;
          return effectSlug === aura.slug || effectSlug === auraIdentifier;
        })?.system?.context?.origin?.uuid ??
      null;

    if (effectOrigin) return effectOrigin;

    return (
      enemy.actor.flags?.pf2e?.auras?.[aura.slug]?.origin ??
      (auraIdentifier ? enemy.actor.flags?.pf2e?.auras?.[auraIdentifier]?.origin : null) ??
      null
    );
  };

  let originUuid =
    effect?.origin ??
    effect?.sourceId ??
    effect?.system?.context?.origin?.uuid ??
    null;
  let originItem = providedOriginItem;
  let matchedBy = null;
  if (!originUuid && originItem) {
    originUuid = originItem.uuid ?? null;
  }

  if (!originUuid) {
    if (auraIdentifier) {
      originItem = findEnemyItemBySlug(auraIdentifier);
      logDebug('searched enemy items by fallback identifier', {
        auraIdentifier,
        item: originItem,
      });
      if (originItem) matchedBy = 'identifier';
    }

    if (!originItem) {
      originItem = findEnemyItemBySlug(aura.slug);
      if (originItem) matchedBy = 'slug';
    }

    logDebug('searched enemy items by slug', {
      slug: aura.slug,
      item: originItem,
    });

    if (!originItem) {
      const mappedSlugs = [
        ...(AURA_ITEM_SLUG_MAPPINGS[aura.slug] ?? []),
        ...(auraIdentifier ? AURA_ITEM_SLUG_MAPPINGS[auraIdentifier] ?? [] : []),
      ];
      for (const mappedSlug of mappedSlugs) {
        originItem = findEnemyItemBySlug(mappedSlug);
        if (originItem) {
          matchedBy = 'mapping';
          break;
        }
      }
      logDebug('searched enemy items by mapping', {
        auraSlug: aura.slug,
        auraIdentifier,
        mappedSlugs,
        item: originItem,
      });
    }

    if (!originItem) {
      const fallbackSlug = aura.slug ?? auraIdentifier ?? 'unknown-aura';
      const searchName = effect?.name ?? fallbackSlug.replace(/-/g, ' ');
      originItem = enemy.actor.items.find(
        (i) => i.name.toLowerCase() === searchName.toLowerCase()
      );
      if (originItem) matchedBy = 'name';
      logDebug('searched enemy items by name', {
        search: searchName,
        item: originItem,
      });
    }

    originUuid = originItem?.uuid ?? null;

    if (!originUuid) {
      originUuid = getAuraSourceOriginUuid();
      if (originUuid) matchedBy = 'effectOrigin';
    }

    if (!originItem) {
      console.warn('[Aura Helper] no matching item found for aura', {
        aura: aura.slug,
        auraIdentifier,
        enemy: enemy.name,
      });
    }
  }

  if (!originItem && originUuid) {
    originItem = await fromUuid(originUuid);
  }

  if (originItem && !originUuid) {
    originUuid = originItem.uuid ?? null;
  }

  const resolvedMatchPath = matchedBy ?? (originUuid ? 'effectOrigin' : null);
  logDebug('resolved aura origin', {
    auraSlug: aura.slug,
    auraIdentifier,
    originUuid,
    originItemId: originItem?.id ?? null,
    originItemName: originItem?.name ?? null,
    matchedBy: resolvedMatchPath,
  });
  const origin = originItem ?? (originUuid ? await fromUuid(originUuid) : null);
  const auraName = origin?.name ?? aura.slug ?? auraIdentifier ?? 'Unbekannte Aura';
  const auraLink = originUuid ? `@UUID[${originUuid}]{${auraName}}` : auraName;
  const content = appendNymphsGraceSavePrompt(message(auraLink), {
    aura,
    origin,
    sourceActor: enemy.actor,
  });
  logDebug('creating chat message', content);
  const speaker = ChatMessage.getSpeaker({
    token: token.document,
    actor: token.actor,
  });
  const delivery = getChatDeliveryTargets(whisperToGm);
  logDebug('chat delivery target', {
    channel: delivery.channel,
    recipients: delivery.recipients,
    tokenId: token.id,
    tokenName: token.name,
    sourceId: enemy.id,
    sourceName: enemy.name,
    auraSlug: aura.slug,
    auraIdentifier,
  });
  await ChatMessage.create({
    content,
    speaker,
    whisper: delivery.whisper,
  });
  if (!origin) {
    console.warn('[Aura Helper] no item to post for aura', {
      aura: aura.slug,
      auraIdentifier,
      enemy: enemy.name,
    });
  }
}

async function checkAllCurrentAuraOccupancy({ eventKind = AURA_EVENT_KINDS.ENTER } = {}) {
  const tokens = canvas.tokens?.placeables ?? [];
  if (tokens.length === 0) return;

  const activeCombatTokenId = game.combat?.combatant?.tokenId ?? null;
  for (const token of tokens) {
    if (!isCombatRelevantToken(token)) continue;

    const currentHits = getCurrentStandardAuraHits(token);
    const currentSet = new Set(currentHits.map(({ auraKey }) => auraKey));
    wasInAura.set(token.id, currentSet);

    if (eventKind === AURA_EVENT_KINDS.START_TURN && token.id !== activeCombatTokenId) continue;

    for (const { source, aura, auraIdentifier } of currentHits) {
      emitAuraEvent({
        type: AURA_EVENT_TYPE,
        eventKind,
        tokenId: token.id,
        enemyId: source.id,
        auraSlug: aura.slug ?? auraIdentifier,
        auraIdentifier,
        combatId: game.combat?.id ?? null,
        round: game.combat?.round ?? 0,
        turn: game.combat?.turn ?? 0,
      });
    }
  }
}

Hooks.on('pf2e.startTurn', async (combatant) => {
  logCombatNpcAuraTraitSummaryOnce(game.combat, 'pf2e.startTurn');

  const token = combatant.token?.object ?? combatant.token;
  const activeCombatant = game.combat?.combatant ?? null;
  const activeTokenId = activeCombatant?.tokenId ?? activeCombatant?.token?.id ?? null;
  if (!token?.id || !activeTokenId || token.id !== activeTokenId) {
    logDebug('skip start-turn hook for non-active token', {
      hookTokenId: token?.id ?? null,
      activeTokenId,
      combatantId: combatant?.id ?? null,
      activeCombatantId: activeCombatant?.id ?? null,
    });
    return;
  }

  logDebug('hook entry', {
    hookType: 'pf2e.startTurn',
    tokenName: token?.name ?? null,
    userId: null,
    isGM: game.user.isGM,
  });
  const isEmitter = isPrimaryActiveGm();
  logDebug('emitter check', {
    hookType: 'startTurn',
    userId: game.user.id,
    userName: game.user.name,
    isGm: game.user.isGM,
    tokenId: token?.id ?? null,
    tokenName: token?.name ?? null,
    isEmitterForTokenChange: isEmitter,
  });
  if (!isEmitter) {
    logDebug('skip emit: emitter selection denied', {
      hookType: 'pf2e.startTurn',
      reason: 'Current client is not selected start-turn emitter',
      tokenId: token?.id ?? null,
      tokenName: token?.name ?? null,
    });
    return;
  }
  const currentHits = getCurrentStandardAuraHits(token);
  const currentSet = new Set(currentHits.map(({ auraKey }) => auraKey));

  const roleLabel = getTokenRoleLabel(token);
  logDebug(`${roleLabel} ${token?.name ?? 'Unbekannt'} ist am Zug.`);
  if (currentHits.length > 0) {
    const auraSummaries = currentHits.map(({ source, aura, auraIdentifier }) => `${aura.slug ?? auraIdentifier} (${auraIdentifier}) von ${source.name}`);
    logDebug(
      `${roleLabel} ${token?.name ?? 'Unbekannt'} steht in den folgenden Auren von folgenden Tokens: ${auraSummaries.join(', ')}`
    );
  } else {
    logDebug(`${roleLabel} ${token?.name ?? 'Unbekannt'} steht in keinen Auren.`);
  }

  logDebug(
    'standard aura sources in scene',
    currentHits.map(({ source, aura, auraIdentifier }) => `${source.name}:${aura.slug ?? auraIdentifier} (${auraIdentifier})`)
  );

  for (const { source, aura, auraIdentifier } of currentHits) {
    const inside = isTokenInsideAura(aura, source, token);
    logDebug('evaluating aura', {
      source: source.name,
      aura: aura.slug,
      inside,
    });
    if (!inside) continue;
    const round = game.combat?.round ?? 0;
    const turn = game.combat?.turn ?? 0;
    logDebug('Aura detected (start-turn)', {
      tokenId: token.id,
      tokenName: token.name,
      sourceId: source.id,
      sourceName: source.name,
      auraSlug: aura.slug,
      auraIdentifier,
      inside,
      round,
      turn,
    });
    emitAuraEvent({
      type: AURA_EVENT_TYPE,
      eventKind: AURA_EVENT_KINDS.START_TURN,
      tokenId: token.id,
      enemyId: source.id,
      auraSlug: aura.slug ?? auraIdentifier,
      auraIdentifier,
      combatId: game.combat?.id ?? null,
      round,
      turn,
    });
  }

  wasInAura.set(token.id, currentSet);

});

Hooks.on('combatStart', (combat) => {
  logCombatNpcAuraTraitSummaryOnce(combat, 'combatStart');
});

Hooks.on('deleteCombat', (combat) => {
  if (!combat?.id) return;
  loggedAuraTraitScanByCombat.delete(combat.id);
});

Hooks.on('updateToken', async (tokenDoc, change, _options, userId) => {
  const token = tokenDoc.object;
  logDebug('hook entry', {
    hookType: 'updateToken',
    tokenName: token?.name ?? null,
    userId: userId ?? null,
    isGM: game.user.isGM,
  });
  if (change.x === undefined && change.y === undefined) return;
  if (!token) return;
  const isEmitter = isEmitterForTokenChange(token, userId);
  logDebug('emitter check', {
    hookType: 'updateToken',
    userId: game.user.id,
    userName: game.user.name,
    isGm: game.user.isGM,
    hookUserId: userId ?? null,
    tokenId: token?.id ?? null,
    tokenName: token?.name ?? null,
    isEmitterForTokenChange: isEmitter,
  });
  if (!isEmitter) {
    logDebug('skip emit: emitter selection denied', {
      hookType: 'updateToken',
      reason: 'Current client is not selected emitter',
      tokenId: token?.id ?? null,
      tokenName: token?.name ?? null,
      hookUserId: userId ?? null,
    });
    return;
  }
  const movementSequence = nextTokenMovementSequence(token.id);

  const winterSleetSources = getWinterSleetSources();
  if (winterSleetSources.length === 0) return;

  if (token._movement) {
    let startMap = movementStarts.get(token.id);
    if (!startMap) {
      startMap = new Map();
      movementStarts.set(token.id, startMap);
    }
    const movementStartDocument = getDocumentAtMovementStart(token) ?? token.document;
    const wsOccupancyMap = currentAuraOccupancy.get(token.id) ?? new Map();

    for (const source of winterSleetSources) {
      if (!source.actor?.isEnemyOf(token.actor)) continue;
      const aura = source.actor.auras?.get(WINTER_SLEET_AURA_SLUG);
      if (!aura) continue;
      const key = `${source.id}-winter-sleet`;
      const startedInside = isTokenInsideAura(aura, source, movementStartDocument);
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
    const isInside = isTokenInsideAura(aura, source, token);
    const shouldTrigger =
      (!previousInside && isInside) ||
      (WINTER_SLEET_TRIGGER_ON_MOVE_WITHIN && previousInside && isInside);

    if (shouldTrigger) {
      emitAuraEvent({
        type: AURA_EVENT_TYPE,
        eventKind: AURA_EVENT_KINDS.WINTER_SLEET,
        tokenId: token.id,
        enemyId: source.id,
        auraSlug: WINTER_SLEET_AURA_SLUG,
        auraIdentifier: WINTER_SLEET_AURA_SLUG,
        combatId: game.combat?.id ?? null,
        round: game.combat?.round ?? 0,
        turn: game.combat?.turn ?? 0,
        eventSequence: movementSequence,
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

Hooks.on('moveToken', (token, movement, operation) => {
  if (!token?.actor) return;

  logDebug('hook entry', {
    hookType: 'moveToken',
    tokenName: token?.name ?? null,
    isGM: game.user.isGM,
  });

  const isEmitter = shouldEmitFromMoveTokenHook();
  logDebug('emitter check', {
    hookType: 'moveToken',
    userId: game.user.id,
    userName: game.user.name,
    isGm: game.user.isGM,
    tokenId: token?.id ?? null,
    tokenName: token?.name ?? null,
    isEmitterForMoveToken: isEmitter,
  });
  if (!isEmitter) return;

  const currentHits = getCurrentStandardAuraHits(token);
  const currentSet = new Set(currentHits.map((hit) => hit.auraKey));
  const prevSet = wasInAura.get(token.id) ?? new Set();
  const entered = [...currentSet].filter((auraKey) => !prevSet.has(auraKey));
  logDebug('moveToken aura diff', {
    tokenId: token.id,
    tokenName: token.name,
    prevSetSize: prevSet.size,
    currentSetSize: currentSet.size,
    entered,
  });

  if (entered.length > 0) {
    const currentByKey = new Map(currentHits.map((hit) => [hit.auraKey, hit]));
    const movementSequence = getMovementEventSequence(token.id, movement, operation);

    for (const auraKey of entered) {
      const hit = currentByKey.get(auraKey);
      if (!hit) continue;

      const { source, aura, auraIdentifier } = hit;
      const round = game.combat?.round ?? 0;
      const turn = game.combat?.turn ?? 0;

      emitAuraEvent({
        type: AURA_EVENT_TYPE,
        eventKind: AURA_EVENT_KINDS.ENTER,
        tokenId: token.id,
        enemyId: source.id,
        auraSlug: aura.slug ?? auraIdentifier,
        auraIdentifier,
        combatId: game.combat?.id ?? null,
        round,
        turn,
        eventSequence: movementSequence,
      });
    }
  }

  wasInAura.set(token.id, currentSet);
});

Hooks.on('deleteToken', (tokenDoc) => {
  movementStarts.delete(tokenDoc.id);
  currentAuraOccupancy.delete(tokenDoc.id);
  wasInAura.delete(tokenDoc.id);
  tokenMovementSequence.delete(tokenDoc.id);
});

Hooks.on('canvasReady', async () => {
  movementStarts.clear();
  currentAuraOccupancy.clear();
  wasInAura.clear();
  tokenMovementSequence.clear();
  await checkAllCurrentAuraOccupancy({ eventKind: AURA_EVENT_KINDS.START_TURN });
});
