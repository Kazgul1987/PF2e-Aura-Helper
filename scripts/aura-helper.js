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
const WINTER_SLEET_TRIGGER_ON_MOVE_WITHIN = true;
const SETTING_DEBUG_ENABLED = 'debugEnabled';
const SETTING_LOG_LEVEL = 'logLevel';
const SETTING_REQUIRE_VISIBLE_ENEMIES = 'requireVisibleEnemies';
const SETTING_PUBLIC_CHAT_MESSAGES = 'publicChatMessages';
const SETTING_INCLUDE_ALLIED_AURAS = 'includeAlliedAuras';
const SETTING_DEBUG_AURA_TRAIT_SCAN = 'debugAuraTraitScan';
const COMBAT_SUPPRESSION_FLAG_KEY = 'suppressedAuras';
const SETTINGS_KEY_PREFIX = `${MODULE_ID}.`;
const LOG_LEVELS = {
  OFF: 'off',
  INFO: 'info',
  DEBUG: 'debug',
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
  if (getLogLevel() !== LOG_LEVELS.DEBUG) return;
  console.debug('[Aura Helper]', ...args);
}

function logInfo(...args) {
  const logLevel = getLogLevel();
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

function buildAuraSuppressionKey({ source, auraIdentifier, target }) {
  const sourceUuid = getTokenUuid(source);
  const targetUuid = getTokenUuid(target);
  const normalizedAuraIdentifier = normalizeAuraString(auraIdentifier);
  if (!sourceUuid || !targetUuid || !normalizedAuraIdentifier) return null;
  return `${sourceUuid}|${normalizedAuraIdentifier}|${targetUuid}`;
}

function getCombatAuraSuppressionMap(combat = game.combat) {
  if (!combat) return {};
  const suppressionMap = combat.getFlag(MODULE_ID, COMBAT_SUPPRESSION_FLAG_KEY);
  if (!suppressionMap || typeof suppressionMap !== 'object') return {};
  return suppressionMap;
}

function isAuraSuppressed({ source, auraIdentifier, target, combat = game.combat }) {
  const suppressionKey = buildAuraSuppressionKey({ source, auraIdentifier, target });
  if (!suppressionKey) return false;
  const suppressionMap = getCombatAuraSuppressionMap(combat);
  return suppressionMap[suppressionKey] === true;
}

async function setAuraSuppression({ source, auraIdentifier, target, suppressed, combat = game.combat }) {
  if (!combat) return;
  const suppressionKey = buildAuraSuppressionKey({ source, auraIdentifier, target });
  if (!suppressionKey) return;

  const suppressionMap = { ...getCombatAuraSuppressionMap(combat) };
  if (suppressed) {
    suppressionMap[suppressionKey] = true;
    await combat.setFlag(MODULE_ID, COMBAT_SUPPRESSION_FLAG_KEY, suppressionMap);
    return;
  }

  delete suppressionMap[suppressionKey];
  if (Object.keys(suppressionMap).length === 0) {
    await combat.unsetFlag(MODULE_ID, COMBAT_SUPPRESSION_FLAG_KEY);
    return;
  }
  await combat.setFlag(MODULE_ID, COMBAT_SUPPRESSION_FLAG_KEY, suppressionMap);
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

function getAuraSuppressionMenuData(combat = game.combat) {
  if (!combat) {
    return {
      hasCombat: false,
      sources: [],
    };
  }

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
    return getAuraSuppressionMenuData(game.combat);
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

    await setAuraSuppression({ source, auraIdentifier, target, suppressed, combat });
    logDebug('updated aura suppression', {
      combatId: combat?.id ?? null,
      sourceUuid: checkbox.dataset.sourceUuid ?? null,
      targetUuid: checkbox.dataset.targetUuid ?? null,
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

function registerGmAuraControlsButton(controls) {
  if (!game.user?.isGM) return;

  const preferredControlNames = ['token', 'measure'];
  const targetControl =
    preferredControlNames.map((name) => controls.find((control) => control.name === name)).find(Boolean) ??
    controls.find((control) => Array.isArray(control.tools));

  if (!targetControl) {
    logDebug('Could not register PF2e Aura Helper control button: no target scene control found.', {
      availableControls: controls.map((control) => control.name),
    });
    return;
  }

  targetControl.tools ??= [];

  if (targetControl.tools.some((tool) => tool.name === 'pf2e-aura-helper')) return;

  targetControl.tools.push({
    name: 'pf2e-aura-helper',
    title: 'PF2e Aura Helper',
    icon: 'fas fa-circle-radiation',
    button: true,
    onClick: () => openAuraSuppressionMenu(),
    visible: game.user.isGM,
  });
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

Hooks.on('getSceneControlButtons', registerGmAuraControlsButton);
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

function getCenterForTokenLike(tokenLike) {
  if (!tokenLike) return null;
  if (tokenLike.center) return tokenLike.center;

  const document = tokenLike.document ?? tokenLike;
  if (document?.x === undefined || document?.y === undefined) return null;

  const gridSize = canvas.grid?.size ?? 1;
  const width = (document.width ?? tokenLike.w ?? 1) * gridSize;
  const height = (document.height ?? tokenLike.h ?? 1) * gridSize;
  return {
    x: document.x + width / 2,
    y: document.y + height / 2,
  };
}

function getTokenBaseRadiusInGridUnits(tokenLike) {
  if (!tokenLike) return 0;

  const document = tokenLike.document ?? tokenLike;
  const gridSizePx = canvas.grid?.size;
  if (!gridSizePx) return 0;

  const widthSquares = Number(document.width ?? tokenLike.w ?? 1);
  const heightSquares = Number(document.height ?? tokenLike.h ?? 1);
  if (!Number.isFinite(widthSquares) || !Number.isFinite(heightSquares)) return 0;

  const widthPx = widthSquares * gridSizePx;
  const heightPx = heightSquares * gridSizePx;
  const baseRadiusPx = Math.max(widthPx, heightPx) / 2;
  return canvas.grid.measureDistance({ x: 0, y: 0 }, { x: baseRadiusPx, y: 0 });
}

function safeContainsToken(aura, tokenDocument) {
  if (typeof aura?.containsToken !== 'function' || !tokenDocument) return null;

  try {
    return !!aura.containsToken(tokenDocument);
  } catch (error) {
    logDebug('aura.containsToken failed; falling back to edge distance', {
      aura,
      tokenId: tokenDocument.id ?? null,
      tokenName: tokenDocument.name ?? null,
      error: error?.message ?? String(error),
    });
    return null;
  }
}

function isTokenInsideAura(aura, source, tokenLike) {
  if (!aura || !source || !tokenLike) return false;

  const tokenDocument = tokenLike.document ?? tokenLike;
  const containsTokenResult = safeContainsToken(aura, tokenDocument);
  if (containsTokenResult === true) {
    return true;
  }

  const auraRadius = Number(aura.radius);
  const tokenCenter = getCenterForTokenLike(tokenLike);
  const sourceCenter = getCenterForTokenLike(source);
  if (Number.isFinite(auraRadius) && tokenCenter && sourceCenter) {
    const centerDistance = canvas.grid.measureDistance(tokenCenter, sourceCenter);
    const sourceBaseRadiusGrid = getTokenBaseRadiusInGridUnits(source);
    const targetBaseRadiusGrid = getTokenBaseRadiusInGridUnits(tokenLike);
    const edgeDistance = Math.max(0, centerDistance - sourceBaseRadiusGrid - targetBaseRadiusGrid);
    return edgeDistance <= auraRadius;
  }

  return false;
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
  let originUuid =
    effect?.origin ??
    effect?.sourceId ??
    effect?.system?.context?.origin?.uuid ??
    null;
  let originItem = providedOriginItem;
  if (!originUuid && originItem) {
    originUuid = originItem.uuid ?? null;
  }

  if (!originUuid) {
    originItem = enemy.actor.items.find((i) => i.slug === aura.slug) ?? null;
    if (!originItem && auraIdentifier) {
      originItem = enemy.actor.items.find((i) => i.slug === auraIdentifier) ?? null;
      logDebug('searched enemy items by fallback identifier', {
        auraIdentifier,
        item: originItem,
      });
    }
    logDebug('searched enemy items by slug', {
      slug: aura.slug,
      item: originItem,
    });
    if (!originItem) {
      const fallbackSlug = aura.slug ?? auraIdentifier ?? 'unknown-aura';
      const searchName = effect?.name ?? fallbackSlug.replace(/-/g, ' ');
      originItem = enemy.actor.items.find(
        (i) => i.name.toLowerCase() === searchName.toLowerCase()
      );
      logDebug('searched enemy items by name', {
        search: searchName,
        item: originItem,
      });
    }
    originUuid = originItem?.uuid ?? null;
    if (!originItem) {
      console.warn('[Aura Helper] no matching item found for aura', {
        aura: aura.slug,
        auraIdentifier,
        enemy: enemy.name,
      });
    }
  }
  logDebug('resolved originUuid', originUuid);
  const origin = originItem ?? (originUuid ? await fromUuid(originUuid) : null);
  const auraName = origin?.name ?? aura.slug ?? auraIdentifier ?? 'Unbekannte Aura';
  const auraLink = originUuid ? `@UUID[${originUuid}]{${auraName}}` : auraName;
  const content = message(auraLink);
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
