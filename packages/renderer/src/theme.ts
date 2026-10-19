type Rgb = [number, number, number];

export const DEFAULT_PRIMARY = "#0b5fff";
/** Page backgrounds defined in docops.css (light and dark). */
export const LIGHT_BACKGROUND = "#ffffff";
export const DARK_BACKGROUND = "#0d1117";

export function parseHexColor(value: string | undefined): Rgb | undefined {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((value ?? "").trim());
  if (!match?.[1]) return undefined;
  const hex = match[1].length === 3 ? [...match[1]].map((c) => c + c).join("") : match[1];
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

function toHex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("")}`;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [l1, l2] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Darken (on light backgrounds) or lighten (on dark ones) until the contrast ratio is met. */
export function ensureContrast(color: Rgb, background: Rgb, ratio: number): Rgb {
  const target: Rgb = relativeLuminance(background) > 0.5 ? [0, 0, 0] : [255, 255, 255];
  for (let step = 0; step <= 20; step++) {
    const candidate = mix(color, target, step / 20);
    const rounded: Rgb = [Math.round(candidate[0]), Math.round(candidate[1]), Math.round(candidate[2])];
    if (contrastRatio(rounded, background) >= ratio) return rounded;
  }
  return target;
}

/** `assets/theme.css`: theme tokens derived from `site.primaryColor`, with WCAG-safe link/focus colors. */
export function themeCss(primaryColor: string | undefined): string {
  const primary = parseHexColor(primaryColor) ?? (parseHexColor(DEFAULT_PRIMARY) as Rgb);
  const light = parseHexColor(LIGHT_BACKGROUND) as Rgb;
  const dark = parseHexColor(DARK_BACKGROUND) as Rgb;
  const onPrimary = contrastRatio(primary, [255, 255, 255]) >= contrastRatio(primary, [0, 0, 0]) ? "#ffffff" : "#000000";
  const lightLink = toHex(ensureContrast(primary, light, 4.5));
  const darkLink = toHex(ensureContrast(primary, dark, 4.5));
  return [
    "/* DocOps theme tokens (generated from site.primaryColor). */",
    ":root {",
    `  --docops-primary: ${toHex(primary)};`,
    `  --docops-on-primary: ${onPrimary};`,
    `  --docops-link: ${lightLink};`,
    `  --docops-focus: ${lightLink};`,
    "}",
    "@media (prefers-color-scheme: dark) {",
    "  :root {",
    `    --docops-link: ${darkLink};`,
    `    --docops-focus: ${darkLink};`,
    "  }",
    "}",
    "",
  ].join("\n");
}
