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

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
  const tags = new Set(text(params.get("tags")).split(",").map((item) => item.trim()).filter(Boolean));

  return {
    tab,
    recipeSlug: tab === "recipes" ? slug : "",
    cookbookSlug: tab === "cookbooks" ? slug : "",
    q: text(params.get("q")),
    flags,
    tags,
  };
};

const encodeHash = () => {
  const path = state.tab === "recipes" ? `/recipes/${encodeURIComponent(state.recipeSlug || "")}` : `/cookbooks/${encodeURIComponent(state.cookbookSlug || "")}`;
  const params = new URLSearchParams();

  if (state.q) params.set("q", state.q);
  if (state.flags.size > 0) params.set("flags", Array.from(state.flags).sort().join(","));
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
  state.tags = new Set();
  if (tab === "recipes") {
    state.cookbookSlug = "";
  } else {
    state.recipeSlug = "";
  }
  updateHash();
};

const openRecipe = (slug, sourceCard = null) => {
  if (sourceCard instanceof HTMLElement) pendingMorphRect = sourceCard.getBoundingClientRect();
  state.tab = "recipes";
  state.recipeSlug = slug;
  updateHash();
};

const openCookbook = (slug, sourceCard = null) => {
  if (sourceCard instanceof HTMLElement) pendingMorphRect = sourceCard.getBoundingClientRect();
  state.tab = "cookbooks";
  state.cookbookSlug = slug;
  updateHash();
};

const closeRecipe = () => {
  if (!state.recipeSlug) return;
  clearMorphArtifacts();
  pendingMorphRect = null;
  state.recipeSlug = "";
  updateHash();
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
    pill.className = "vc-pill";
    pill.textContent = value;
    row.appendChild(pill);
  });
  return row;
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
      ? `<span class="vc-collage-cell"><img src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async" /></span>`
      : `<span class="vc-collage-cell vc-collage-cell-empty" aria-hidden="true"></span>`;
  }).join("");
  return `<div class="vc-cookbook-collage" aria-hidden="true">${cells}</div>`;
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
    figure.innerHTML = heroHtml || `<img src="${escapeHtml(image)}" alt="" loading="lazy" decoding="async" />`;
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

  card.addEventListener("click", () => onOpen(card));
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
  refs.tabRecipes.setAttribute("aria-selected", recipeSelected ? "true" : "false");
  refs.tabCookbooks.setAttribute("aria-selected", recipeSelected ? "false" : "true");

  refs.app.classList.toggle("vc-mode-recipes", recipeSelected);
  refs.app.classList.toggle("vc-mode-recipe-open", recipeSelected && Boolean(state.recipeSlug));
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
};

const renderFilters = () => {
  clearNode(refs.filterRow);
  if (state.tab !== "recipes" || state.cookbookSlug) return;

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
    refs.filterRow.appendChild(chip);
  });

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
    refs.filterRow.appendChild(chip);
  });
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
    if (recipe.course) pills.push(recipe.course);
    (recipe.tags || []).slice(0, 3).forEach((tag) => pills.push(`#${tag}`));
    if (pills.length < 3 && recipe.serves) pills.push(`Serves ${recipe.serves}`);

    const card = makeCard({
      title: recipe.title,
      body: recipe.menu,
      pills,
      image: recipe.image,
      onOpen: (node) => openRecipe(recipe.slug, node),
    });
    refs.list.appendChild(card);
  });
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
};

