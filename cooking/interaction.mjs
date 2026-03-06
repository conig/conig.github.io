export const MOBILE_BREAKPOINT = 959;
export const TOUCH_TAP_MAX_MOVEMENT = 10;
export const TOUCH_TAP_MAX_DURATION_MS = 450;
export const COOKBOOK_NAV_SYNC_DELAY_MS = 520;

export const isMobileViewport = (width) => Number(width) <= MOBILE_BREAKPOINT;

export const shouldMorphCardOpen = ({ width, reducedMotion }) =>
  !reducedMotion && !isMobileViewport(width);

export const gestureDistance = ({ startX = 0, startY = 0, endX = 0, endY = 0 }) =>
  Math.hypot(Number(endX) - Number(startX), Number(endY) - Number(startY));

export const shouldActivateCard = ({
  pointerType = "mouse",
  startX = 0,
  startY = 0,
  endX = 0,
  endY = 0,
  scrollDeltaY = 0,
  elapsedMs = 0,
  wasCancelled = false,
}) => {
  if (wasCancelled) return false;
  if (pointerType === "mouse") return true;
  if (Number(elapsedMs) > TOUCH_TAP_MAX_DURATION_MS) return false;
  if (Math.abs(Number(scrollDeltaY)) > TOUCH_TAP_MAX_MOVEMENT) return false;
  return gestureDistance({ startX, startY, endX, endY }) <= TOUCH_TAP_MAX_MOVEMENT;
};

export const shouldSyncCookbookNav = ({ now, suppressUntil }) => Number(now) >= Number(suppressUntil || 0);
