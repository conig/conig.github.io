import { MAP_BOUNDS, project } from "./mapProjection.js";
import { STAFFORDSHIRE_BOUNDARY } from "./mapGeometries.js";
import {
  DEFAULT_TIMELINE_END,
  DEFAULT_TIMELINE_START,
  getDisplayEndYear,
  getEventEnd,
  getEventStart,
  getFirstEvidenceYear,
  getLastEvidenceYear,
  getTimelineBounds
} from "./timeline.js";
import {
  countPeopleByGender,
  countPeopleByVariant,
  filterPeopleByActiveFilters,
  getVariantsWithPeople
} from "./variantFilters.js";
import { buildFamilyTree } from "./familyTree.js";

const CLUSTER_GROUP_DISTANCE = 9;
const CLUSTER_SPACING = 14;
const LINEAGE_SPLIT_YEARS = 9;
const SAME_PLACE_SPLIT_PROGRESS = 0.45;
const NON_ROUTE_MOVEMENT_ROLES = new Set(["identity-alias"]);

const CITY_LABELS = [
  { name: "London", lat: 51.5074, lon: -0.1278, minWidth: 0 },
  { name: "Coventry", lat: 52.4068, lon: -1.5197, minWidth: 0 },
  { name: "Stoke Albany", lat: 52.491, lon: -0.814, minWidth: 460 },
  { name: "Stretton", lat: 52.7, lon: -2.1667, minWidth: 500 },
  { name: "Leicester", lat: 52.6369, lon: -1.1398, minWidth: 540 },
  { name: "Kensworth", lat: 51.8517, lon: -0.5039, minWidth: 600 },
  { name: "Windsor", lat: 51.4817, lon: -0.6136, minWidth: 620 },
  { name: "Bardsey", lat: 53.884, lon: -1.445, minWidth: 620 },
  { name: "Hinckley", lat: 52.541, lon: -1.373, minWidth: 680 }
];

const els = {
  canvas: document.querySelector("#mapCanvas"),
  tooltip: document.querySelector("#tooltip"),
  dataStatus: document.querySelector("#dataStatus"),
  yearLabel: document.querySelector("#yearLabel"),
  yearRange: document.querySelector("#yearRange"),
  timelineStartLabel: document.querySelector("#timelineStartLabel"),
  timelineEndLabel: document.querySelector("#timelineEndLabel"),
  playButton: document.querySelector("#playButton"),
  speedSelect: document.querySelector("#speedSelect"),
  visibleCount: document.querySelector("#visibleCount"),
  birthCount: document.querySelector("#birthCount"),
  livedCount: document.querySelector("#livedCount"),
  deathCount: document.querySelector("#deathCount"),
  staffordshireToggle: document.querySelector("#staffordshireToggle"),
  directLineageToggle: document.querySelector("#directLineageToggle"),
  directLineageCount: document.querySelector("#directLineageCount"),
  maleOnlyToggle: document.querySelector("#maleOnlyToggle"),
  maleFilterCount: document.querySelector("#maleFilterCount"),
  variantFilters: document.querySelector("#variantFilters"),
  resetFilters: document.querySelector("#resetFilters"),
  clearVariants: document.querySelector("#clearVariants"),
  recordModal: document.querySelector("#recordModal"),
  recordModalTitle: document.querySelector("#recordModalTitle"),
  recordModalClose: document.querySelector("#recordModalClose"),
  recordDetails: document.querySelector("#recordDetails"),
  recordList: document.querySelector("#recordList"),
  recordTotal: document.querySelector("#recordTotal"),
  leadList: document.querySelector("#leadList"),
  leadTotal: document.querySelector("#leadTotal")
};

const ctx = els.canvas.getContext("2d");
const state = {
  people: [],
  peopleById: new Map(),
  leads: [],
  sources: new Map(),
  englandBoundary: null,
  variants: [],
  activeVariants: new Set(),
  timelineStart: DEFAULT_TIMELINE_START,
  timelineEnd: DEFAULT_TIMELINE_END,
  year: DEFAULT_TIMELINE_END,
  playing: false,
  speed: Number(els.speedSelect.value),
  showStaffordshire: false,
  showDirectLineage: true,
  maleOnly: false,
  hoverId: null,
  selectedId: null,
  lastFrame: 0,
  projected: new Map()
};

init();

async function init() {
  try {
    const [peopleData, leadData, sourceData, boundaryData] = await Promise.all([
      fetchJson("data/people.json"),
      fetchJson("data/research_leads.json"),
      fetchJson("data/sources.json"),
      fetchJson("data/england_boundary.geojson")
    ]);

    state.people = peopleData.people;
    state.peopleById = new Map(state.people.map((person) => [person.id, person]));
    state.variants = peopleData.variants;
    state.activeVariants = new Set(getVariantsWithPeople(state.variants, state.people).map((variant) => variant.key));
    state.leads = leadData.leads;
    state.sources = new Map(sourceData.sources.map((source) => [source.id, source]));
    state.englandBoundary = boundaryData.features?.[0]?.geometry || null;
    setTimelineBounds(getTimelineBounds(state.people, peopleData.coverage));

    const livedOnly = state.people.filter((person) => !person.birth && person.lived?.length).length;
    const familyLeads = state.people.filter(hasOpenFamilyLead).length;
    const deathLeads = state.people.filter(hasOpenDeathResearch).length;
    const genderCounts = countPeopleByGender(state.people);
    els.dataStatus.textContent = `${state.people.length} people, ${genderCounts.get("male") || 0} male, ${livedOnly} lived-only, ${deathLeads} death leads, ${familyLeads} family leads, ${state.leads.length} research leads`;
    renderLayerControls();
    renderGenderFilter();
    renderVariantFilters();
    renderRecordList();
    renderLeadList();
    bindEvents();
    resizeCanvas();
    requestAnimationFrame(tick);
  } catch (error) {
    showLoadError(error);
  }
}

