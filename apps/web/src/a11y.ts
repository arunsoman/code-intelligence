// Automated accessibility audit for the web app. It renders the app's own markup with
// react-dom/server and reads styles.css, then asserts what can be asserted programmatically:
// document language, one h1, labelled controls and groups, named buttons, a live region for
// announcements, the keyboard-canvas wiring, no positive tabindex, and WCAG 2.1 contrast for every
// text pair (>= 4.5:1) and display-mode/status colour pair (>= 3:1) in both themes, including the
// tinted banner backgrounds computed from the same color-mix() expression the CSS uses. What it
// cannot check is covered by the gap text in README: real screen-reader and trackpad behaviour.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

export interface A11yFinding { kind: string; detail: string }
export type Rgb = [number, number, number];

const hexToRgb = (hex: string): Rgb => {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};
const channel = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = (rgb: Rgb) => 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
export const contrast = (a: Rgb, b: Rgb) => {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};
export const mix = (a: Rgb, b: Rgb, pctOfA: number): Rgb =>
  [0, 1, 2].map((i) => Math.round(a[i] * (pctOfA / 100) + b[i] * (1 - pctOfA / 100))) as Rgb;

const PAIRS_PER_THEME = [
  { fg: "ink", bg: "panel", role: "body text on panel", min: 4.5 },
  { fg: "ink", bg: "bg", role: "body text on page", min: 4.5 },
  { fg: "muted", bg: "panel", role: "secondary text on panel", min: 4.5 },
  { fg: "muted", bg: "bg", role: "secondary text on page", min: 4.5 },
  { fg: "accent", bg: "panel", role: "link and chat text on panel", min: 4.5 },
  { fg: "on-accent", bg: "accent", role: "primary-button text", min: 4.5 },
  { fg: "warn", bg: "panel", role: "error text on panel", min: 4.5 },
  { fg: "ok", bg: "panel", role: "success text on panel", min: 4.5 },
  { fg: "fact", bg: "panel", role: "display-mode colour “fact” (dot, legend)", min: 3 },
  { fg: "inference", bg: "panel", role: "display-mode colour “inference” (dot, legend)", min: 3 },
  { fg: "fog", bg: "panel", role: "display-mode colour “fog” (dot, legend)", min: 3 },
  { fg: "hyp", bg: "panel", role: "display-mode colour “hypothesis” (dot, legend)", min: 3 },
] as const;

/** Colour pairs where a text colour sits on a color-mix() of itself over the panel, as in the CSS. */
const MIXED_BANNER_PAIRS = [
  { fg: "warn", pct: 8, role: "error-banner text on its 8% tint" },
  { fg: "ok", pct: 12, role: "success-banner text on its 12% tint" },
];

/**
 * Button state backgrounds. Hover and press mix the surface away from the label colour — the primary button
 * toward --ink, the secondary button toward --accent, the link a tint of --accent over the panel — so the label
 * keeps at least the contrast it has at rest. Each entry mirrors one color-mix() in styles.css.
 */
const BUTTON_STATE_PAIRS = [
  { fg: "on-accent", a: "accent", b: "ink", pct: 82, role: "primary button text on hover" },
  { fg: "on-accent", a: "accent", b: "ink", pct: 68, role: "primary button text while pressed" },
  { fg: "ink", a: "panel", b: "accent", pct: 92, role: "secondary button text on hover" },
  { fg: "ink", a: "panel", b: "accent", pct: 86, role: "secondary button text while pressed" },
  { fg: "ink", a: "accent", b: "panel", pct: 12, role: "link button text on its hover tint" },
  { fg: "ink", a: "accent", b: "panel", pct: 20, role: "link button text on its pressed tint" },
] as const;

export function auditMarkup(html: string): A11yFinding[] {
  const out: A11yFinding[] = [];
  const count = (re: RegExp) => [...html.matchAll(re)].length;

  if (count(/<h1[ >]/g) !== 1) out.push({ kind: "headings", detail: `expected exactly one h1, found ${count(/<h1[ >]/g)}` });
  for (const land of ["<header", "<main", "<aside"]) if (!html.includes(land)) out.push({ kind: "landmarks", detail: `missing landmark ${land}` });

  // No positive tabindex values (they damage reading order).
  const posTab = [...html.matchAll(/tabindex="([0-9]+)"/g)].filter((m) => Number(m[1]) > 0);
  if (posTab.length) out.push({ kind: "tabindex", detail: `positive tabindex found: ${posTab.map((m) => m[1]).join(", ")}` });

  // Every button keeps an accessible name, even when its visible label changes.
  const unnamed: string[] = [];
  for (const m of html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)) {
    const attrs = m[1], inner = m[2].replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
    const label = /aria-label="([^"]*)"/.exec(attrs)?.[1] ?? "";
    if (!inner && !label) unnamed.push(attrs.slice(0, 60));
  }
  if (unnamed.length) out.push({ kind: "button-name", detail: `${unnamed.length} button(s) without an accessible name: ${unnamed[0]}` });

  // The screen-reader live region must exist, be polite and atomic; the map must reference its keyboard help.
  if (!/aria-live="polite" aria-atomic="true"/.test(html)) out.push({ kind: "live-region", detail: "the sr-only announcement region (aria-live=polite, aria-atomic) is missing" });
  if (!html.includes('id="canvas-help"')) out.push({ kind: "keyboard-help", detail: "the keyboard help paragraph referenced by the canvas is missing" });

  // Every text input is labelled: <label className="sr" htmlFor=…> (serialized as for=) or a wrapping <label><input…>.
  for (const m of html.matchAll(/<input([^>]*)>/g)) {
    const attrs = m[1];
    if (attrs.includes('type="checkbox"')) {
      // checkboxes are structural here: the wrapping <label> carries their name; assert it exists in markup
      if (!/<label[^>]*>\s*<input/.test(html)) out.push({ kind: "input-label", detail: "checkbox is not wrapped in a labelled element" });
      continue;
    }
    const id = /id="([^"]*)"/.exec(attrs)?.[1] ?? "";
    if (id && /(?:for|htmlFor)="[^"]*"/.test(html) && html.includes(`for="${id}"`)) continue;
    if (attrs.includes("aria-label=")) continue;
    out.push({ kind: "input-label", detail: `input without an associated label: ${attrs.slice(0, 60)}` });
  }

  return out;
}

