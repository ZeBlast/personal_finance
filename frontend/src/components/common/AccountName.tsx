/** An account's name, with the institution that holds it in gray so the name itself stands out. */
export function AccountName({
  name,
  institutionName,
}: {
  name: string;
  institutionName: string | null | undefined;
}) {
  const institution = institutionName?.trim();
  const shown = institution && !name.toLowerCase().includes(institution.toLowerCase());
  return (
    <>
      {name}
      {shown && (
        <span className="font-normal text-slate-500 dark:text-slate-400"> ({institution})</span>
      )}
    </>
  );
}