const renderRecipeHero = (recipe) => {
  if (!recipe.image) return "";
  const alt = escapeHtml(recipe.image_alt || recipe.title || "Recipe image");
  return `<figure class="vc-hero"><img src="${escapeHtml(recipe.image)}" alt="${alt}" loading="lazy" decoding="async" /></figure>`;
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

  refs.detail.innerHTML = `
    <div class="vc-detail-surface vc-recipe-modal" id="vc-detail-surface" role="dialog" aria-modal="true" aria-label="${escapeHtml(recipe.title)}">
      <header class="vc-modal-head">
        <div class="vc-modal-title-wrap">
          <h2>${escapeHtml(recipe.title)}</h2>
          ${recipe.menu ? `<p class="vc-lede">${escapeHtml(recipe.menu)}</p>` : ""}
        </div>
        <div class="vc-modal-actions">
          <button class="vc-icon-btn vc-icon-btn-plain" type="button" data-copy-recipe aria-label="Copy recipe markdown" title="Copy recipe markdown">
            ${iconClipboard}
          </button>
          <button class="vc-icon-btn vc-icon-btn-plain" type="button" data-share-recipe aria-label="Share recipe link" title="Share recipe link">
            ${iconShare}
          </button>
          <button class="vc-icon-btn vc-close-btn" type="button" data-close-recipe aria-label="Close recipe" title="Close recipe">&times;</button>
        </div>
      </header>
      ${renderRecipeHero(recipe)}
      <div class="vc-meta-row">
        ${recipe.serves ? `<span class="vc-pill">Serves ${escapeHtml(recipe.serves)}</span>` : ""}
        ${recipe.prep ? `<span class="vc-pill">Prep ${escapeHtml(recipe.prep)}</span>` : ""}
        ${recipe.cook ? `<span class="vc-pill">Cook ${escapeHtml(recipe.cook)}</span>` : ""}
        ${recipe.rest ? `<span class="vc-pill">Rest ${escapeHtml(recipe.rest)}</span>` : ""}
      </div>
      <div class="vc-detail-grid">
        <section>
          <h3>Ingredients</h3>
          ${recipe.sections.ingredients_html || "<p>No ingredients section found.</p>"}
        </section>
        <section>
          <h3>Method</h3>
          ${recipe.sections.method_html || "<p>No method section found.</p>"}
          ${recipe.sections.notes_html ? `<h3>Notes</h3>${recipe.sections.notes_html}` : ""}
        </section>
      </div>
      ${recipe.cookbook_slugs.length > 0 ? `<section><h3>In Cookbooks</h3><div class="vc-meta-row">${cookbookLinksHtml(recipe.cookbook_slugs)}</div></section>` : ""}
    </div>
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
  runMorphAnimation();
};

const renderCookbookRecipeCard = (recipe) => {
  return `
    <article class="vc-recipe-card" id="recipe-${escapeHtml(recipe.slug)}">
      <div class="vc-recipe-shell">
        <div class="vc-recipe-col vc-col-left">
          <h2 class="vc-recipe-title">${escapeHtml(recipe.title)}</h2>
          ${recipe.menu ? `<p class="vc-recipe-intro">${escapeHtml(recipe.menu)}</p>` : ""}
          ${renderRecipeHero(recipe)}
          <section class="vc-section vc-section-ingredients">
            <h2 class="vc-ingredients-heading">Ingredients</h2>
            ${recipe.sections.ingredients_html || "<p>No ingredients section found.</p>"}
          </section>
        </div>
        <div class="vc-recipe-col vc-col-right">
          <section class="vc-section vc-section-method">
            <h2 class="vc-method-heading">Method</h2>
            ${recipe.sections.method_html || "<p>No method section found.</p>"}
          </section>
          ${recipe.sections.notes_html ? `<section class="vc-section vc-section-notes"><h2 class="vc-notes-heading">Notes</h2>${recipe.sections.notes_html}</section>` : ""}
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
          <div class="vc-meta-row">
            ${cookbook.author ? `<span class="vc-pill">${escapeHtml(cookbook.author)}</span>` : ""}
            ${cookbook.date ? `<span class="vc-pill">${escapeHtml(cookbook.date)}</span>` : ""}
            <span class="vc-pill">${cookbook.recipe_slugs.length} recipes</span>
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
              <button class="vc-back-btn vc-back-btn-menu" type="button" data-back-library aria-label="Back to cookbooks" title="Back to cookbooks">&larr;</button>
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
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const button = targetMap.get(entry.target.id);
          if (button) setCurrentNav(button);
        });
      },
      {
        rootMargin: "-30% 0px -60% 0px",
        threshold: [0, 1],
      },
    );

    targetMap.forEach((_button, id) => {
      const target = document.getElementById(id);
      if (target) observer.observe(target);
    });
  }

  const onScroll = () => {
    if (!(state.tab === "cookbooks" && state.cookbookSlug)) return;
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

  if (!target || reducedMotion) return;

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

  refs.detail.closest(".vc-detail-pane")?.addEventListener("click", (event) => {
    if (!(state.tab === "recipes" && state.recipeSlug)) return;
    if (event.target === event.currentTarget) closeRecipe();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.tab === "recipes" && state.recipeSlug) closeRecipe();
  });

  window.addEventListener("resize", () => {
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
