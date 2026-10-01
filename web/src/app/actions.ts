"use server";
import { type Filters, type PickerKind, pickerGroups } from "@/lib/api";

/** A step picker's groups, read when the picker opens. */
export async function loadPicker(kind: PickerKind, race: string[], filters: Filters) {
  return pickerGroups(kind, race, filters);
}
