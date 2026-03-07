import {
  COOKBOOK_NAV_SYNC_DELAY_MS,
  isMobileViewport,
  shouldActivateCard,
  shouldMorphCardOpen,
  shouldSyncCookbookNav,
} from "./interaction.mjs";

const DATA_URL = new URL("./content/index.json", import.meta.url);

const FLAG_LABELS = {
  vegetarian: "Vegetarian",
  vegan: "Vegan",
  gluten_free: "Gluten Free",
  dairy_free: "Dairy Free",
};

const state = {
  tab: "recipes",
  recipeSlug: "",
  cookbookSlug: "",
  q: "",
  flags: new Set(),
  courses: new Set(),
  tags: new Set(),
};

const refs = {
  app: document.getElementById("vc-app"),
  tabRecipes: document.getElementById("vc-tab-recipes"),
  tabCookbooks: document.getElementById("vc-tab-cookbooks"),
  searchInput: document.getElementById("vc-search-input"),
  filterRow: document.getElementById("vc-filter-row"),
  featureSlot: document.getElementById("vc-feature-slot"),
  list: document.getElementById("vc-list"),
  detail: document.getElementById("vc-detail"),
  detailEmpty: document.getElementById("vc-detail-empty"),
  cardTemplate: document.getElementById("vc-card-template"),
};

let data = null;
let recipesBySlug = new Map();
let cookbooksBySlug = new Map();
let pendingMorphRect = null;
let activeRecipeList = [];
let activeCookbookList = [];
let disposeCookbookView = null;
let mobileRecipeListScrollY = 0;
let suppressCookbookNavSyncUntil = 0;
let lastViewportWidth = window.innerWidth;
let lastViewportHeight = window.innerHeight;

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const recipeMobileQuery = window.matchMedia("(max-width: 959px)");

const text = (value) => String(value || "").trim();
const escapeHtml = (value) =>
  text(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] || char));
const normalize = (value) => text(value).toLowerCase().replace(/\s+/g, " ").trim();
const slugify = (value) =>
  normalize(value)
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "section";
const iconClipboard = `
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <rect x="7" y="5" width="10" height="15" rx="2" ry="2"></rect>
    <path d="M9 5.5h6M10 3.5h4"></path>
  </svg>
`;
const iconShare = `
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M12 15V5"></path>
    <path d="M9 8l3-3 3 3"></path>
    <path d="M6 13.5h12a2 2 0 0 1 2 2V19H4v-3.5a2 2 0 0 1 2-2z"></path>
  </svg>
`;

const stripHtmlToText = (html) => {
  const value = text(html);
  if (!value) return "";
  const doc = new DOMParser().parseFromString(`<body>${value}</body>`, "text/html");
  return text(doc.body.textContent).replace(/\u00a0/g, " ");
};

const buildRecipeMarkdown = (recipe) => {
  const lines = [`# ${text(recipe.title)}`];

  if (text(recipe.menu)) {
    lines.push("", text(recipe.menu));
  }

  lines.push("", "## Ingredients");
  const ingredients = Array.isArray(recipe.ingredients_items) ? recipe.ingredients_items : [];
  if (ingredients.length > 0) {
    ingredients.forEach((item) => lines.push(`- ${text(item)}`));
  } else {
    lines.push("- (No ingredients provided)");
  }

  lines.push("", "## Method");
  const method = Array.isArray(recipe.method_items) ? recipe.method_items : [];
  if (method.length > 0) {
    method.forEach((step, idx) => lines.push(`${idx + 1}. ${text(step)}`));
  } else {
    lines.push("1. (No method provided)");
  }

  const notes = stripHtmlToText(recipe.sections?.notes_html || "");
  if (notes) {
    lines.push("", "## Notes", "", notes);
  }

  return `${lines.join("\n").trim()}\n`;
};

const canonicalRecipeUrl = (slug) => {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = `/recipes/${encodeURIComponent(text(slug))}`;
  return url.toString();
};

const writeClipboardText = async (value) => {
  const content = String(value || "");
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    await navigator.clipboard.writeText(content);
    return true;
  }

  const area = document.createElement("textarea");
  area.value = content;
  area.setAttribute("readonly", "readonly");
  area.style.position = "fixed";
  area.style.top = "-9999px";
  document.body.appendChild(area);
  area.focus();
  area.select();
  const success = document.execCommand("copy");
  area.remove();
  if (!success) throw new Error("Clipboard write failed.");
  return true;
};

const pulseActionButton = (button) => {
  if (!(button instanceof HTMLElement)) return;
  button.classList.add("is-confirmed");
  window.setTimeout(() => button.classList.remove("is-confirmed"), 800);
};

const toYouTubeMusicUrl = (raw) => {
  if (!raw) return null;

  let url;
  try {
    url = new URL(raw, window.location.href);
  } catch (_) {
    return null;
  }

  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const isYouTubeHost =
    host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com" || host === "youtu.be";
  if (!isYouTubeHost) return null;

  const parts = url.pathname.split("/").filter(Boolean);
  let videoId = "";
  let listId = url.searchParams.get("list") || "";

  if (host === "youtu.be") {
    videoId = parts[0] || "";
  } else if (parts[0] === "watch") {
    videoId = url.searchParams.get("v") || "";
  } else if (parts[0] === "shorts" || parts[0] === "live" || parts[0] === "embed") {
    videoId = parts[1] || "";
  } else if (parts[0] === "playlist") {
    listId = url.searchParams.get("list") || "";
  }

  if (videoId) {
    const params = new URLSearchParams({ v: videoId });
    if (listId) params.set("list", listId);
    return `https://music.youtube.com/watch?${params.toString()}`;
  }
  if (listId) return `https://music.youtube.com/playlist?list=${encodeURIComponent(listId)}`;
  return null;
};

const hydrateMusicLinks = (root) => {
  if (!root) return;
  root.querySelectorAll(".vc-music-link[data-vc-music-url]").forEach((link) => {
    const raw = link.dataset.vcMusicUrl || "";
    const musicUrl = toYouTubeMusicUrl(raw);
    if (musicUrl) link.href = musicUrl;
  });
};

const isMobileRecipeLayout = () => isMobileViewport(window.innerWidth);
const shouldUseMorphAnimation = () => shouldMorphCardOpen({ width: window.innerWidth, reducedMotion });
const canSyncCookbookNav = () =>
  shouldSyncCookbookNav({ now: window.performance.now(), suppressUntil: suppressCookbookNavSyncUntil });

const syncCookbookHeaderHeight = () => {
  const shell = refs.detail.querySelector(".vc-cookbook-shell");
  const header = refs.detail.querySelector(".vc-cookbook-header");
  if (!shell || !header) return;
  const height = Math.ceil(header.getBoundingClientRect().height);
  if (height > 0) shell.style.setProperty("--vc-header-height", `${height}px`);
};

