"use client";
import { useSyncExternalStore } from "react";

type Mode = "system" | "light" | "dark";

const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const read = (): Mode => {
  try {
    return (localStorage.getItem("theme") as Mode) || "system";
  } catch {
    return "system";
  }
};

/** Light, dark or the system setting, stored under `theme`; THEME_SCRIPT applies it before paint. */
export function ThemeSwitch() {
  const mode = useSyncExternalStore(subscribe, read, () => "system" as Mode);
  const choose = (m: Mode) => {
    try {
      localStorage.setItem("theme", m);
    } catch {
      // blocked storage: the choice lasts until the page reloads
    }
    if (m === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = m;
    listeners.forEach((l) => l());
  };
  return (
    <label className="ml-auto flex items-center gap-2 text-sm">
      <span className="text-muted">Theme</span>
      <select className="field h-9" value={mode} onChange={(e) => choose(e.target.value as Mode)}>
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
