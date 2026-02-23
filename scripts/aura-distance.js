export const MODULE_ID = 'pf2e-aura-helper';
export const SETTING_AURA_DISTANCE_MODE = 'auraDistanceMode';

export const AURA_DISTANCE_MODES = {
  EDGE: 'edge',
  MEDIUM_CENTER_LARGE_EDGE: 'medium-center-large-edge',
  CENTER: 'center',
};

const AURA_DISTANCE_EPSILON = 0.01;

function isWithinAura(distance, auraRadius) {
  if (!Number.isFinite(distance) || !Number.isFinite(auraRadius)) return false;
  return distance <= auraRadius + AURA_DISTANCE_EPSILON;
}

export function getAuraDistanceMode() {
  const configuredMode = game.settings.get(MODULE_ID, SETTING_AURA_DISTANCE_MODE);
  if (Object.values(AURA_DISTANCE_MODES).includes(configuredMode)) {
    return configuredMode;
  }
  return AURA_DISTANCE_MODES.EDGE;
}

function getTokenDimensionsInSquares(tokenLike) {
  const document = tokenLike?.document ?? tokenLike;
  const widthSquares = Number(document?.width ?? tokenLike?.w ?? 1);
  const heightSquares = Number(document?.height ?? tokenLike?.h ?? 1);
  const safeWidth = Number.isFinite(widthSquares) ? widthSquares : 1;
  const safeHeight = Number.isFinite(heightSquares) ? heightSquares : 1;

  return {
    isSingleSquare: safeWidth <= 1 && safeHeight <= 1,
  };
}

function evaluateAuraDistanceMode({ auraRadius, centerDistance, edgeDistance, source, tokenLike, mode }) {
  const sourceDimensions = getTokenDimensionsInSquares(source);
  const targetDimensions = getTokenDimensionsInSquares(tokenLike);
  const bothSingleSquare = sourceDimensions.isSingleSquare && targetDimensions.isSingleSquare;

  if (mode === AURA_DISTANCE_MODES.CENTER) {
    return { modeApplied: mode, distance: centerDistance, withinAura: isWithinAura(centerDistance, auraRadius) };
  }

  if (mode === AURA_DISTANCE_MODES.MEDIUM_CENTER_LARGE_EDGE && bothSingleSquare) {
    return {
      modeApplied: `${mode}:center`,
      distance: centerDistance,
      withinAura: isWithinAura(centerDistance, auraRadius),
    };
  }

  return {
    modeApplied: mode === AURA_DISTANCE_MODES.MEDIUM_CENTER_LARGE_EDGE ? `${mode}:edge` : AURA_DISTANCE_MODES.EDGE,
    distance: edgeDistance,
    withinAura: isWithinAura(edgeDistance, auraRadius),
  };
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

function safeContainsToken(aura, tokenDocument, onContainsTokenError) {
  if (typeof aura?.containsToken !== 'function' || !tokenDocument) return null;

  try {
    return !!aura.containsToken(tokenDocument);
  } catch (error) {
    if (typeof onContainsTokenError === 'function') {
      onContainsTokenError(error, tokenDocument);
    }
    return null;
  }
}

export function getAuraRangeCheck(aura, source, tokenLike, { mode = getAuraDistanceMode(), onContainsTokenError } = {}) {
  if (!aura || !source || !tokenLike) {
    return {
      distance: null,
      centerDistance: null,
      edgeDistance: null,
      radius: null,
      modeApplied: null,
      inRange: false,
      usedContainsToken: false,
      containsTokenResult: null,
    };
  }

  const tokenDocument = tokenLike.document ?? tokenLike;
  const containsTokenResult = safeContainsToken(aura, tokenDocument, onContainsTokenError);
  if (containsTokenResult === true) {
    return {
      distance: null,
      centerDistance: null,
      edgeDistance: null,
      radius: Number.isFinite(Number(aura.radius)) ? Number(aura.radius) : null,
      modeApplied: 'containsToken',
      inRange: true,
      usedContainsToken: true,
      containsTokenResult,
    };
  }

  const auraRadius = Number(aura.radius);
  const tokenCenter = getCenterForTokenLike(tokenLike);
  const sourceCenter = getCenterForTokenLike(source);
  if (Number.isFinite(auraRadius) && tokenCenter && sourceCenter) {
    const centerDistance = canvas.grid.measureDistance(tokenCenter, sourceCenter);
    const sourceBaseRadiusGrid = getTokenBaseRadiusInGridUnits(source);
    const targetBaseRadiusGrid = getTokenBaseRadiusInGridUnits(tokenLike);
    const edgeDistance = Math.max(0, centerDistance - sourceBaseRadiusGrid - targetBaseRadiusGrid);
    const evaluation = evaluateAuraDistanceMode({
      auraRadius,
      centerDistance,
      edgeDistance,
      source,
      tokenLike,
      mode,
    });

    return {
      distance: evaluation.distance,
      centerDistance,
      edgeDistance,
      radius: auraRadius,
      modeApplied: evaluation.modeApplied,
      inRange: evaluation.withinAura,
      usedContainsToken: false,
      containsTokenResult,
    };
  }

  return {
    distance: null,
    centerDistance: null,
    edgeDistance: null,
    radius: Number.isFinite(auraRadius) ? auraRadius : null,
    modeApplied: null,
    inRange: false,
    usedContainsToken: false,
    containsTokenResult,
  };
}