const syncCookbookRailGeometry = () => {
  const rail = refs.detail.querySelector(".vc-cookbook-rail");
  const railInner = refs.detail.querySelector(".vc-cookbook-rail-inner");
  if (!rail || !railInner) return;

  if (!window.matchMedia("(min-width: 960px)").matches) {
    railInner.classList.remove("vc-cookbook-rail-fixed");
    railInner.style.removeProperty("--vc-rail-left");
    railInner.style.removeProperty("--vc-rail-width");
    return;
  }

  const rect = rail.getBoundingClientRect();
  railInner.style.setProperty("--vc-rail-left", `${Math.round(rect.left)}px`);
  railInner.style.setProperty("--vc-rail-width", `${Math.round(rect.width)}px`);
  railInner.classList.add("vc-cookbook-rail-fixed");
};

const scrollCookbookTarget = (targetId) => {
  const target = document.getElementById(targetId);
  if (!target) return;
  const shell = refs.detail.querySelector(".vc-cookbook-shell");
  const headerHeight = shell ? Number.parseInt(getComputedStyle(shell).getPropertyValue("--vc-header-height"), 10) || 0 : 0;
  const top = target.getBoundingClientRect().top + window.scrollY - headerHeight - 12;
  suppressCookbookNavSyncUntil = window.performance.now() + COOKBOOK_NAV_SYNC_DELAY_MS;
  window.scrollTo({ top: Math.max(top, 0), behavior: reducedMotion ? "auto" : "smooth" });
};

const parseHash = () => {
  const raw = window.location.hash || "#/recipes";
  const hash = raw.startsWith("#") ? raw.slice(1) : raw;
  const [pathRaw, queryRaw] = hash.split("?", 2);
  const path = pathRaw.replace(/^\/+/, "");
  const parts = path.split("/").filter(Boolean);
  const tab = parts[0] === "cookbooks" ? "cookbooks" : "recipes";
  let slug = "";
  try {
    slug = decodeURIComponent(parts[1] || "");
  } catch (_error) {
    slug = text(parts[1] || "");
  }

  const params = new URLSearchParams(queryRaw || "");
  const flags = new Set(text(params.get("flags")).split(",").map((item) => item.trim()).filter(Boolean));
  const courses = new Set(text(params.get("courses")).split(",").map((item) => item.trim()).filter(Boolean));
  const tags = new Set(text(params.get("tags")).split(",").map((item) => item.trim()).filter(Boolean));

  return {
    tab,
    recipeSlug: tab === "recipes" ? slug : "",
    cookbookSlug: tab === "cookbooks" ? slug : "",
    q: text(params.get("q")),
    flags,
    courses,
    tags,
  };
};

const encodeHash = () => {
  const path = state.tab === "recipes" ? `/recipes/${encodeURIComponent(state.recipeSlug || "")}` : `/cookbooks/${encodeURIComponent(state.cookbookSlug || "")}`;
  const params = new URLSearchParams();

  if (state.q) params.set("q", state.q);
  if (state.flags.size > 0) params.set("flags", Array.from(state.flags).sort().join(","));
  if (state.courses.size > 0 && state.tab === "recipes") params.set("courses", Array.from(state.courses).sort().join(","));
  if (state.tags.size > 0 && state.tab === "recipes") params.set("tags", Array.from(state.tags).sort().join(","));

  const query = params.toString();
  return `#${path}${query ? `?${query}` : ""}`;
};

const applyStateFromHash = () => {
  const parsed = parseHash();
  state.tab = parsed.tab;
  state.recipeSlug = parsed.recipeSlug;
  state.cookbookSlug = parsed.cookbookSlug;
  state.q = parsed.q;
  state.flags = parsed.flags;
  state.courses = parsed.courses;
  state.tags = parsed.tags;
  render();
};

const updateHash = (replace = false) => {
  const nextHash = encodeHash();
  if (replace) {
    const url = new URL(window.location.href);
    url.hash = nextHash.slice(1);
    history.replaceState(null, "", url);
    applyStateFromHash();
    return;
  }
  if (window.location.hash === nextHash) {
    render();
    return;
  }
  window.location.hash = nextHash;
};

const matchesRecipeFilters = (recipe) => {
  const needle = normalize(state.q);
  if (needle && !text(recipe.search_text).includes(needle)) return false;

  for (const flag of state.flags) {
    if (!recipe.flags || recipe.flags[flag] !== true) return false;
  }
  if (state.courses.size > 0 && !state.courses.has(text(recipe.course))) return false;
  for (const tag of state.tags) {
    if (!recipe.tags.includes(tag)) return false;
  }
  return true;
};

const matchesCookbookFilters = (cookbook) => {
  const needle = normalize(state.q);
  if (!needle) return true;
  const haystack = normalize([cookbook.title, cookbook.subtitle, cookbook.author, cookbook.date].join(" "));
  return haystack.includes(needle);
};

const setTab = (tab) => {
  state.tab = tab;
  state.q = "";
  state.flags = new Set();
  state.courses = new Set();
  state.tags = new Set();
  if (tab === "recipes") {
    state.cookbookSlug = "";
  } else {
    state.recipeSlug = "";
  }
  updateHash();
};

const openRecipe = (slug, sourceCard = null) => {
  if (isMobileRecipeLayout()) mobileRecipeListScrollY = window.scrollY;
  if (sourceCard instanceof HTMLElement && shouldUseMorphAnimation()) pendingMorphRect = sourceCard.getBoundingClientRect();
  state.tab = "recipes";
  state.recipeSlug = slug;
  updateHash();
};

const openCookbook = (slug, sourceCard = null) => {
  if (sourceCard instanceof HTMLElement && shouldUseMorphAnimation()) pendingMorphRect = sourceCard.getBoundingClientRect();
  state.tab = "cookbooks";
  state.cookbookSlug = slug;
  updateHash();
};

const closeRecipe = () => {
  if (!state.recipeSlug) return;
  const restoreScroll = isMobileRecipeLayout();
  clearMorphArtifacts();
  pendingMorphRect = null;
  state.recipeSlug = "";
  updateHash();
  if (restoreScroll) {
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: mobileRecipeListScrollY, behavior: "auto" });
    });
  }
};

const closeCookbook = () => {
  clearMorphArtifacts();
  pendingMorphRect = null;
  state.cookbookSlug = "";
  updateHash();
};

const clearNode = (node) => {
  while (node.firstChild) node.removeChild(node.firstChild);
};

const clearCookbookBindings = () => {
  if (typeof disposeCookbookView === "function") disposeCookbookView();
  disposeCookbookView = null;
};

const buildMetaPills = (values) => {
  const row = document.createElement("div");
  row.className = "vc-meta-row";
  values.filter(Boolean).forEach((value) => {
    const pill = document.createElement("span");
    if (typeof value === "object" && value !== null) {
      pill.className = `vc-pill${value.className ? ` ${value.className}` : ""}`;
      pill.textContent = text(value.label);
    } else {
      pill.className = "vc-pill";
      pill.textContent = text(value);
    }
    row.appendChild(pill);
  });
  return row;
};