async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Unable to load ${path}: ${response.status}`);
  }
  return response.json();
}

function bindEvents() {
  window.addEventListener("resize", resizeCanvas);

  els.yearRange.addEventListener("input", () => {
    state.year = Number(els.yearRange.value);
    state.playing = false;
    updatePlayButton();
    draw();
  });

  els.playButton.addEventListener("click", () => {
    state.playing = !state.playing;
    updatePlayButton();
  });

  els.speedSelect.addEventListener("change", () => {
    state.speed = Number(els.speedSelect.value);
  });

  els.resetFilters.addEventListener("click", () => {
    state.activeVariants = new Set(getVariantsWithPeople(state.variants, state.people).map((variant) => variant.key));
    state.maleOnly = false;
    state.hoverId = null;
    state.selectedId = null;
    renderGenderFilter();
    renderVariantFilters();
    renderRecordList();
    closeRecordModal();
    draw();
  });

  els.clearVariants.addEventListener("click", () => {
    state.activeVariants.clear();
    state.hoverId = null;
    state.selectedId = null;
    renderVariantFilters();
    renderRecordList();
    closeRecordModal();
    draw();
  });

  els.staffordshireToggle.addEventListener("change", () => {
    state.showStaffordshire = els.staffordshireToggle.checked;
    draw();
  });

  els.directLineageToggle.addEventListener("change", () => {
    state.showDirectLineage = els.directLineageToggle.checked;
    renderRecordList();
    draw();
  });

  els.maleOnlyToggle.addEventListener("change", () => {
    state.maleOnly = els.maleOnlyToggle.checked;
    state.hoverId = null;
    state.selectedId = null;
    renderGenderFilter();
    renderVariantFilters();
    renderRecordList();
    closeRecordModal();
    draw();
  });

  els.canvas.addEventListener("mousemove", handlePointerMove);
  els.canvas.addEventListener("click", handleCanvasClick);
  els.canvas.addEventListener("mouseleave", () => {
    state.hoverId = null;
    els.tooltip.hidden = true;
    draw();
  });

  els.recordModalClose.addEventListener("click", closeRecordModal);
  els.recordDetails.addEventListener("click", handleRecordDetailsClick);
  els.recordModal.addEventListener("click", (event) => {
    if (event.target === els.recordModal) {
      closeRecordModal();
    }
  });
  els.recordModal.addEventListener("close", () => {
    state.selectedId = null;
    state.hoverId = null;
    els.tooltip.hidden = true;
    renderRecordList();
    draw();
  });
}

function resizeCanvas() {
  const rect = els.canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  els.canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  els.canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  draw();
}

function tick(timestamp) {
  if (!state.lastFrame) {
    state.lastFrame = timestamp;
  }
  const deltaSeconds = Math.min(0.08, (timestamp - state.lastFrame) / 1000);
  state.lastFrame = timestamp;

  if (state.playing) {
    state.year += deltaSeconds * state.speed;
    if (state.year > state.timelineEnd) {
      state.year = state.timelineStart;
    }
    els.yearRange.value = Math.round(state.year);
    draw();
  }

  requestAnimationFrame(tick);
}

function updatePlayButton() {
  els.playButton.textContent = state.playing ? "Pause" : "Play";
  els.playButton.setAttribute("aria-pressed", String(state.playing));
}

function setTimelineBounds(bounds) {
  state.timelineStart = bounds.startYear;
  state.timelineEnd = bounds.endYear;
  state.year = bounds.endYear;
  els.yearRange.min = String(bounds.startYear);
  els.yearRange.max = String(bounds.endYear);
  els.yearRange.value = String(bounds.endYear);
  els.timelineStartLabel.textContent = String(bounds.startYear);
  els.timelineEndLabel.textContent = String(bounds.endYear);
  els.yearLabel.value = bounds.endYear;
}

function draw() {
  const width = els.canvas.clientWidth;
  const height = els.canvas.clientHeight;
  const year = Math.round(state.year);
  state.projected.clear();

  els.yearLabel.value = year;
  drawBaseMap(width, height);

  const visiblePeople = getActivePeople()
    .filter((person) => isVisibleInYear(person, state.year));
  const frameLayout = createFrameLayout(visiblePeople, state.year, width, height);

  for (const entry of frameLayout.values()) {
    drawTrack(entry);
  }

  drawLineageSplits(frameLayout);

  for (const entry of frameLayout.values()) {
    drawPerson(entry, state.year);
  }

  renderStats(year, visiblePeople);
}

function drawBaseMap(width, height) {
  ctx.clearRect(0, 0, width, height);
  const seaGradient = ctx.createLinearGradient(0, 0, width, height);
  seaGradient.addColorStop(0, getCss("--sea"));
  seaGradient.addColorStop(1, getCss("--sea-deep"));
  ctx.fillStyle = seaGradient;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.globalAlpha = width < 520 ? 0.16 : 0.22;
  ctx.strokeStyle = "#72949c";
  ctx.lineWidth = 1;
  for (let lon = Math.ceil(MAP_BOUNDS.minLon); lon <= MAP_BOUNDS.maxLon; lon += 1) {
    const top = project(lon, MAP_BOUNDS.maxLat, width, height);
    const bottom = project(lon, MAP_BOUNDS.minLat, width, height);
    line(top.x, top.y, bottom.x, bottom.y);
  }
  for (let lat = Math.ceil(MAP_BOUNDS.minLat); lat <= MAP_BOUNDS.maxLat; lat += 1) {
    const left = project(MAP_BOUNDS.minLon, lat, width, height);
    const right = project(MAP_BOUNDS.maxLon, lat, width, height);
    line(left.x, left.y, right.x, right.y);
  }
  ctx.restore();

  ctx.save();
  const landGradient = ctx.createLinearGradient(0, 0, width, height);
  landGradient.addColorStop(0, getCss("--land"));
  landGradient.addColorStop(1, getCss("--land-warm"));
  ctx.fillStyle = landGradient;
  ctx.strokeStyle = getCss("--land-edge");
  ctx.lineWidth = width < 520 ? 1.5 : 2;
  ctx.shadowColor = "rgba(17, 29, 24, 0.22)";
  ctx.shadowBlur = width < 520 ? 9 : 14;
  ctx.shadowOffsetY = width < 520 ? 2 : 3;
  drawGeoJsonGeometry(state.englandBoundary, width, height);
  ctx.restore();

  if (state.showStaffordshire) {
    drawStaffordshireBoundary(width, height);
  }

  drawPlaceLabels(width, height);
}

function drawStaffordshireBoundary(width, height) {
  ctx.save();
  ctx.beginPath();
  STAFFORDSHIRE_BOUNDARY.ring.forEach(([lon, lat], index) => {
    const point = project(lon, lat, width, height);
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.closePath();
  ctx.fillStyle = getCss("--staffordshire-fill");
  ctx.strokeStyle = getCss("--staffordshire-edge");
  ctx.lineWidth = 2.4;
  ctx.setLineDash([7, 5]);
  ctx.fill();
  ctx.stroke();

  const label = project(STAFFORDSHIRE_BOUNDARY.centroid.lon, STAFFORDSHIRE_BOUNDARY.centroid.lat, width, height);
  ctx.setLineDash([]);
  ctx.fillStyle = getCss("--staffordshire-edge");
  ctx.strokeStyle = "rgba(255, 253, 247, 0.72)";
  ctx.lineWidth = 4;
  ctx.font = "800 13px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.strokeText(STAFFORDSHIRE_BOUNDARY.label, label.x, label.y);
  ctx.fillText(STAFFORDSHIRE_BOUNDARY.label, label.x, label.y);
  ctx.restore();
}

function drawPlaceLabels(width, height) {
  ctx.save();
  const compact = width < 520;
  ctx.fillStyle = "rgba(23, 33, 29, 0.66)";
  ctx.strokeStyle = "rgba(255, 253, 247, 0.7)";
  ctx.lineWidth = 3;
  ctx.font = `700 ${compact ? 10.5 : 12}px Inter, system-ui, sans-serif`;
  for (const city of CITY_LABELS) {
    if (width < city.minWidth) continue;

    const point = project(city.lon, city.lat, width, height);
    const alignRight = point.x > width - (compact ? 84 : 108);
    const textX = point.x + (alignRight ? -7 : 7);
    const textY = clamp(point.y + 4, 14, height - 10);
    ctx.textAlign = alignRight ? "right" : "left";

    ctx.beginPath();
    ctx.arc(point.x, point.y, 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeText(city.name, textX, textY);
    ctx.fillText(city.name, textX, textY);
  }
  ctx.restore();
}

function drawTrack(entry) {
  if (!entry.pathStart || !entry.point) return;

  ctx.save();
  const isLineage = isDirectLineage(entry.person) && state.showDirectLineage;
  ctx.globalAlpha = isLineage ? 0.46 : 0.16;
  ctx.strokeStyle = isLineage ? getCss("--direct-lineage") : getVariantColor(entry.person.surnameVariant);
  ctx.lineWidth = isLineage ? 3 : 1.2;
  if (isLineage) ctx.setLineDash([8, 5]);
  ctx.beginPath();
  ctx.moveTo(entry.pathStart.x, entry.pathStart.y);
  ctx.lineTo(entry.point.x, entry.point.y);
  ctx.stroke();
  ctx.restore();
}

function drawLineageSplits(frameLayout) {
  ctx.save();
  ctx.setLineDash([4, 5]);
  ctx.lineCap = "round";
  for (const entry of frameLayout.values()) {
    if (!entry.lineageSplit) continue;
    const { start, progress } = entry.lineageSplit;
    const lineAlpha = Math.sin(progress * Math.PI) * 0.34;
    if (lineAlpha <= 0.01) continue;
    ctx.globalAlpha = lineAlpha;
    ctx.strokeStyle = getVariantColor(entry.person.surnameVariant);
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(entry.point.x, entry.point.y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPerson(entry, year) {
  const { person, point: position } = entry;
  if (!position) return;

  const isHover = state.hoverId === person.id;
  const isSelected = state.selectedId === person.id;
  const isHighlighted = isHover || isSelected;
  const fade = getLifeOpacity(person, year);
  const color = getVariantColor(person.surnameVariant);
  const radius = isHighlighted ? 8.5 : 5 + Math.max(0, person.confidence - 0.7) * 7;
  const isLineage = isDirectLineage(person) && state.showDirectLineage;

  state.projected.set(person.id, { ...position, radius: isLineage ? radius + 5 : radius, person });

  ctx.save();
  ctx.globalAlpha = fade;
  if (isLineage) {
    ctx.fillStyle = "rgba(241, 198, 75, 0.62)";
    ctx.strokeStyle = getCss("--direct-lineage");
    ctx.lineWidth = isHighlighted ? 4 : 3;
    ctx.beginPath();
    ctx.arc(position.x, position.y, radius + 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.fillStyle = color;
  ctx.strokeStyle = "rgba(255, 253, 247, 0.95)";
  ctx.lineWidth = isHighlighted ? 3 : 2;
  ctx.beginPath();
  ctx.arc(position.x, position.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  if (isSelected) {
    ctx.globalAlpha = fade * 0.42;
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(position.x, position.y, radius + 7, 0, Math.PI * 2);
    ctx.stroke();
  }

  const eventPulse = getEventPulse(person, year);
  if (eventPulse > 0) {
    ctx.globalAlpha = eventPulse * 0.32;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(position.x, position.y, radius + (1 - eventPulse) * 28, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function renderStats(year, visiblePeople) {
  const activePeople = getActivePeople();
  const births = activePeople.filter((person) => person.birth?.year === year).length;
  const lived = activePeople.filter((person) => {
    return (person.lived || []).some((event) => year >= getEventStart(event) && year <= getEventEnd(event));
  }).length;
  const deaths = activePeople.filter((person) => person.death?.year === year).length;

  els.visibleCount.textContent = visiblePeople.length;
  els.birthCount.textContent = births;
  els.livedCount.textContent = lived;
  els.deathCount.textContent = deaths;
}

function renderGenderFilter() {
  const genderCounts = countPeopleByGender(state.people);
  els.maleOnlyToggle.checked = state.maleOnly;
  els.maleFilterCount.textContent = `${genderCounts.get("male") || 0}/${state.people.length}`;
}

function renderLayerControls() {
  const directLineageCount = state.people.filter(isDirectLineage).length;
  els.staffordshireToggle.checked = state.showStaffordshire;
  els.directLineageToggle.checked = state.showDirectLineage;
  els.directLineageCount.textContent = `(${directLineageCount})`;
}

function renderVariantFilters() {
  const people = getGenderFilteredPeople();
  const counts = countPeopleByVariant(people);
  els.clearVariants.disabled = state.activeVariants.size === 0;
  els.variantFilters.replaceChildren(...getVariantsWithPeople(state.variants, people, counts).map((variant) => {
    const label = document.createElement("label");
    label.className = "variant-item";
    label.innerHTML = `
      <input type="checkbox" ${state.activeVariants.has(variant.key) ? "checked" : ""}>
      <span class="swatch" style="background:${variant.color}"></span>
      <span>${variant.label} <span class="subtle">(${counts.get(variant.key) || 0})</span></span>
    `;
    const input = label.querySelector("input");
    input.addEventListener("change", () => {
      if (input.checked) state.activeVariants.add(variant.key);
      else state.activeVariants.delete(variant.key);
      state.hoverId = null;
      state.selectedId = null;
      renderVariantFilters();
      renderRecordList();
      closeRecordModal();
      draw();
    });
    return label;
  }));
}

function renderRecordList() {
  const visible = getActivePeople()
    .sort((a, b) => getFirstEvidenceYear(a) - getFirstEvidenceYear(b) || a.displayName.localeCompare(b.displayName));

  els.recordTotal.textContent = `${visible.length}/${state.people.length}`;
  els.recordList.replaceChildren(...visible.map((person) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "record-row";
    if (state.selectedId === person.id) {
      row.classList.add("is-selected");
    }
    if (isDirectLineage(person) && state.showDirectLineage) {
      row.classList.add("is-direct-lineage");
    }
    row.setAttribute("aria-pressed", String(state.selectedId === person.id));
    row.style.borderLeftColor = getVariantColor(person.surnameVariant);
    row.innerHTML = `
      <strong>${person.displayName}</strong>
      <span>${formatRecordSummary(person)} · ${formatPrimaryPlace(person)}</span>
      <span>${formatDeathPlace(person)}</span>
    `;
    row.addEventListener("click", () => {
      state.year = Math.min(state.timelineEnd, Math.max(state.timelineStart, getFirstEvidenceYear(person)));
      els.yearRange.value = state.year;
      state.hoverId = person.id;
      state.selectedId = person.id;
      openRecordModal(person);
      renderRecordList();
      draw();
    });
    return row;
  }));
}

function getActivePeople() {
  return filterPeopleByActiveFilters(state.people, state.activeVariants, { maleOnly: state.maleOnly });
}

function isDirectLineage(person) {
  return person.lineage?.role === "direct-paternal-ancestor";
}

function getGenderFilteredPeople() {
  if (!state.maleOnly) return state.people;
  return state.people.filter((person) => person.gender === "male");
}

function renderLeadList() {
  els.leadTotal.textContent = `${state.leads.length}`;
  els.leadList.replaceChildren(...state.leads.map((lead) => {
    const row = document.createElement("article");
    row.className = "lead-row";
    row.innerHTML = `
      <strong>${lead.label}</strong>
      <span>${lead.variant} · ${lead.period}</span>
      <span>${lead.summary}</span>
      <span class="subtle">Next: ${lead.nextAction}</span>
    `;
    return row;
  }));
}

function openRecordModal(person, options = {}) {
  els.recordModalTitle.textContent = person.displayName;
  const sourceLinks = person.sourceIds
    .map((id) => state.sources.get(id))
    .filter(Boolean)
    .map((source) => `<a href="${source.url}" target="_blank" rel="noreferrer">${source.shortTitle}</a>`)
    .join("");

  els.recordDetails.innerHTML = `
    <div class="record-view-toggle" role="tablist" aria-label="Record view">
      <button type="button" class="view-toggle is-active" data-record-view="details" role="tab" aria-selected="true">Details</button>
      <button type="button" class="view-toggle" data-record-view="family" role="tab" aria-selected="false">Family tree</button>
    </div>
    <div data-modal-panel="details">
      <div class="detail-line">${formatRecordSummary(person)} · ${variantLabel(person.surnameVariant)}</div>
      ${formatLineageLine(person)}
      <div class="detail-line">Gender: ${formatGender(person.gender)}</div>
      ${formatAlternateNames(person)}
      <div class="detail-line">First evidence: ${formatPrimaryPlace(person)}</div>
      ${formatBirthLine(person)}
      ${formatLivedLines(person)}
      ${formatFamilyLines(person)}
      <div class="detail-line">Died: ${formatDeathPlace(person)}</div>
      <div class="detail-line">Confidence: ${Math.round(person.confidence * 100)}%</div>
      <div class="detail-line">Record updated: ${person.lastUpdated || "not recorded"}</div>
      <div class="detail-line">${person.notes}</div>
      <div class="source-links">${sourceLinks}</div>
    </div>
    <div id="familyTreePanel" data-modal-panel="family" hidden></div>
  `;
  renderFamilyTreePanel(person, els.recordDetails.querySelector("#familyTreePanel"));
  setRecordModalView(options.view || "details");

  if (!els.recordModal.open) {
    els.recordModal.showModal();
  }
}

function closeRecordModal() {
  if (els.recordModal.open) {
    els.recordModal.close();
  } else {
    state.selectedId = null;
    state.hoverId = null;
    els.tooltip.hidden = true;
    renderRecordList();
  }
}

function handleRecordDetailsClick(event) {
  const viewButton = event.target.closest("[data-record-view]");
  if (viewButton) {
    setRecordModalView(viewButton.dataset.recordView);
    return;
  }

  const personButton = event.target.closest("[data-person-id]");
  if (!personButton) return;

  const person = state.peopleById.get(personButton.dataset.personId);
  if (!person) return;

  const stayInTree = Boolean(personButton.closest("[data-modal-panel='family']"));
  state.selectedId = person.id;
  state.hoverId = person.id;
  openRecordModal(person, { view: stayInTree ? "family" : "details" });
  renderRecordList();
  draw();
}

function setRecordModalView(view) {
  const nextView = view === "family" ? "family" : "details";
  els.recordDetails.querySelectorAll("[data-record-view]").forEach((button) => {
    const isActive = button.dataset.recordView === nextView;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });
  els.recordDetails.querySelectorAll("[data-modal-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.modalPanel !== nextView;
  });
}

function renderFamilyTreePanel(person, panel) {
  if (!panel) return;

  const tree = buildFamilyTree(state.people, person.id);
  const wrapper = document.createElement("div");
  wrapper.className = "family-tree";

  const confirmedCount = Number(Boolean(tree.father)) + tree.siblings.length + tree.children.length;
  const summary = document.createElement("p");
  summary.className = "family-tree__summary";
  summary.textContent = confirmedCount
    ? `${confirmedCount} confirmed in-database family link${confirmedCount === 1 ? "" : "s"} shown.`
    : "No confirmed in-database family links have been recorded for this person yet.";
  wrapper.append(summary);

  const canvas = document.createElement("div");
  canvas.className = "family-tree__canvas";
  appendFamilyGeneration(canvas, "Father", tree.father ? [tree.father] : [], {
    emptyText: `No linked father · ${formatStatusLabel(tree.statuses.father)}`
  });
  appendFamilyBranch(canvas, Boolean(tree.father));
  appendFamilyGeneration(canvas, tree.siblings.length ? "Person and siblings" : "Person", getCenteredFamilyRow(tree.root, tree.siblings), {
    connected: Boolean(tree.father),
    currentId: tree.root.id
  });
  appendFamilyBranch(canvas, tree.children.length > 0);
  appendFamilyGeneration(canvas, "Children", tree.children, {
    connected: tree.children.length > 0,
    emptyText: `No linked children · ${formatStatusLabel(tree.statuses.children)}`
  });
  wrapper.append(canvas);

  const notes = createFamilyResearchNotes(tree);
  if (notes) wrapper.append(notes);

  panel.replaceChildren(wrapper);
}

function appendFamilyGeneration(container, label, people, options = {}) {
  const generation = document.createElement("section");
  generation.className = "family-generation";

  const heading = document.createElement("h3");
  heading.className = "family-generation__label";
  heading.textContent = label;
  generation.append(heading);

  const nodes = document.createElement("div");
  nodes.className = "family-generation__nodes";
  if (options.connected) {
    nodes.classList.add("family-generation__nodes--connected");
  }
  if (people.length) {
    nodes.append(...people.map((person) => createFamilyNode(person, {
      connected: options.connected,
      current: person.id === options.currentId
    })));
  } else {
    const empty = document.createElement("div");
    empty.className = "family-node family-node--empty";
    empty.textContent = options.emptyText || "No linked person";
    nodes.append(empty);
  }

  generation.append(nodes);
  container.append(generation);
}

function appendFamilyBranch(container, active) {
  const branch = document.createElement("div");
  branch.className = active ? "family-branch" : "family-branch family-branch--muted";
  branch.setAttribute("aria-hidden", "true");
  container.append(branch);
}

function createFamilyNode(person, options = {}) {
  const node = document.createElement(options.current ? "div" : "button");
  node.className = options.current ? "family-node family-node--current" : "family-node";
  if (options.connected) {
    node.classList.add("family-node--connected");
  }
  if (!options.current) {
    node.type = "button";
    node.dataset.personId = person.id;
  }

  const name = document.createElement("strong");
  name.textContent = person.displayName;
  const meta = document.createElement("span");
  meta.textContent = `${formatRecordSummary(person)} · ${variantLabel(person.surnameVariant)}`;
  node.append(name, meta);
  return node;
}

function createFamilyResearchNotes(tree) {
  const items = [];
  if (tree.candidates.fathers.length) {
    items.push(createResearchNote("Candidate father", tree.candidates.fathers.map(createInlinePersonButton)));
  } else if (tree.external.father) {
    items.push(createResearchNote("External father", [document.createTextNode(tree.external.father)]));
  }

  if (tree.candidates.children.length) {
    items.push(createResearchNote("Candidate children", tree.candidates.children.map(createInlinePersonButton)));
  }

  if (tree.external.children.length) {
    items.push(createResearchNote("External children", tree.external.children.map((child) => {
      return document.createTextNode(child.displayName);
    })));
  }

  if (!items.length) return null;

  const notes = document.createElement("div");
  notes.className = "family-tree__notes";
  const heading = document.createElement("h3");
  heading.textContent = "Research Notes";
  const list = document.createElement("ul");
  list.append(...items);
  notes.append(heading, list);
  return notes;
}

function createResearchNote(label, values) {
  const item = document.createElement("li");
  const strong = document.createElement("strong");
  strong.textContent = `${label}: `;
  item.append(strong);
  values.forEach((value, index) => {
    if (index > 0) item.append(document.createTextNode(", "));
    item.append(value);
  });
  return item;
}

function createInlinePersonButton(person) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "family-note-link";
  button.dataset.personId = person.id;
  button.textContent = person.displayName;
  return button;
}

function getCenteredFamilyRow(root, siblings) {
  const sortedSiblings = [...siblings].sort(compareFamilyNodes);
  const splitIndex = Math.ceil(sortedSiblings.length / 2);
  return [
    ...sortedSiblings.slice(0, splitIndex),
    root,
    ...sortedSiblings.slice(splitIndex)
  ];
}

function compareFamilyNodes(a, b) {
  return getFirstEvidenceYear(a) - getFirstEvidenceYear(b)
    || a.displayName.localeCompare(b.displayName)
    || a.id.localeCompare(b.id);
}

function handlePointerMove(event) {
  const rect = els.canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const nearest = getNearestProjectedPoint(x, y);

  if (!nearest) {
    state.hoverId = null;
    els.tooltip.hidden = true;
    draw();
    return;
  }

  state.hoverId = nearest.person.id;
  els.tooltip.hidden = false;
  els.tooltip.style.left = `${Math.min(rect.width - 18, x + 14)}px`;
  els.tooltip.style.top = `${Math.max(12, y - 18)}px`;
  els.tooltip.innerHTML = `<strong>${nearest.person.displayName}</strong>${formatRecordSummary(nearest.person)}<br>${formatLineageTooltip(nearest.person)}${formatPrimaryPlace(nearest.person)}`;
  draw();
}

function handleCanvasClick(event) {
  const rect = els.canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const nearest = getNearestProjectedPoint(x, y);

  if (!nearest) {
    state.selectedId = null;
    state.hoverId = null;
    closeRecordModal();
    renderRecordList();
    draw();
    return;
  }

  state.selectedId = nearest.person.id;
  state.hoverId = nearest.person.id;
  openRecordModal(nearest.person);
  renderRecordList();
  draw();
}

function getNearestProjectedPoint(x, y) {
  let nearest = null;
  let nearestDistance = Infinity;
  const hitRadius = els.canvas.clientWidth < 520 ? 20 : 12;

  for (const point of state.projected.values()) {
    const distance = Math.hypot(point.x - x, point.y - y);
    if (distance < Math.max(hitRadius, point.radius + 8) && distance < nearestDistance) {
      nearest = point;
      nearestDistance = distance;
    }
  }

  return nearest;
}

function isVisibleInYear(person, year) {
  const firstYear = getFirstEvidenceYear(person);
  if (year < firstYear) return false;

  if (person.birth) {
    return year <= getDisplayEndYear(person, state.timelineEnd);
  }

  if (!person.death?.year) {
    return year <= getDisplayEndYear(person, state.timelineEnd);
  }

  return year <= getDisplayEndYear(person, state.timelineEnd);
}

function createFrameLayout(visiblePeople, year, width, height) {
  const entries = visiblePeople
    .map((person) => {
      const basePoint = getBasePersonPosition(person, year, width, height);
      if (!basePoint) return null;
      return {
        person,
        basePoint,
        point: basePoint,
        pathStart: getPathStart(person, width, height),
        lineageSplit: null
      };
    })
    .filter(Boolean)
    .sort(compareEntries);

  applyClusterOffsets(entries, width, height);
  applyLineageSplits(entries, year);

  return new Map(entries.map((entry) => [entry.person.id, entry]));
}

function applyClusterOffsets(entries, width, height) {
  const clusters = [];
  for (const entry of entries) {
    const cluster = clusters.find((candidate) => distance(candidate.anchor, entry.basePoint) <= CLUSTER_GROUP_DISTANCE);
    if (cluster) {
      cluster.members.push(entry);
      cluster.anchor = averagePoint(cluster.members.map((member) => member.basePoint));
    } else {
      clusters.push({ anchor: entry.basePoint, members: [entry] });
    }
  }

  for (const cluster of clusters) {
    if (cluster.members.length === 1) {
      cluster.members[0].point = cluster.members[0].basePoint;
      continue;
    }

    cluster.members.sort(compareEntries);
    cluster.members.forEach((entry, index) => {
      const offset = getClusterOffset(index, cluster.members.length);
      entry.point = constrainPoint({
        x: entry.basePoint.x + offset.x,
        y: entry.basePoint.y + offset.y
      }, width, height);
    });
  }
}

function applyLineageSplits(entries, year) {
  const byId = new Map(entries.map((entry) => [entry.person.id, entry]));
  const ordered = [...entries].sort((a, b) => getFirstEvidenceYear(a.person) - getFirstEvidenceYear(b.person));

  for (const entry of ordered) {
    const fatherId = entry.person.family?.father?.personId;
    if (!fatherId) continue;

    const startYear = getFirstEvidenceYear(entry.person);
    const elapsed = year - startYear;
    if (elapsed < 0 || elapsed > LINEAGE_SPLIT_YEARS) continue;

    const fatherEntry = byId.get(fatherId);
    if (!fatherEntry?.point) continue;

    const easedProgress = easeInOut(clamp(elapsed / LINEAGE_SPLIT_YEARS, 0, 1));
    const target = entry.point;
    const samePlaceSplit = distance(fatherEntry.point, target) <= CLUSTER_SPACING * 2;
    const progress = samePlaceSplit
      ? SAME_PLACE_SPLIT_PROGRESS + (1 - SAME_PLACE_SPLIT_PROGRESS) * easedProgress
      : easedProgress;
    entry.point = lerpPoint(fatherEntry.point, target, progress);
    entry.lineageSplit = {
      fatherId,
      start: fatherEntry.point,
      target,
      progress
    };
  }
}

function getBasePersonPosition(person, year, width, height) {
  const timeline = getTimedLocations(person, width, height);
  if (!timeline.length) return null;

  const active = timeline
    .filter((item) => year >= item.animationStartYear && year <= item.animationEndYear)
    .sort((a, b) => b.animationStartYear - a.animationStartYear)[0];
  if (active) return active.point;

  const milestones = timeline
    .map((item) => ({ ...item, year: item.animationStartYear }))
    .sort((a, b) => a.year - b.year);

  const first = milestones[0];
  if (year <= first.year) return first.point;

  const previous = milestones.filter((item) => item.year <= year).at(-1);
  const next = milestones.find((item) => item.year >= year);

  if (previous && next && previous !== next) {
    const progress = clamp((year - previous.year) / Math.max(1, next.year - previous.year), 0, 1);
    return lerpPoint(previous.point, next.point, easeInOut(progress));
  }

  if (person.death?.outsideEngland && person.death.year <= state.timelineEnd && previous) {
    const exit = getExitPoint(previous.point, person.death.exit || "southEast", width, height);
    const progress = clamp((year - previous.year) / Math.max(1, person.death.year - previous.year), 0, 1);
    return lerpPoint(previous.point, exit, easeInOut(progress));
  }

  return previous?.point || first.point;
}

function compareEntries(a, b) {
  return getFirstEvidenceYear(a.person) - getFirstEvidenceYear(b.person)
    || a.person.displayName.localeCompare(b.person.displayName)
    || a.person.id.localeCompare(b.person.id);
}

function getClusterOffset(index, total) {
  if (total <= 1) return { x: 0, y: 0 };
  if (total === 2) {
    return { x: index === 0 ? -CLUSTER_SPACING / 2 : CLUSTER_SPACING / 2, y: 0 };
  }

  const ring = Math.floor(index / 8);
  const ringIndex = index % 8;
  const ringSize = Math.min(8, total - ring * 8);
  const radius = CLUSTER_SPACING * (0.76 + ring * 0.82);
  const angle = -Math.PI / 2 + (Math.PI * 2 * ringIndex) / ringSize;
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius
  };
}

function averagePoint(points) {
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length
  };
}

function constrainPoint(point, width, height) {
  const margin = 8;
  return {
    x: clamp(point.x, margin, width - margin),
    y: clamp(point.y, margin, height - margin)
  };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function getExitPoint(origin, direction, width, height) {
  const margin = 40;
  const directions = {
    southEast: { x: width + margin, y: height - margin },
    south: { x: origin.x, y: height + margin },
    east: { x: width + margin, y: origin.y },
    west: { x: -margin, y: origin.y }
  };
  return directions[direction] || directions.southEast;
}

function getLifeOpacity(person, year) {
  const firstYear = getFirstEvidenceYear(person);
  const birthFade = clamp((year - firstYear) / 4, 0.18, 1);
  if (!person.death?.year) {
    const displayEnd = getDisplayEndYear(person, state.timelineEnd);
    const unknownDeathFade = clamp((displayEnd - year) / 6, 0.14, 1);
    return Math.min(birthFade, unknownDeathFade);
  }
  if (person.death.year > state.timelineEnd) return birthFade;
  const deathFade = clamp((person.death.year - year) / 6, 0.14, 1);
  return Math.min(birthFade, deathFade);
}

function getEventPulse(person, year) {
  const eventYears = [];
  if (person.birth?.year) eventYears.push(person.birth.year);
  for (const event of person.lived || []) {
    eventYears.push(getEventStart(event));
    eventYears.push(getEventEnd(event));
  }
  if (person.death?.year) eventYears.push(person.death.year);
  const distance = Math.min(...eventYears.map((eventYear) => Math.abs(year - eventYear)));
  if (distance > 3) return 0;
  return 1 - distance / 3;
}

function getPathStart(person, width, height) {
  const first = getTimedLocations(person, width, height)[0];
  return first?.point || null;
}

function getTimedLocations(person, width, height) {
  const locations = [];
  if (person.birth) {
    addTimedLocation(locations, person.birth, {
      type: "birth",
      startYear: person.birth.year,
      endYear: person.birth.year,
      width,
      height
    });
  }

  for (const event of person.lived || []) {
    addTimedLocation(locations, event, {
      type: "lived",
      startYear: getEventStart(event),
      endYear: getEventEnd(event),
      width,
      height
    });
  }

  if (person.death?.country === "England" && person.death.year <= state.timelineEnd) {
    addTimedLocation(locations, person.death, {
      type: "death",
      startYear: person.death.year,
      endYear: person.death.year,
      width,
      height
    });
  }

  const routeLocations = locations.filter((location) => isRouteLocation(location.location));
  const animationLocations = routeLocations.length ? routeLocations : locations;
  return assignAnimationYears(animationLocations)
    .sort((a, b) => a.animationStartYear - b.animationStartYear || a.animationEndYear - b.animationEndYear || compareTimedLocations(a, b));
}

function addTimedLocation(locations, location, options) {
  const point = projectLocation(location, options.width, options.height);
  if (!point) return;
  locations.push({
    type: options.type,
    startYear: options.startYear,
    endYear: options.endYear,
    point,
    location,
    sequence: locations.length
  });
}

function isRouteLocation(location) {
  return !NON_ROUTE_MOVEMENT_ROLES.has(location.movementRole);
}

function assignAnimationYears(locations) {
  const byYear = new Map();
  for (const location of locations) {
    const key = location.startYear;
    if (!byYear.has(key)) byYear.set(key, []);
    byYear.get(key).push(location);
  }

  const animated = [];
  for (const group of byYear.values()) {
    const pointEvents = group.filter((location) => location.startYear === location.endYear);
    const rangeEvents = group.filter((location) => location.startYear !== location.endYear);
    animated.push(...rangeEvents.map((location) => ({
      ...location,
      animationStartYear: location.startYear,
      animationEndYear: location.endYear
    })));

    if (!pointEvents.length) continue;
    if (new Set(pointEvents.map((location) => getPointKey(location.point))).size <= 1) {
      animated.push(...pointEvents.map((location) => ({
        ...location,
        animationStartYear: location.startYear,
        animationEndYear: location.endYear
      })));
      continue;
    }

    const ordered = [...pointEvents].sort(compareTimedLocations);
    const denominator = Math.max(1, ordered.length - 1);
    ordered.forEach((location, index) => {
      const animationYear = location.startYear + index / denominator;
      animated.push({
        ...location,
        animationStartYear: animationYear,
        animationEndYear: animationYear
      });
    });
  }

  return animated;
}

function compareTimedLocations(a, b) {
  return getMovementOrder(a.location) - getMovementOrder(b.location)
    || getDateSortValue(a.location) - getDateSortValue(b.location)
    || a.type.localeCompare(b.type)
    || a.sequence - b.sequence;
}

function getMovementOrder(location) {
  return Number.isInteger(location.movementOrder) ? location.movementOrder : Number.MAX_SAFE_INTEGER;
}

function getDateSortValue(location) {
  if (!location.date) return Number.MAX_SAFE_INTEGER;
  const parsed = Date.parse(`${location.date}T00:00:00Z`);
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

function getPointKey(point) {
  return `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
}

