import type { Element, ElementContent } from "hast";
import type { Position } from "unist";
import { h } from "./hast.ts";

export const CALLOUT_KINDS = ["note", "tip", "important", "warning", "caution"] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

const CALLOUT_TITLES: Record<CalloutKind, string> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
};

const CALLOUT_ALIASES: Record<string, CalloutKind> = {
  note: "note",
  info: "note",
  tip: "tip",
  hint: "tip",
  success: "tip",
  important: "important",
  warning: "warning",
  warn: "warning",
  caution: "caution",
  danger: "caution",
  error: "caution",
};

export function calloutKind(value: string | undefined): CalloutKind {
  return CALLOUT_ALIASES[(value ?? "").trim().toLowerCase()] ?? "note";
}

/** `<aside class="callout callout-note" role="note"><p class="callout-title">Note</p>…</aside>` */
export function callout(kind: CalloutKind, title: string | undefined, children: ElementContent[], inline = false): Element {
  const label = title?.trim() || CALLOUT_TITLES[kind];
  if (inline) {
    return h(
      "span",
      { className: ["callout", `callout-${kind}`, "callout-inline"], role: "note" },
      h("strong", { className: ["callout-title"] }, `${label}:`),
      " ",
      children,
    );
  }
  return h("aside", { className: ["callout", `callout-${kind}`], role: "note" }, h("p", { className: ["callout-title"] }, label), children);
}

/** Escaped `<pre><code class="language-x">` inside a wrapper the client script adds a copy button to. */
export function codeBlock(value: string, lang: string | null | undefined, title?: string): Element {
  const language = lang?.trim().split(/\s+/)[0] || undefined;
  return h(
    "div",
    { className: ["code-block"], dataLang: language },
    title ? h("p", { className: ["code-title"] }, title) : null,
    // tabindex makes long lines keyboard-scrollable.
    h("pre", { tabIndex: 0 }, h("code", language ? { className: [`language-${language}`] } : null, value)),
  );
}

/** `title="…"` from a fenced code block's meta string. */
export function codeMetaTitle(meta: string | null | undefined): string | undefined {
  if (!meta) return undefined;
  const match = /(?:^|\s)title=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(meta);
  const title = match ? (match[1] ?? match[2] ?? match[3] ?? "") : "";
  return title.trim() || undefined;
}

const LANGUAGE_LABELS: Record<string, string> = {
  bash: "Bash",
  sh: "Shell",
  shell: "Shell",
  zsh: "Shell",
  console: "Console",
  curl: "curl",
  js: "JavaScript",
  javascript: "JavaScript",
  mjs: "JavaScript",
  ts: "TypeScript",
  typescript: "TypeScript",
  py: "Python",
  python: "Python",
  go: "Go",
  java: "Java",
  kotlin: "Kotlin",
  rb: "Ruby",
  ruby: "Ruby",
  php: "PHP",
  cs: "C#",
  csharp: "C#",
  rust: "Rust",
  swift: "Swift",
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  http: "HTTP",
  sql: "SQL",
};

export function languageLabel(lang: string | null | undefined): string | undefined {
  const key = lang?.trim().split(/\s+/)[0]?.toLowerCase();
  if (!key) return undefined;
  return LANGUAGE_LABELS[key] ?? key;
}

export interface TabPanel {
  label: string;
  children: ElementContent[];
  position?: Position | undefined;
}

/**
 * Tabs that degrade without JavaScript: every panel is visible with its own heading.
 * The client script turns `[data-tabs]` into a WAI-ARIA tablist.
 */
export function tabsGroup(panels: TabPanel[], level: number, variant?: string, extra: ElementContent[] = []): Element {
  const depth = Math.min(6, Math.max(2, level));
  const className = variant ? ["tabs", variant] : ["tabs"];
  return h(
    "div",
    { className, dataTabs: "" },
    panels.map((panel) => {
      const heading = h(`h${depth}`, { className: ["tab-heading"] }, panel.label);
      const section = h("section", { className: ["tab-panel"], dataTabLabel: panel.label }, heading, panel.children);
      if (panel.position) {
        heading.position = panel.position;
        section.position = panel.position;
      }
      return section;
    }),
    extra,
  );
}

export function methodBadge(method: string): Element {
  const upper = method.toUpperCase();
  return h("span", { className: ["method", `method-${upper.toLowerCase()}`] }, upper);
}
