export const MAP_BOUNDS = Object.freeze({
  minLon: -6.15,
  maxLon: 2.0,
  minLat: 49.78,
  maxLat: 55.95
});

const MAP_VIEWBOX = Object.freeze({
  width: 1200,
  height: 860
});

export function getMapViewport(width, height) {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const scale = Math.min(safeWidth / MAP_VIEWBOX.width, safeHeight / MAP_VIEWBOX.height);
  const renderedWidth = MAP_VIEWBOX.width * scale;
  const renderedHeight = MAP_VIEWBOX.height * scale;

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
  const designPoint = projectToViewbox(lon, lat);

  return {
    x: viewport.x + designPoint.x * viewport.scale,
    y: viewport.y + designPoint.y * viewport.scale
  };
}

function projectToViewbox(lon, lat) {
  const paddingX = Math.max(30, MAP_VIEWBOX.width * 0.07);
  const paddingY = Math.max(24, MAP_VIEWBOX.height * 0.06);
  const availableWidth = MAP_VIEWBOX.width - paddingX * 2;
  const availableHeight = MAP_VIEWBOX.height - paddingY * 2;
  const boundsWidth = MAP_BOUNDS.maxLon - MAP_BOUNDS.minLon;
  const boundsHeight = MAP_BOUNDS.maxLat - MAP_BOUNDS.minLat;
  const scale = Math.min(availableWidth / boundsWidth, availableHeight / boundsHeight);
  const renderedWidth = boundsWidth * scale;
  const renderedHeight = boundsHeight * scale;
  const offsetX = (MAP_VIEWBOX.width - renderedWidth) / 2;
  const offsetY = (MAP_VIEWBOX.height - renderedHeight) / 2;

  return {
    x: offsetX + (lon - MAP_BOUNDS.minLon) * scale,
    y: offsetY + (MAP_BOUNDS.maxLat - lat) * scale
  };
}