function projectLocation(location, width, height) {
  if (typeof location.lat !== "number" || typeof location.lon !== "number") return null;
  return project(location.lon, location.lat, width, height);
}

function line(x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function drawPolygonRing(ring, width, height) {
  ring.forEach(([lon, lat], index) => {
    const point = project(lon, lat, width, height);
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.closePath();
}

function drawGeoJsonGeometry(geometry, width, height) {
  if (!geometry) return;

  const polygons = geometry.type === "MultiPolygon"
    ? geometry.coordinates
    : geometry.type === "Polygon"
      ? [geometry.coordinates]
      : [];

  for (const polygon of polygons) {
    ctx.beginPath();
    for (const ring of polygon) {
      drawPolygonRing(ring, width, height);
    }
    ctx.fill("evenodd");
    ctx.stroke();
  }
}

function lerpPoint(a, b, progress) {
  return {
    x: a.x + (b.x - a.x) * progress,
    y: a.y + (b.y - a.y) * progress
  };
}

function easeInOut(value) {
  return value < 0.5 ? 2 * value * value : 1 - Math.pow(-2 * value + 2, 2) / 2;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getVariantColor(key) {
  return state.variants.find((variant) => variant.key === key)?.color || getCss("--accent");
}

function variantLabel(key) {
  return state.variants.find((variant) => variant.key === key)?.label || key;
}

function formatLife(person) {
  const birth = person.birth?.date || String(person.birth?.year);
  const death = person.death?.date || (person.death?.year ? String(person.death.year) : `after ${state.timelineEnd} or unknown`);
  return `${birth} to ${death}`;
}

function formatRecordSummary(person) {
  if (person.birth) return formatLife(person);
  const first = getFirstEvidenceYear(person);
  const last = getLastEvidenceYear(person);
  if (first === last) return `Attested ${first}`;
  return `Lived ${first} to ${last}`;
}

function formatPrimaryPlace(person) {
  if (person.birth?.place) return person.birth.place;
  const first = [...(person.lived || [])].sort((a, b) => getEventStart(a) - getEventStart(b))[0];
  return first?.place || person.death?.place || "Place not yet sourced";
}

function formatBirthLine(person) {
  if (!person.birth) return "";
  return `<div class="detail-line">Born: ${person.birth.place}</div>`;
}

function formatLivedLines(person) {
  if (!person.lived?.length) return "";
  const rows = person.lived
    .map((event) => {
      const label = event.dateLabel || event.date || formatEventRange(event);
      return `<div class="detail-line">Lived: ${label} · ${event.place} · ${event.evidenceType}</div>`;
    })
    .join("");
  return rows;
}

function formatAlternateNames(person) {
  if (!person.alternateNames?.length) return "";
  return `<div class="detail-line">Also indexed as: ${person.alternateNames.join(", ")}</div>`;
}

function formatLineageLine(person) {
  if (!isDirectLineage(person)) return "";
  return `<div class="detail-line">Lineage: ${person.lineage.label}, order ${person.lineage.order} · confidence ${Math.round(person.lineage.confidence * 100)}%</div>`;
}

function formatLineageTooltip(person) {
  if (!isDirectLineage(person) || !state.showDirectLineage) return "";
  return `${person.lineage.label}<br>`;
}

function formatFamilyLines(person) {
  if (!person.family) return "";
  return `
    <div class="detail-line">Father: ${formatFather(person.family.father)}</div>
    <div class="detail-line">Children: ${formatChildren(person.family.children)}</div>
    <div class="detail-line">Family updated: ${person.family.lastUpdated}</div>
  `;
}

function formatFather(father) {
  if (!father) return "not recorded";
  if (father.personId) return `${formatPersonRef(father.personId)} · ${formatStatusLabel(father.status)}`;
  if (father.displayName) return `${father.displayName} · ${formatStatusLabel(father.status)}`;
  if (father.candidatePersonIds?.length) {
    return `${formatStatusLabel(father.status)}: ${father.candidatePersonIds.map(formatPersonRef).join(", ")}`;
  }
  return `${formatStatusLabel(father.status)}${father.notes ? ` · ${father.notes}` : ""}`;
}

function formatChildren(children) {
  if (!children) return "not recorded";
  const parts = [];
  if (children.personIds?.length) parts.push(children.personIds.map(formatPersonRef).join(", "));
  if (children.candidatePersonIds?.length) parts.push(`candidates: ${children.candidatePersonIds.map(formatPersonRef).join(", ")}`);
  if (children.external?.length) parts.push(`external: ${children.external.map((child) => child.displayName).join(", ")}`);
  if (!parts.length && children.notes) parts.push(children.notes);
  return `${formatStatusLabel(children.status)}${parts.length ? ` · ${parts.join(" · ")}` : ""}`;
}

function formatPersonRef(personId) {
  const person = state.peopleById.get(personId);
  return person ? person.displayName : personId;
}

function formatStatusLabel(status) {
  return (status || "unknown").replaceAll("-", " ");
}

function formatGender(gender) {
  return {
    male: "Male",
    female: "Female",
    unknown: "Unknown"
  }[gender] || "Unknown";
}

function hasOpenFamilyLead(person) {
  const statuses = [
    person.family?.father?.status,
    person.family?.children?.status
  ];
  return statuses.some((status) => {
    return ["candidate", "not-found-public-sweep", "not-yet-researched", "partial-linked"].includes(status);
  });
}

function hasOpenDeathResearch(person) {
  return person.deathResearch?.status && person.deathResearch.status !== "sourced";
}

function formatDeathPlace(person) {
  if (!person.death) {
    return `Death ${formatStatusLabel(person.deathResearch?.status)}`;
  }
  if (person.death.outsideEngland) return person.death.label || "Died outside England";
  if (person.death.country === "England" && person.death.place) return person.death.place;
  if (person.death.year > state.timelineEnd) return "After visible timeline";
  return "Death place not yet sourced";
}

function formatEventRange(event) {
  const start = getEventStart(event);
  const end = getEventEnd(event);
  return start === end ? String(start) : `${start}-${end}`;
}

function getCss(variable) {
  return getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
}

function showLoadError(error) {
  els.dataStatus.textContent = "Data load failed";
  const message = document.createElement("div");
  message.className = "error-state";
  message.textContent = `${error.message}. Serve the project with npm run serve so the browser can fetch local JSON.`;
  document.querySelector(".workspace").replaceChildren(message);
}