const formatCalories = (value, { perServe = false } = {}) => {
  if (value === null || value === undefined || value === "") return "";
  const amount = Number.parseInt(String(value), 10);
  if (!Number.isFinite(amount)) return "";
  return perServe ? `${amount} kcal / serve` : `${amount} kcal`;
};

const renderFilterGroup = (title, items) => {
  if (!Array.isArray(items) || items.length === 0) return null;

  const group = document.createElement("section");
  group.className = "vc-filter-group";

  const heading = document.createElement("h2");
  heading.className = "vc-filter-heading";
  heading.textContent = title;
  group.appendChild(heading);

  const row = document.createElement("div");
  row.className = "vc-filter-group-row";
  items.forEach((item) => row.appendChild(item));
  group.appendChild(row);

  return group;
};

const imageInitials = (value) => {
  const words = text(value)
    .split(/\s+/)
    .map((item) => item.replace(/[^a-z0-9]/gi, ""))
    .filter(Boolean);
  if (words.length === 0) return "VC";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0] || ""}${words[1][0] || ""}`.toUpperCase();
};

const buildImageFallbackMarkup = ({ title, label = "", kind = "card" }) => `
  <span class="vc-image-fallback vc-image-fallback-${kind}" aria-hidden="true">
    <span class="vc-image-fallback-mark">${escapeHtml(imageInitials(title))}</span>
    ${label ? `<span class="vc-image-fallback-label">${escapeHtml(label)}</span>` : ""}
  </span>
`;

const buildImageMarkup = ({ src, alt = "", title = "", label = "", kind = "card" }) =>
  `${buildImageFallbackMarkup({ title, label, kind })}<img data-vc-image src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async" />`;

const clearImageFocus = (frame) => {
  if (!(frame instanceof HTMLElement)) return;
  frame.style.removeProperty("--vc-image-scale");
  frame.style.removeProperty("--vc-image-shift-x");
  frame.style.removeProperty("--vc-image-shift-y");
  frame.dataset.vcImageFocus = "none";
};

const measureImageFocus = (img) => {
  if (!(img instanceof HTMLImageElement) || img.naturalWidth <= 0 || img.naturalHeight <= 0) return null;

  const sampleWidth = Math.min(img.naturalWidth, 128);
  const sampleHeight = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * sampleWidth));
  const canvas = document.createElement("canvas");
  canvas.width = sampleWidth;
  canvas.height = sampleHeight;

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;

  context.drawImage(img, 0, 0, sampleWidth, sampleHeight);
  const pixels = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
  const cornerSize = Math.max(4, Math.floor(Math.min(sampleWidth, sampleHeight) * 0.12));
  const cornerOffsets = [
    [0, 0],
    [sampleWidth - cornerSize, 0],
    [0, sampleHeight - cornerSize],
    [sampleWidth - cornerSize, sampleHeight - cornerSize],
  ];

  let cornerCount = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumA = 0;

  cornerOffsets.forEach(([startX, startY]) => {
    for (let y = startY; y < startY + cornerSize; y += 1) {
      for (let x = startX; x < startX + cornerSize; x += 1) {
        const index = (y * sampleWidth + x) * 4;
        sumR += pixels[index];
        sumG += pixels[index + 1];
        sumB += pixels[index + 2];
        sumA += pixels[index + 3];
        cornerCount += 1;
      }
    }
  });

  if (cornerCount === 0) return null;

  const bgR = sumR / cornerCount;
  const bgG = sumG / cornerCount;
  const bgB = sumB / cornerCount;
  const bgA = sumA / cornerCount;
  const bgLuma = (bgR + bgG + bgB) / 3;

  let variance = 0;
  cornerOffsets.forEach(([startX, startY]) => {
    for (let y = startY; y < startY + cornerSize; y += 1) {
      for (let x = startX; x < startX + cornerSize; x += 1) {
        const index = (y * sampleWidth + x) * 4;
        variance += Math.abs(pixels[index] - bgR);
        variance += Math.abs(pixels[index + 1] - bgG);
        variance += Math.abs(pixels[index + 2] - bgB);
      }
    }
  });
  const averageVariance = variance / Math.max(1, cornerCount * 3);
  const lightUniformBackground = bgA >= 235 && bgLuma >= 232 && averageVariance <= 18;
  if (!lightUniformBackground) return null;

  let weightedCount = 0;
  let sumX = 0;
  let sumY = 0;
  let minX = sampleWidth;
  let maxX = -1;
  let minY = sampleHeight;
  let maxY = -1;

  for (let y = 0; y < sampleHeight; y += 1) {
    for (let x = 0; x < sampleWidth; x += 1) {
      const index = (y * sampleWidth + x) * 4;
      const alpha = pixels[index + 3];
      if (alpha < 16) continue;

      const r = pixels[index];
      const g = pixels[index + 1];
      const b = pixels[index + 2];
      const luma = (r + g + b) / 3;
      const distance = (Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB)) / 3;
      const weight = Math.max(bgLuma - luma, distance * 1.2);
      if (weight < 18) continue;

      weightedCount += weight;
      sumX += x * weight;
      sumY += y * weight;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (weightedCount <= 0 || maxX < minX || maxY < minY) return null;

  const centerX = sumX / weightedCount;
  const centerY = sumY / weightedCount;
  const offsetX = centerX / sampleWidth - 0.5;
  const offsetY = centerY / sampleHeight - 0.5;
  const fill = Math.max((maxX - minX + 1) / sampleWidth, (maxY - minY + 1) / sampleHeight);

  if (Math.abs(offsetX) < 0.012 && Math.abs(offsetY) < 0.016 && fill >= 0.9) return null;

  return { offsetX, offsetY, fill };
};

const applyImageFocus = (frame, img) => {
  if (!(frame instanceof HTMLElement) || !(img instanceof HTMLImageElement)) return;
  if (!window.matchMedia("(min-width: 960px)").matches) {
    clearImageFocus(frame);
    return;
  }

  const focus = measureImageFocus(img);
  if (!focus) {
    clearImageFocus(frame);
    return;
  }

  const shiftX = Math.max(-6, Math.min(6, -focus.offsetX * 95));
  const shiftY = Math.max(-8, Math.min(6, -focus.offsetY * 105));
  const scale = Math.max(1, Math.min(1.12, 1 + Math.max(0, 0.9 - focus.fill) * 0.22 + Math.hypot(shiftX, shiftY) * 0.004));

  frame.style.setProperty("--vc-image-shift-x", `${shiftX.toFixed(2)}%`);
  frame.style.setProperty("--vc-image-shift-y", `${shiftY.toFixed(2)}%`);
  frame.style.setProperty("--vc-image-scale", scale.toFixed(3));
  frame.dataset.vcImageFocus = "auto";
};

const refreshImageFocus = (root = document) => {
  if (!root || typeof root.querySelectorAll !== "function") return;
  root.querySelectorAll("[data-vc-image-frame]").forEach((frame) => {
    if (!(frame instanceof HTMLElement)) return;
    const img = frame.querySelector("[data-vc-image]");
    if (!(img instanceof HTMLImageElement) || img.naturalWidth <= 0) {
      clearImageFocus(frame);
      return;
    }
    applyImageFocus(frame, img);
  });
};

