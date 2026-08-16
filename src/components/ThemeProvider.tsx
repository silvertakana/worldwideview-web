"use client";

import { createContext, useContext, useLayoutEffect, useState, ReactNode } from "react";

type Theme = "light" | "dark";
const ThemeContext = createContext<{ theme: Theme; toggle: () => void }>({
  theme: "dark",
  toggle: () => {},
});

export const useTheme = () => useContext(ThemeContext);

export default function ThemeProvider({ children }: { children: ReactNode }) {
  // localStorage is browser-only, so the lazy initializer guards for SSR and
  // reads the stored theme before the first client paint. No effect is needed
  // to seed the state, and there is no flash of the wrong theme.
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === "undefined") return "dark";
    const stored = localStorage.getItem("wwv-web-theme") as Theme | null;
    return stored || "dark";
  });

  // Keep the DOM attribute in sync with the theme. useLayoutEffect runs before
  // paint so toggling never shows a frame with the old data-theme. This effect
  // never sets state -- it only writes to an external system (the document
  // element).
  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("wwv-web-theme", next);
  };

  return (
    <ThemeContext.Provider value={{ theme, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}
