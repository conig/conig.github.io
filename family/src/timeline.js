export const DEFAULT_TIMELINE_START = 1100;
export const DEFAULT_TIMELINE_END = 1788;
export const UNKNOWN_DEATH_DISPLAY_YEARS = 30;
const TIMELINE_START_LEAD_IN_YEARS = 3;

export function getTimelineBounds(people, coverage = {}) {
  const scopeStart = Number.isInteger(coverage.startYear) ? coverage.startYear : DEFAULT_TIMELINE_START;
  const scopeEnd = Number.isInteger(coverage.endYear) ? coverage.endYear : DEFAULT_TIMELINE_END;
  const evidenceYears = people.flatMap(getEvidenceYears);

  if (!evidenceYears.length) {
    return { startYear: scopeStart, endYear: scopeEnd };
  }

  const boundedYears = evidenceYears.map((year) => clamp(year, scopeStart, scopeEnd));
  const firstEvidenceYear = Math.min(...boundedYears);
  const startYear = Math.max(scopeStart, firstEvidenceYear - TIMELINE_START_LEAD_IN_YEARS);
  const endYear = Math.max(...boundedYears);

  return {
    startYear,
    endYear: Math.max(startYear, endYear)
  };
}

export function getFirstEvidenceYear(person, fallbackYear = DEFAULT_TIMELINE_START) {
  const years = getEvidenceYears(person);
  return years.length ? Math.min(...years) : fallbackYear;
}

export function getLastEvidenceYear(person, fallbackYear = DEFAULT_TIMELINE_START) {
  const years = getEvidenceYears(person);
  return years.length ? Math.max(...years) : fallbackYear;
}

export function getDisplayEndYear(person, timelineEnd = DEFAULT_TIMELINE_END) {
  if (Number.isInteger(person.death?.year)) {
    return Math.min(person.death.year, timelineEnd);
  }

  const firstEvidenceYear = getFirstEvidenceYear(person);
  const defaultEndYear = firstEvidenceYear + UNKNOWN_DEATH_DISPLAY_YEARS;
  const lastEvidenceYear = getLastEvidenceYear(person, firstEvidenceYear);
  return Math.min(Math.max(defaultEndYear, lastEvidenceYear), timelineEnd);
}

export function getEvidenceYears(person) {
  const years = [];
  if (Number.isInteger(person.birth?.year)) years.push(person.birth.year);
  for (const event of person.lived || []) {
    if (Number.isInteger(getEventStart(event))) years.push(getEventStart(event));
    if (Number.isInteger(getEventEnd(event))) years.push(getEventEnd(event));
  }
  if (Number.isInteger(person.death?.year)) years.push(person.death.year);
  return years;
}

export function getEventStart(event) {
  return event.startYear || event.year;
}

export function getEventEnd(event) {
  return event.endYear || event.year;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