export interface AuditResult {
  findings: A11yFinding[];
  textPairs: number; // asserted at >= 4.5:1
  uiPairs: number;   // asserted at >= 3:1
  themes: string[];
  light: Record<string, string>;
  dark: Record<string, string>;
}

export function auditContrast(css: string): AuditResult {
  const light: Record<string, string> = {};
  const dark: Record<string, string> = {};
  const lightStart = css.indexOf(":root {"), lightEnd = css.indexOf("}", lightStart);
  if (lightStart !== -1) for (const m of css.slice(lightStart, lightEnd).matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)) light[m[1]] = m[2];
  const darkStart = css.indexOf("prefers-color-scheme: dark");
  const darkBlock = darkStart === -1 ? "" : css.slice(darkStart, css.indexOf("}", darkStart));
  for (const m of darkBlock.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)) dark[m[1]] = m[2];
  const high: Record<string, string> = {};
  const highStart = css.indexOf(':root[data-contrast="high"]');
  if (highStart !== -1) for (const m of css.slice(highStart, css.indexOf("}", highStart)).matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)) high[m[1]] = m[2];

  const findings: A11yFinding[] = [];
  let textPairs = 0, uiPairs = 0;
  const check = (theme: string, v: Record<string, string>, fg: string, bg: string, role: string, min: number, resolvedBg?: Rgb) => {
    if (!v[fg] || (!resolvedBg && !v[bg])) { findings.push({ kind: "contrast-token", detail: `${theme}: missing colour token for ${role}` }); return; }
    const ratio = contrast(hexToRgb(v[fg]), resolvedBg ?? hexToRgb(v[bg]));
    if (ratio < min) findings.push({ kind: "contrast", detail: `${theme}: ${role} — ${ratio.toFixed(2)}:1 (needs ${min}:1)` });
    if (min >= 4.5) textPairs++; else uiPairs++;
  };
  for (const [theme, v] of [["light", light], ["dark", dark], ["high contrast", high]] as const) {
    if (!Object.keys(v).length) { findings.push({ kind: "contrast-theme", detail: `${theme} theme tokens not found in styles.css` }); continue; }
    for (const p of PAIRS_PER_THEME) check(theme, v, p.fg, p.bg, p.role, p.min);
    check(theme, v, "on-accent", "accent", "selected-tool text on accent", 4.5);
    for (const p of MIXED_BANNER_PAIRS) {
      if (!v[p.fg] || !v.panel) { findings.push({ kind: "contrast-token", detail: `${theme}: missing colour token for ${p.role}` }); continue; }
      const bg = mix(hexToRgb(v[p.fg]), hexToRgb(v.panel), p.pct);
      const ratio = contrast(hexToRgb(v[p.fg]), bg);
      if (ratio < 4.5) findings.push({ kind: "contrast", detail: `${theme}: ${p.role} — ${ratio.toFixed(2)}:1 (needs 4.5:1)` });
      textPairs++;
    }
    for (const p of BUTTON_STATE_PAIRS) {
      if (!v[p.fg] || !v[p.a] || !v[p.b]) { findings.push({ kind: "contrast-token", detail: `${theme}: missing colour token for ${p.role}` }); continue; }
      const bg = mix(hexToRgb(v[p.a]), hexToRgb(v[p.b]), p.pct);
      const ratio = contrast(hexToRgb(v[p.fg]), bg);
      if (ratio < 4.5) findings.push({ kind: "contrast", detail: `${theme}: ${p.role} — ${ratio.toFixed(2)}:1 (needs 4.5:1)` });
      textPairs++;
    }
  }
  return { findings, textPairs, uiPairs, themes: [Object.keys(light).length && "light", Object.keys(dark).length && "dark", Object.keys(high).length && "high contrast"].filter(Boolean) as string[], light, dark };
}

export const renderApp = (App: any): string => renderToStaticMarkup(createElement(App));
