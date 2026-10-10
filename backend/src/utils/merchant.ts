/**
 * A merchant's name reduced to what stays the same between charges: lower case, with store
 * numbers, reference ids and punctuation removed, so "CHIPOTLE 2041", "Chipotle #1999" and
 * "Chipotle" are one merchant. Returns an empty string when nothing usable is left.
 */
export function merchantKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[#*]?\d{3,}/g, " ")
    .replace(/[^a-z0-9&' .-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