const hydrateImageFallbacks = (root) => {
  if (!root) return;
  root.querySelectorAll("[data-vc-image-frame]").forEach((frame) => {
    if (!(frame instanceof HTMLElement)) return;
    const img = frame.querySelector("[data-vc-image]");
    if (!(img instanceof HTMLImageElement)) return;

    const markLoaded = () => {
      frame.classList.remove("is-loading", "is-broken");
      frame.classList.add("is-loaded");
      applyImageFocus(frame, img);
    };
    const markBroken = () => {
      frame.classList.remove("is-loading", "is-loaded");
      frame.classList.add("is-broken");
      clearImageFocus(frame);
    };

    frame.classList.add("is-loading");
    if (img.complete) {
      if (img.naturalWidth > 0) markLoaded();
      else markBroken();
      return;
    }

    img.addEventListener("load", markLoaded, { once: true });
    img.addEventListener("error", markBroken, { once: true });
  });
};

const buildCookbookCollageHtml = (cookbook) => {
  const candidates = (cookbook.recipe_slugs || [])
    .map((slug) => recipesBySlug.get(slug))
    .filter(Boolean)
    .map((recipe) => recipe.image)
    .filter(Boolean)
    .slice(0, 4);
  if (candidates.length === 0) return "";

  const cells = Array.from({ length: 4 }, (_value, idx) => {
    const src = candidates[idx] || "";
    return src
      ? `<span class="vc-collage-cell" data-vc-image-frame>${buildImageMarkup({ src, title: cookbook.title, label: "Cookbook", kind: "collage" })}</span>`
      : `<span class="vc-collage-cell vc-collage-cell-empty" aria-hidden="true">${buildImageFallbackMarkup({ title: cookbook.title, label: "Cookbook", kind: "collage" })}</span>`;
  }).join("");
  return `<div class="vc-cookbook-collage" aria-hidden="true">${cells}</div>`;
};

const attachCardInteraction = (card, onOpen) => {
  let pointerState = null;
  let suppressClick = false;

  const clearPointerState = () => {
    pointerState = null;
  };

  card.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    pointerState = {
      pointerId: event.pointerId,
      pointerType: event.pointerType || "mouse",
      startX: event.clientX,
      startY: event.clientY,
      startTime: window.performance.now(),
      startScrollY: window.scrollY,
      cancelled: false,
    };
    suppressClick = false;
  });

  card.addEventListener("pointermove", (event) => {
    if (!pointerState || pointerState.pointerId !== event.pointerId) return;
    if (pointerState.pointerType === "mouse") return;
    const moveY = Math.abs(event.clientY - pointerState.startY);
    const scrollDeltaY = Math.abs(window.scrollY - pointerState.startScrollY);
    if (moveY > 10 || scrollDeltaY > 10) {
      pointerState.cancelled = true;
      suppressClick = true;
    }
  });

  card.addEventListener("pointercancel", () => {
    suppressClick = true;
    clearPointerState();
  });

  card.addEventListener("pointerup", (event) => {
    if (!pointerState || pointerState.pointerId !== event.pointerId) return;
    const gesture = {
      pointerType: pointerState.pointerType,
      startX: pointerState.startX,
      startY: pointerState.startY,
      endX: event.clientX,
      endY: event.clientY,
      scrollDeltaY: window.scrollY - pointerState.startScrollY,
      elapsedMs: window.performance.now() - pointerState.startTime,
      wasCancelled: pointerState.cancelled,
    };
    const activate = shouldActivateCard(gesture);
    suppressClick = pointerState.pointerType !== "mouse";
    clearPointerState();
    if (activate && gesture.pointerType !== "mouse") {
      event.preventDefault();
      onOpen(card);
    }
  });

  card.addEventListener("click", (event) => {
    if (suppressClick) {
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onOpen(card);
  });
};

const extractDateFromTitle = (title) => {
  const match = text(title).match(/\(([^)]+)\)\s*$/);
  return match ? text(match[1]) : "";
};

const cookbookTimestamp = (cookbook) => {
  const candidates = [text(cookbook.date), extractDateFromTitle(cookbook.title)].filter(Boolean);
  for (const candidate of candidates) {
    const stamp = Date.parse(candidate);
    if (Number.isFinite(stamp)) return stamp;
  }
  const sourceMtime = Number(cookbook.source_mtime || 0);
  if (Number.isFinite(sourceMtime) && sourceMtime > 0) return sourceMtime * 1000;
  return Number.NEGATIVE_INFINITY;
};

const getFeaturedDateNightCookbook = () => {
  const pool = (data?.cookbooks || []).filter((cookbook) => normalize(cookbook.title).includes("date night"));
  if (pool.length === 0) return null;
  return [...pool].sort((a, b) => cookbookTimestamp(b) - cookbookTimestamp(a))[0] || null;
};

const makeCard = ({ title, body, pills, image, heroHtml, heroClass, onOpen }) => {
  const card = refs.cardTemplate.content.firstElementChild.cloneNode(true);

  if (heroHtml || image) {
    const figure = document.createElement("figure");
    figure.className = `vc-card-hero ${heroClass || ""}`.trim();
    if (heroHtml) {
      figure.innerHTML = heroHtml;
    } else {
      figure.setAttribute("data-vc-image-frame", "");
      figure.innerHTML = buildImageMarkup({ src: image, title, alt: "", label: "Recipe", kind: "card" });
    }
    card.appendChild(figure);
  }

  const heading = document.createElement("h2");
  heading.textContent = title;
  card.appendChild(heading);

  if (body) {
    const paragraph = document.createElement("p");
    paragraph.className = "vc-card-body";
    paragraph.textContent = body;
    card.appendChild(paragraph);
  }

  if (pills && pills.length > 0) card.appendChild(buildMetaPills(pills));

  attachCardInteraction(card, onOpen);
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(card);
    }
  });

  return card;
};

const renderTabs = () => {
  const recipeSelected = state.tab === "recipes";
  const mobileRecipeReader = recipeSelected && Boolean(state.recipeSlug) && isMobileRecipeLayout();
  refs.tabRecipes.setAttribute("aria-selected", recipeSelected ? "true" : "false");
  refs.tabCookbooks.setAttribute("aria-selected", recipeSelected ? "false" : "true");

  refs.app.classList.toggle("vc-mode-recipes", recipeSelected);
  refs.app.classList.toggle("vc-mode-recipe-open", recipeSelected && Boolean(state.recipeSlug) && !mobileRecipeReader);
  refs.app.classList.toggle("vc-mode-recipe-reader", mobileRecipeReader);
  refs.app.classList.toggle("vc-mode-cookbook-library", state.tab === "cookbooks" && !state.cookbookSlug);
  const cookbookFullscreen = state.tab === "cookbooks" && Boolean(state.cookbookSlug);
  refs.app.classList.toggle("vc-mode-cookbook", cookbookFullscreen);
};

