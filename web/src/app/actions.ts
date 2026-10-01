"use server";
import { type Filters, type PickerKind, pickerGroups, query, valueLabels } from "@/lib/api";

/** A step picker's groups, read when the picker opens. */
export async function loadPicker(kind: PickerKind, race: string[], filters: Filters) {
  return pickerGroups(kind, race, filters);
}

/** An Explore checklist: the values of one player_games dimension in scope, most games first, with their words and icons. */
export async function loadValues(dimension: string, filters: Filters) {
  const rows = await query<Record<string, string> & { games: number }>({ dimensions: [dimension], measures: ["games"], filters, limit: 500 });
  const labels = (await valueLabels({ [dimension]: rows.map((r) => r[dimension]) }))[dimension];
  return rows.map((r) => ({ value: r[dimension], label: labels[r[dimension]].label, icon: labels[r[dimension]].icon ?? null, games: r.games }));
}
