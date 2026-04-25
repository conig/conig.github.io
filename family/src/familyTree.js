import { getFirstEvidenceYear } from "./timeline.js";

export function buildFamilyTree(people, rootId) {
  const peopleById = new Map(people.map((person) => [person.id, person]));
  const root = peopleById.get(rootId);
  if (!root) {
    throw new Error(`Unknown family tree root: ${rootId}`);
  }

  const father = getLinkedPerson(root.family?.father?.personId, peopleById);
  const siblings = father
    ? getLinkedChildren(father, peopleById)
      .filter((person) => person.id !== root.id)
      .filter((person) => person.family?.father?.personId === father.id)
      .sort(comparePeopleByEvidence)
    : [];
  const children = getLinkedChildren(root, peopleById).sort(comparePeopleByEvidence);

  return {
    root,
    father,
    siblings,
    children,
    candidates: {
      fathers: getLinkedPeople(root.family?.father?.candidatePersonIds, peopleById),
      children: getLinkedPeople(root.family?.children?.candidatePersonIds, peopleById)
    },
    external: {
      father: root.family?.father?.displayName || null,
      children: root.family?.children?.external || []
    },
    statuses: {
      father: root.family?.father?.status || "unknown",
      children: root.family?.children?.status || "unknown"
    }
  };
}

function getLinkedChildren(person, peopleById) {
  return getLinkedPeople(person.family?.children?.personIds, peopleById);
}

function getLinkedPeople(ids = [], peopleById) {
  return ids
    .map((id) => getLinkedPerson(id, peopleById))
    .filter(Boolean);
}

function getLinkedPerson(id, peopleById) {
  return id ? peopleById.get(id) || null : null;
}

function comparePeopleByEvidence(a, b) {
  return getFirstEvidenceYear(a) - getFirstEvidenceYear(b)
    || a.displayName.localeCompare(b.displayName)
    || a.id.localeCompare(b.id);
}