const renderSidebarFeature = () => {
  if (!refs.featureSlot) return;
  clearNode(refs.featureSlot);
  refs.featureSlot.hidden = true;
  if (!(state.tab === "cookbooks" && !state.cookbookSlug)) return;

  const featured = getFeaturedDateNightCookbook();
  if (!featured) return;

  const card = document.createElement("article");
  card.className = "vc-feature-card";
  card.tabIndex = 0;
  card.innerHTML = `
    <p class="vc-feature-kicker">Latest Date Night</p>
    <h3>${escapeHtml(featured.title)}</h3>
    ${featured.subtitle ? `<p class="vc-feature-body">${escapeHtml(featured.subtitle)}</p>` : ""}
    <figure class="vc-card-hero vc-card-hero-collage vc-feature-hero">
      ${buildCookbookCollageHtml(featured) || '<div class="vc-cookbook-collage"><span class="vc-collage-cell vc-collage-cell-empty"></span><span class="vc-collage-cell vc-collage-cell-empty"></span><span class="vc-collage-cell vc-collage-cell-empty"></span><span class="vc-collage-cell vc-collage-cell-empty"></span></div>'}
    </figure>
    <div class="vc-meta-row">
      ${featured.date ? `<span class="vc-pill">${escapeHtml(featured.date)}</span>` : ""}
      <span class="vc-pill">${featured.recipe_slugs.length} recipes</span>
    </div>
  `;

  card.addEventListener("click", () => openCookbook(featured.slug, card));
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openCookbook(featured.slug, card);
    }
  });

  refs.featureSlot.appendChild(card);
  refs.featureSlot.hidden = false;
  hydrateImageFallbacks(refs.featureSlot);
};

const renderFilters = () => {
  clearNode(refs.filterRow);
  if (state.tab !== "recipes" || state.cookbookSlug) return;

  const courseButtons = [];
  (data.facets.courses || []).forEach((course) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "vc-chip vc-chip-course";
    chip.textContent = course;
    chip.setAttribute("aria-pressed", state.courses.has(course) ? "true" : "false");
    chip.addEventListener("click", () => {
      if (state.courses.has(course)) state.courses.delete(course);
      else state.courses.add(course);
      state.recipeSlug = "";
      updateHash(true);
    });
    courseButtons.push(chip);
  });

  const flagButtons = [];
  const activeFlags = data.facets.flags || [];
  activeFlags.forEach((flag) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "vc-chip";
    chip.textContent = FLAG_LABELS[flag] || flag;
    chip.setAttribute("aria-pressed", state.flags.has(flag) ? "true" : "false");
    chip.addEventListener("click", () => {
      if (state.flags.has(flag)) state.flags.delete(flag);
      else state.flags.add(flag);
      state.recipeSlug = "";
      updateHash(true);
    });
    flagButtons.push(chip);
  });

  const tagButtons = [];
  (data.facets.tags || []).slice(0, 10).forEach((tag) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "vc-chip";
    chip.textContent = `#${tag}`;
    chip.setAttribute("aria-pressed", state.tags.has(tag) ? "true" : "false");
    chip.addEventListener("click", () => {
      if (state.tags.has(tag)) state.tags.delete(tag);
      else state.tags.add(tag);
      state.recipeSlug = "";
      updateHash(true);
    });
    tagButtons.push(chip);
  });

  [
    renderFilterGroup("Course", courseButtons),
    renderFilterGroup("Dietary", flagButtons),
    renderFilterGroup("Tags", tagButtons),
  ]
    .filter(Boolean)
    .forEach((group) => refs.filterRow.appendChild(group));
};

const renderRecipesList = () => {
  activeRecipeList = data.recipes.filter(matchesRecipeFilters);

  clearNode(refs.list);
  if (activeRecipeList.length === 0) {
    const empty = document.createElement("div");
    empty.className = "vc-empty";
    empty.textContent = "No recipes match your search and filters.";
    refs.list.appendChild(empty);
    return;
  }

  activeRecipeList.forEach((recipe) => {
    const pills = [];
    if (recipe.course) pills.push({ label: recipe.course, className: "vc-pill-course" });
    if (recipe.serves) pills.push(`Serves ${recipe.serves}`);
    if (recipe.calories) pills.push({ label: formatCalories(recipe.calories), className: "vc-pill-accent" });
    (recipe.tags || []).slice(0, 2).forEach((tag) => pills.push(`#${tag}`));

    const card = makeCard({
      title: recipe.title,
      body: recipe.menu,
      pills,
      image: recipe.image,
      onOpen: (node) => openRecipe(recipe.slug, node),
    });
    refs.list.appendChild(card);
  });
  hydrateImageFallbacks(refs.list);
};

const renderCookbooksList = () => {
  activeCookbookList = data.cookbooks.filter(matchesCookbookFilters);

  clearNode(refs.list);
  if (activeCookbookList.length === 0) {
    const empty = document.createElement("div");
    empty.className = "vc-empty";
    empty.textContent = "No cookbooks match your search.";
    refs.list.appendChild(empty);
    return;
  }

  activeCookbookList.forEach((cookbook) => {
    const pills = [];
    if (cookbook.author) pills.push(cookbook.author);
    if (cookbook.date) pills.push(cookbook.date);
    pills.push(`${cookbook.recipe_slugs.length} recipes`);

    const card = makeCard({
      title: cookbook.title,
      body: cookbook.subtitle || cookbook.description,
      pills,
      heroHtml: buildCookbookCollageHtml(cookbook),
      heroClass: "vc-card-hero-collage",
      onOpen: (node) => openCookbook(cookbook.slug, node),
    });
    refs.list.appendChild(card);
  });
  hydrateImageFallbacks(refs.list);
};

const renderRecipeHero = (recipe) => {
  const alt = recipe.image_alt || recipe.title || "Recipe image";
  if (!recipe.image) {
    return `<figure class="vc-hero vc-hero-placeholder">${buildImageFallbackMarkup({ title: recipe.title, label: recipe.course || "Recipe", kind: "detail" })}</figure>`;
  }
  return `<figure class="vc-hero" data-vc-image-frame>${buildImageMarkup({ src: recipe.image, alt, title: recipe.title, label: recipe.course || "Recipe", kind: "detail" })}</figure>`;
};

const cookbookLinksHtml = (slugs) =>
  slugs
    .map((slug) => {
      const cookbook = cookbooksBySlug.get(slug);
      if (!cookbook) return "";
      return `<button class="vc-chip" type="button" data-cookbook-jump="${cookbook.slug}">${escapeHtml(cookbook.title)}</button>`;
    })
    .join(" ");

