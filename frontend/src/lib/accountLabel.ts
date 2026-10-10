/** An account's name with the bank or institution that holds it: "Visa Signature (Bank of America)". */
export function accountLabel(name: string, institutionName: string | null | undefined): string {
  const institution = institutionName?.trim();
  if (!institution || name.toLowerCase().includes(institution.toLowerCase())) return name;
  return `${name} (${institution})`;
}
