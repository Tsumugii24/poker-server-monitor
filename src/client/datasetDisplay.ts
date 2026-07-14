export function displayDatasetName(value: string | null | undefined, fallback = "-"): string {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  return normalized.split("/").filter(Boolean).at(-1) ?? normalized;
}