const renderRecipeDetail = () => {
  const recipe = recipesBySlug.get(state.recipeSlug);
  if (!recipe) {
    refs.detail.hidden = true;
    refs.detailEmpty.hidden = true;
    return;
  }

  const mobileReader = isMobileRecipeLayout();
  refs.detail.innerHTML = `
    <article class="vc-detail-surface vc-recipe-reader-surface" id="vc-detail-surface" aria-label="${escapeHtml(recipe.title)}" data-recipe-layout="${mobileReader ? "mobile" : "desktop"}">
      <header class="vc-recipe-head">
        <div class="vc-recipe-head-top">
          <button class="vc-back-btn vc-detail-back-btn" type="button" data-close-recipe aria-label="Back to recipes" title="Back to recipes">&larr; Recipes</button>
          <div class="vc-modal-actions">
            <button class="vc-icon-btn vc-icon-btn-plain" type="button" data-copy-recipe aria-label="Copy recipe markdown" title="Copy recipe markdown">
              ${iconClipboard}
            </button>
            <button class="vc-icon-btn vc-icon-btn-plain" type="button" data-share-recipe aria-label="Share recipe link" title="Share recipe link">
              ${iconShare}
            </button>
          </div>
        </div>
      <div class="vc-modal-head">
          <div class="vc-modal-title-wrap">
            <h2>${escapeHtml(recipe.title)}</h2>
            ${recipe.menu ? `<p class="vc-lede">${escapeHtml(recipe.menu)}</p>` : ""}
          </div>
        </div>
      </header>
      ${renderRecipeHero(recipe)}
      <div class="vc-meta-row vc-recipe-meta-row">
        ${recipe.course ? `<span class="vc-pill vc-pill-course">${escapeHtml(recipe.course)}</span>` : ""}
        ${recipe.serves ? `<span class="vc-pill">Serves ${escapeHtml(recipe.serves)}</span>` : ""}
        ${recipe.calories ? `<span class="vc-pill vc-pill-accent">${escapeHtml(formatCalories(recipe.calories, { perServe: true }))}</span>` : ""}
        ${recipe.prep ? `<span class="vc-pill">Prep ${escapeHtml(recipe.prep)}</span>` : ""}
        ${recipe.cook ? `<span class="vc-pill">Cook ${escapeHtml(recipe.cook)}</span>` : ""}
        ${recipe.rest ? `<span class="vc-pill">Rest ${escapeHtml(recipe.rest)}</span>` : ""}
      </div>
      <div class="vc-detail-grid">
        <section class="vc-detail-panel vc-detail-panel-ingredients">
          <h3>Ingredients</h3>
          ${recipe.sections.ingredients_html || "<p>No ingredients section found.</p>"}
        </section>
        <section class="vc-detail-panel vc-detail-panel-method">
          <h3>Method</h3>
          ${recipe.sections.method_html || "<p>No method section found.</p>"}
          ${recipe.sections.notes_html ? `<h3>Notes</h3>${recipe.sections.notes_html}` : ""}
        </section>
      </div>
      ${recipe.cookbook_slugs.length > 0 ? `<section><h3>In Cookbooks</h3><div class="vc-meta-row">${cookbookLinksHtml(recipe.cookbook_slugs)}</div></section>` : ""}
    </article>
  `;

  refs.detail.querySelectorAll("[data-cookbook-jump]").forEach((button) => {
    button.addEventListener("click", () => openCookbook(button.dataset.cookbookJump || ""));
  });
  refs.detail.querySelector("[data-copy-recipe]")?.addEventListener("click", async (event) => {
    const trigger = event.currentTarget;
    try {
      await writeClipboardText(buildRecipeMarkdown(recipe));
      pulseActionButton(trigger);
    } catch (_error) {
      // Ignore clipboard failures silently in UI; keyboard shortcuts can still be used.
    }
  });
  refs.detail.querySelector("[data-share-recipe]")?.addEventListener("click", async (event) => {
    const trigger = event.currentTarget;
    const shareUrl = canonicalRecipeUrl(recipe.slug);
    try {
      if (navigator.share) {
        await navigator.share({ title: recipe.title || "Recipe", url: shareUrl });
      } else {
        await writeClipboardText(shareUrl);
      }
      pulseActionButton(trigger);
    } catch (_error) {
      // Ignore cancelled/failed share interactions.
    }
  });
  refs.detail.querySelector("[data-close-recipe]")?.addEventListener("click", closeRecipe);

  refs.detail.hidden = false;
  refs.detailEmpty.hidden = true;
  hydrateImageFallbacks(refs.detail);
  if (mobileReader) {
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: "auto" });
    });
    return;
  }
  runMorphAnimation();
};

const renderCookbookRecipeCard = (recipe) => {
  return `
    <article class="vc-recipe-card" id="recipe-${escapeHtml(recipe.slug)}">
      <div class="vc-recipe-shell">
        <div class="vc-recipe-body">
          <div class="vc-recipe-visual-column">
            <header class="vc-recipe-head">
              <h2 class="vc-recipe-title">${escapeHtml(recipe.title)}</h2>
              ${recipe.menu ? `<p class="vc-recipe-intro">${escapeHtml(recipe.menu)}</p>` : ""}
              <div class="vc-meta-row vc-recipe-meta-row">
                ${recipe.course ? `<span class="vc-pill vc-pill-course">${escapeHtml(recipe.course)}</span>` : ""}
                ${recipe.serves ? `<span class="vc-pill">Serves ${escapeHtml(recipe.serves)}</span>` : ""}
                ${recipe.calories ? `<span class="vc-pill vc-pill-accent">${escapeHtml(formatCalories(recipe.calories, { perServe: true }))}</span>` : ""}
              </div>
            </header>
            <figure class="vc-recipe-visual">
              ${renderRecipeHero(recipe)}
            </figure>
          </div>
          <div class="vc-recipe-prose">
            <section class="vc-section vc-section-panel vc-section-ingredients">
              <h2 class="vc-ingredients-heading">Ingredients</h2>
              ${recipe.sections.ingredients_html || "<p>No ingredients section found.</p>"}
            </section>
            <section class="vc-section vc-section-panel vc-section-method">
              <h2 class="vc-method-heading">Method</h2>
              ${recipe.sections.method_html || "<p>No method section found.</p>"}
            </section>
            ${recipe.sections.notes_html ? `<section class="vc-section vc-section-panel vc-section-notes"><h2 class="vc-notes-heading">Notes</h2>${recipe.sections.notes_html}</section>` : ""}
          </div>
        </div>
      </div>
    </article>
  `;
};

