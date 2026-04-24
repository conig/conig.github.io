export function countPeopleByVariant(people) {
  const counts = new Map();
  for (const person of people) {
    counts.set(person.surnameVariant, (counts.get(person.surnameVariant) || 0) + 1);
  }
  return counts;
}

export function countPeopleByGender(people) {
  const counts = new Map();
  for (const person of people) {
    counts.set(person.gender, (counts.get(person.gender) || 0) + 1);
  }
  return counts;
}

export function getVariantsWithPeople(variants, people, counts = countPeopleByVariant(people)) {
  return variants.filter((variant) => (counts.get(variant.key) || 0) > 0);
}

export function filterPeopleByActiveFilters(people, activeVariants, options = {}) {
  return people.filter((person) => {
    return activeVariants.has(person.surnameVariant) && (!options.maleOnly || person.gender === "male");
  });
}
