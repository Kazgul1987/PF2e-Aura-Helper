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

function getPathDistanceFromMeasurement(measurement) {
  if (Number.isFinite(measurement)) return measurement;
  if (!measurement || typeof measurement !== 'object') return null;

  if (Number.isFinite(measurement.distance)) return measurement.distance;
  if (Number.isFinite(measurement.cost)) return measurement.cost;

  return null;
}

function measureGridDistance(from, to) {
  if (!from || !to || !canvas?.grid) return null;

  if (typeof canvas.grid.measurePath === 'function') {
    const pathResult = canvas.grid.measurePath([from, to]);
    const pathDistance = getPathDistanceFromMeasurement(pathResult);
    if (Number.isFinite(pathDistance)) return pathDistance;
  }

  if (typeof canvas.grid.measureDistance === 'function') {
    const distance = canvas.grid.measureDistance(from, to);
    if (Number.isFinite(distance)) return distance;
  }

  return null;
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
  const distance = measureGridDistance({ x: 0, y: 0 }, { x: baseRadiusPx, y: 0 });
  return Number.isFinite(distance) ? distance : 0;
}

function getTokenBoundaryPoints(tokenLike) {
  if (!tokenLike) return [];

  const document = tokenLike.document ?? tokenLike;
  if (!Number.isFinite(document?.x) || !Number.isFinite(document?.y)) return [];

  const gridSize = canvas.grid?.size ?? 1;
  const widthPx = (document.width ?? tokenLike.w ?? 1) * gridSize;
  const heightPx = (document.height ?? tokenLike.h ?? 1) * gridSize;
  const left = document.x;
  const right = left + widthPx;
  const top = document.y;
  const bottom = top + heightPx;
  const midX = left + widthPx / 2;
  const midY = top + heightPx / 2;

  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: left, y: bottom },
    { x: right, y: bottom },
    { x: midX, y: top },
    { x: midX, y: bottom },
    { x: left, y: midY },
    { x: right, y: midY },
  ];
}

function getMinimumTokenEdgeDistance(source, tokenLike, centerDistance) {
  const sourceBoundaryPoints = getTokenBoundaryPoints(source);
  const tokenBoundaryPoints = getTokenBoundaryPoints(tokenLike);

  if (sourceBoundaryPoints.length > 0 && tokenBoundaryPoints.length > 0) {
    let minimumDistance = Infinity;

    for (const sourcePoint of sourceBoundaryPoints) {
      for (const tokenPoint of tokenBoundaryPoints) {
        const pairDistance = measureGridDistance(sourcePoint, tokenPoint);
        if (Number.isFinite(pairDistance) && pairDistance < minimumDistance) {
          minimumDistance = pairDistance;
        }
      }
    }

    if (Number.isFinite(minimumDistance)) return Math.max(0, minimumDistance);
  }

  const sourceBaseRadiusGrid = getTokenBaseRadiusInGridUnits(source);
  const targetBaseRadiusGrid = getTokenBaseRadiusInGridUnits(tokenLike);
  return Math.max(0, centerDistance - sourceBaseRadiusGrid - targetBaseRadiusGrid);
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
    const centerDistance = measureGridDistance(tokenCenter, sourceCenter);
    const edgeDistance = Number.isFinite(centerDistance)
      ? getMinimumTokenEdgeDistance(source, tokenLike, centerDistance)
      : null;

    if (!Number.isFinite(centerDistance) || !Number.isFinite(edgeDistance)) {
      return {
        distance: null,
        centerDistance: null,
        edgeDistance: null,
        radius: auraRadius,
        modeApplied: null,
        inRange: false,
        usedContainsToken: false,
        containsTokenResult,
      };
    }

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