const renderCookbookFullscreen = () => {
  clearCookbookBindings();
  const cookbook = cookbooksBySlug.get(state.cookbookSlug);
  if (!cookbook) {
    state.cookbookSlug = "";
    updateHash(true);
    return;
  }

  const blocks = cookbook.reader_blocks || [];
  const navItems = [];
  const bodyParts = [];

  blocks.forEach((block, idx) => {
    if (block.type === "chapter") {
      const chapterId = `chapter-${idx}-${slugify(block.title || "")}`;
      navItems.push(`<li><button class="vc-nav-link" type="button" data-scroll-target="${chapterId}">${escapeHtml(block.title || "Chapter")}</button></li>`);
      bodyParts.push(`<h1 class="vc-chapter-title" id="${chapterId}">${escapeHtml(block.title || "Chapter")}</h1>`);
      return;
    }

    if (block.type === "text") {
      bodyParts.push(`<div class="vc-reader-text">${block.html || ""}</div>`);
      return;
    }

    if (block.type === "recipe") {
      const recipe = recipesBySlug.get(block.slug || "");
      if (!recipe) return;
      navItems.push(
        `<li class="vc-nav-item-recipe"><button class="vc-nav-link" type="button" data-scroll-target="recipe-${escapeHtml(recipe.slug)}">${escapeHtml(recipe.title)}</button></li>`,
      );
      bodyParts.push(renderCookbookRecipeCard(recipe));
    }
  });

  const musicPanel = cookbook.album_title || cookbook.album_artist || cookbook.album_style || cookbook.album_youtube_url
    ? `
      <section class="vc-music-panel" aria-label="Music pairing">
        <h2 class="vc-music-title">Music Pairing</h2>
        <div class="vc-music-meta">
          ${cookbook.album_title ? `<p><strong>Album:</strong> ${escapeHtml(cookbook.album_title)}</p>` : ""}
          ${cookbook.album_artist ? `<p><strong>Artist:</strong> ${escapeHtml(cookbook.album_artist)}</p>` : ""}
          ${cookbook.album_style ? `<p><strong>Style:</strong> ${escapeHtml(cookbook.album_style)}</p>` : ""}
          ${
            cookbook.album_youtube_url
              ? `
            <p class="vc-music-links">
              <a
                class="vc-music-link"
                data-vc-music-url="${escapeHtml(cookbook.album_youtube_url)}"
                href="${escapeHtml(cookbook.album_youtube_url)}"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Play on YouTube Music"
                title="Play on YouTube Music"
              >
                <span class="vc-music-link-label">Play on YouTube Music</span>
              </a>
            </p>
          `
              : ""
          }
        </div>
      </section>
    `
    : "";

  refs.detail.innerHTML = `
    <div class="vc-cookbook-shell" id="vc-detail-surface">
      <header class="vc-cookbook-header">
        <div class="vc-cookbook-heading">
          <h2>${escapeHtml(cookbook.title)}</h2>
          ${cookbook.subtitle ? `<p class="vc-lede">${escapeHtml(cookbook.subtitle)}</p>` : ""}
          <div class="vc-meta-row vc-cookbook-meta-row">
            ${cookbook.author ? `<span class="vc-pill">${escapeHtml(cookbook.author)}</span>` : ""}
            ${cookbook.date ? `<span class="vc-pill">${escapeHtml(cookbook.date)}</span>` : ""}
            <span class="vc-pill vc-cookbook-count">${cookbook.recipe_slugs.length} recipes</span>
          </div>
        </div>
        <button
          class="vc-cookbook-nav-toggle"
          type="button"
          data-cookbook-nav-toggle
          aria-expanded="false"
          aria-controls="vc-cookbook-menu"
          aria-label="Open navigation menu"
        >
          <span class="vc-nav-icon" aria-hidden="true">
            <span class="vc-nav-icon-bar"></span>
            <span class="vc-nav-icon-bar"></span>
            <span class="vc-nav-icon-bar"></span>
          </span>
        </button>
      </header>
      <div class="vc-cookbook-layout">
        <aside class="vc-cookbook-rail" aria-label="Cookbook navigation">
          <div class="vc-cookbook-rail-inner" id="vc-cookbook-menu">
            <div class="vc-cookbook-menu-actions">
              <button class="vc-back-btn vc-back-btn-menu" type="button" data-back-library aria-label="Back to cookbooks" title="Back to cookbooks">&larr; Cookbooks</button>
            </div>
            <section class="vc-nav-panel vc-nav-panel-inline">
              <h2 class="vc-nav-title">Contents</h2>
              <ol class="vc-nav-list">${navItems.join("\n")}</ol>
            </section>
            ${musicPanel}
          </div>
        </aside>
        <main class="vc-cookbook-content">
          ${cookbook.reader_intro_html ? `<section class="vc-reader-text">${cookbook.reader_intro_html}</section>` : ""}
          ${cookbook.description ? `<section class="vc-reader-text"><p>${escapeHtml(cookbook.description)}</p></section>` : ""}
          ${bodyParts.join("\n")}
        </main>
      </div>
    </div>
  `;

  const shell = refs.detail.querySelector(".vc-cookbook-shell");
  const navToggle = refs.detail.querySelector("[data-cookbook-nav-toggle]");
  const railInner = refs.detail.querySelector(".vc-cookbook-rail-inner");

  const setNavOpen = (open) => {
    if (!shell || !navToggle) return;
    shell.classList.toggle("vc-nav-open", open);
    navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    navToggle.setAttribute("aria-label", open ? "Close navigation menu" : "Open navigation menu");
  };

  navToggle?.addEventListener("click", () => {
    const expanded = navToggle.getAttribute("aria-expanded") === "true";
    setNavOpen(!expanded);
  });

  refs.detail.querySelectorAll("[data-back-library]").forEach((button) => {
    button.addEventListener("click", () => {
      setNavOpen(false);
      closeCookbook();
    });
  });

  const navButtons = Array.from(refs.detail.querySelectorAll("[data-scroll-target]"));
  navButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const targetId = button.dataset.scrollTarget || "";
      setCurrentNav(button);
      scrollCookbookTarget(targetId);
      if (window.matchMedia("(max-width: 959px)").matches) setNavOpen(false);
    });
  });

  const targetMap = new Map(
    navButtons
      .map((button) => {
        const targetId = button.dataset.scrollTarget || "";
        return targetId ? [targetId, button] : null;
      })
      .filter(Boolean),
  );

  const setCurrentNav = (button) => {
    if (!button) return;
    navButtons.forEach((candidate) => candidate.removeAttribute("aria-current"));
    button.setAttribute("aria-current", "true");
  };
  const setFirstNavAtTop = () => {
    if (window.scrollY <= 6 && navButtons.length > 0) setCurrentNav(navButtons[0]);
  };

  let observer = null;
  if ("IntersectionObserver" in window) {
    observer = new IntersectionObserver(
      (entries) => {
        if (!canSyncCookbookNav()) return;
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio || a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (!visible) return;
        const button = targetMap.get(visible.target.id);
        if (button) setCurrentNav(button);
      },
      {
        rootMargin: "-18% 0px -62% 0px",
        threshold: [0.15, 0.35, 0.6],
      },
    );

    targetMap.forEach((_button, id) => {
      const target = document.getElementById(id);
      if (target) observer.observe(target);
    });
  }

  const onScroll = () => {
    if (!(state.tab === "cookbooks" && state.cookbookSlug)) return;
    if (!canSyncCookbookNav()) return;
    setFirstNavAtTop();
  };
  window.addEventListener("scroll", onScroll, { passive: true });

  const onKeydown = (event) => {
    if (event.key === "Escape") setNavOpen(false);
  };
  const onDocumentClick = (event) => {
    if (!window.matchMedia("(max-width: 959px)").matches) return;
    if (!navToggle || navToggle.getAttribute("aria-expanded") !== "true") return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (navToggle.contains(target)) return;
    if (railInner && railInner.contains(target)) return;
    setNavOpen(false);
  };
  document.addEventListener("keydown", onKeydown);
  document.addEventListener("click", onDocumentClick);

  hydrateMusicLinks(refs.detail);
  hydrateImageFallbacks(refs.detail);
  syncCookbookHeaderHeight();
  syncCookbookRailGeometry();
  requestAnimationFrame(syncCookbookHeaderHeight);
  requestAnimationFrame(syncCookbookRailGeometry);
  setFirstNavAtTop();

  disposeCookbookView = () => {
    window.removeEventListener("scroll", onScroll);
    if (observer) observer.disconnect();
    document.removeEventListener("keydown", onKeydown);
    document.removeEventListener("click", onDocumentClick);
  };

  refs.detail.hidden = false;
  refs.detailEmpty.hidden = true;
  runMorphAnimation();
};

