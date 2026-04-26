export const MAP_BOUNDS = Object.freeze({
  minLon: -6.15,
  maxLon: 2.0,
  minLat: 49.78,
  maxLat: 55.95
});

const PROJECTED_BOUNDS = Object.freeze({
  minX: mercatorX(MAP_BOUNDS.minLon),
  maxX: mercatorX(MAP_BOUNDS.maxLon),
  minY: mercatorY(MAP_BOUNDS.minLat),
  maxY: mercatorY(MAP_BOUNDS.maxLat)
});

export const MAP_PROJECTED_RATIO =
  (PROJECTED_BOUNDS.maxX - PROJECTED_BOUNDS.minX) / (PROJECTED_BOUNDS.maxY - PROJECTED_BOUNDS.minY);

export function getMapViewport(width, height) {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const padding = getViewportPadding(safeWidth, safeHeight);
  const availableWidth = Math.max(1, safeWidth - padding.x * 2);
  const availableHeight = Math.max(1, safeHeight - padding.y * 2);
  const projectedWidth = PROJECTED_BOUNDS.maxX - PROJECTED_BOUNDS.minX;
  const projectedHeight = PROJECTED_BOUNDS.maxY - PROJECTED_BOUNDS.minY;
  const scale = Math.min(availableWidth / projectedWidth, availableHeight / projectedHeight);
  const renderedWidth = projectedWidth * scale;
  const renderedHeight = projectedHeight * scale;

  return {
    x: (safeWidth - renderedWidth) / 2,
    y: (safeHeight - renderedHeight) / 2,
    width: renderedWidth,
    height: renderedHeight,
    scale
  };
}

export function project(lon, lat, width, height) {
  const viewport = getMapViewport(width, height);
  const projectedX = mercatorX(lon);
  const projectedY = mercatorY(lat);

  return {
    x: viewport.x + (projectedX - PROJECTED_BOUNDS.minX) * viewport.scale,
    y: viewport.y + (PROJECTED_BOUNDS.maxY - projectedY) * viewport.scale
  };
}

function getViewportPadding(width, height) {
  const shortSide = Math.min(width, height);

  return {
    x: clamp(shortSide * 0.045, 12, 52),
    y: clamp(shortSide * 0.05, 14, 58)
  };
}

function mercatorX(lon) {
  return toRadians(lon);
}

function mercatorY(lat) {
  const clampedLat = clamp(lat, -85, 85);
  const radians = toRadians(clampedLat);
  return Math.log(Math.tan(Math.PI / 4 + radians / 2));
}

function toRadians(degrees) {
  return degrees * Math.PI / 180;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
