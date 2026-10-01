"use client";
import { useRouter } from "next/navigation";

/** The list's sort on the Games banner; a change opens the first page in that order. */
export function SortSelect({ value, options }: { value: string; options: [string, string, string][] }) {
  const router = useRouter();
  return (
    <select aria-label="Sort" className="field on-bar" value={value} onChange={(e) => router.push(options.find(([v]) => v === e.target.value)![2])}>
      {options.map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </select>
  );
}