const runMorphAnimation = () => {
  if (!pendingMorphRect) return;

  const target = document.getElementById("vc-detail-surface");
  const startRect = pendingMorphRect;
  pendingMorphRect = null;

  if (!target || !shouldUseMorphAnimation()) return;

  const endRect = target.getBoundingClientRect();
  if (startRect.width < 2 || startRect.height < 2 || endRect.width < 2 || endRect.height < 2) return;
  if (
    Math.abs(startRect.left - endRect.left) < 1 &&
    Math.abs(startRect.top - endRect.top) < 1 &&
    Math.abs(startRect.width - endRect.width) < 1 &&
    Math.abs(startRect.height - endRect.height) < 1
  ) {
    return;
  }

  const overlay = document.createElement("div");
  overlay.className = "vc-morph-overlay";
  overlay.style.left = `${startRect.left}px`;
  overlay.style.top = `${startRect.top}px`;
  overlay.style.width = `${startRect.width}px`;
  overlay.style.height = `${startRect.height}px`;
  document.body.appendChild(overlay);
  target.style.visibility = "hidden";

  const finishMorph = () => {
    target.style.visibility = "visible";
    overlay.remove();
  };

  const timer = window.setTimeout(finishMorph, 420);
  overlay.addEventListener(
    "transitionend",
    () => {
      window.clearTimeout(timer);
      finishMorph();
    },
    { once: true },
  );
  overlay.addEventListener(
    "transitioncancel",
    () => {
      window.clearTimeout(timer);
      finishMorph();
    },
    { once: true },
  );

  requestAnimationFrame(() => {
    overlay.style.transition = "left 260ms cubic-bezier(0.2, 0, 0, 1), top 260ms cubic-bezier(0.2, 0, 0, 1), width 260ms cubic-bezier(0.2, 0, 0, 1), height 260ms cubic-bezier(0.2, 0, 0, 1), border-radius 260ms cubic-bezier(0.2, 0, 0, 1)";
    overlay.style.left = `${endRect.left}px`;
    overlay.style.top = `${endRect.top}px`;
    overlay.style.width = `${endRect.width}px`;
    overlay.style.height = `${endRect.height}px`;
    overlay.style.borderRadius = "24px";
  });
};

const clearMorphArtifacts = () => {
  document.querySelectorAll(".vc-morph-overlay").forEach((node) => node.remove());
  const detailSurface = refs.detail.querySelector("#vc-detail-surface");
  if (detailSurface instanceof HTMLElement) detailSurface.style.visibility = "visible";
};

const render = () => {
  clearMorphArtifacts();
  if (!(state.tab === "cookbooks" && state.cookbookSlug)) clearCookbookBindings();
  renderTabs();
  refs.searchInput.value = state.q;
  refs.searchInput.placeholder = state.tab === "recipes" ? "Search in recipes" : "Search in cookbooks";

  renderFilters();
  renderSidebarFeature();

  if (state.tab === "recipes") {
    renderRecipesList();
    if (state.recipeSlug && !recipesBySlug.has(state.recipeSlug)) {
      state.recipeSlug = "";
      updateHash(true);
      return;
    }
    renderRecipeDetail();
    return;
  }

  if (state.cookbookSlug) {
    renderCookbookFullscreen();
    return;
  }

  renderCookbooksList();
  refs.detail.hidden = true;
  refs.detailEmpty.hidden = true;
};

const setupEvents = () => {
  refs.tabRecipes.addEventListener("click", () => setTab("recipes"));
  refs.tabCookbooks.addEventListener("click", () => setTab("cookbooks"));

  refs.searchInput.addEventListener("input", (event) => {
    state.q = text(event.target.value);
    if (state.tab === "recipes") state.recipeSlug = "";
    if (state.tab === "cookbooks") state.cookbookSlug = "";
    updateHash(true);
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.tab === "recipes" && state.recipeSlug) closeRecipe();
  });

  window.addEventListener("resize", () => {
    const nextWidth = window.innerWidth;
    const nextHeight = window.innerHeight;
    const widthChanged = Math.abs(nextWidth - lastViewportWidth) > 1;
    lastViewportWidth = nextWidth;
    lastViewportHeight = nextHeight;

    refreshImageFocus(refs.list);
    refreshImageFocus(refs.detail);
    if (state.tab === "recipes" && state.recipeSlug && widthChanged) render();
    if (state.tab === "cookbooks" && state.cookbookSlug) {
      syncCookbookHeaderHeight();
      syncCookbookRailGeometry();
      if (window.matchMedia("(min-width: 960px)").matches) {
        refs.detail.querySelector(".vc-cookbook-shell")?.classList.remove("vc-nav-open");
        const toggle = refs.detail.querySelector("[data-cookbook-nav-toggle]");
        if (toggle) {
          toggle.setAttribute("aria-expanded", "false");
          toggle.setAttribute("aria-label", "Open navigation menu");
        }
      }
    }
  });
  recipeMobileQuery.addEventListener?.("change", () => {
    if (state.tab === "recipes" && state.recipeSlug) render();
  });
  window.addEventListener("hashchange", applyStateFromHash);
};

const bootstrap = async () => {
  try {
    const response = await fetch(DATA_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`Failed to fetch ${DATA_URL}: ${response.status}`);
    data = await response.json();
  } catch (error) {
    refs.list.innerHTML = `<div class="vc-empty">Unable to load cookbook content. ${error}</div>`;
    refs.detail.hidden = true;
    refs.detailEmpty.hidden = false;
    return;
  }

  recipesBySlug = new Map((data.recipes || []).map((recipe) => [recipe.slug, recipe]));
  cookbooksBySlug = new Map((data.cookbooks || []).map((cookbook) => [cookbook.slug, cookbook]));

  setupEvents();
  applyStateFromHash();
};

bootstrap();
