/** Stage-name identity used to reuse an existing label.artists row. */

export function artistKey(stageName: string): string {
  return stageName
    .normalize("NFKC")
    .replaceAll("“", '"')
    .replaceAll("”", '"')
    .replaceAll("‘", "'")
    .replaceAll("’", "'")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function matchArtists<T extends { stageName: string }>(rows: readonly T[], stageName: string): T[] {
  const key = artistKey(stageName);
  if (key === "") return [];
  return rows.filter((row) => artistKey(row.stageName) === key);
}
