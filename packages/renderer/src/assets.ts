/**
 * Static portal assets. They are plain files (no inline styles or scripts) so the
 * portal works under `style-src 'self'; script-src 'self'`.
 */

export const DOCOPS_CSS = String.raw`/* DocOps portal styles (WCAG 2.2 AA). Theme tokens: theme.css. */
:root {
  color-scheme: light dark;
  --docops-bg: #ffffff;
  --docops-fg: #1f2328;
  --docops-muted: #59636e;
  --docops-border: #d1d9e0;
  --docops-surface: #f6f8fa;
  --docops-code-bg: #f6f8fa;
  --docops-link: #0b5fff;
  --docops-focus: #0b5fff;
  --docops-radius: 6px;
  --docops-font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji";
  --docops-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --docops-note: #0550ae;
  --docops-note-bg: #ddf4ff;
  --docops-tip: #116329;
  --docops-tip-bg: #dafbe1;
  --docops-important: #6639ba;
  --docops-important-bg: #fbefff;
  --docops-warning: #7d4e00;
  --docops-warning-bg: #fff8c5;
  --docops-caution: #a40e26;
  --docops-caution-bg: #ffebe9;
  --docops-banner-bg: #fff8c5;
  --docops-banner-fg: #3b2300;
}

@media (prefers-color-scheme: dark) {
  :root {
    --docops-bg: #0d1117;
    --docops-fg: #e6edf3;
    --docops-muted: #9198a1;
    --docops-border: #3d444d;
    --docops-surface: #151b23;
    --docops-code-bg: #151b23;
    --docops-link: #4493f8;
    --docops-focus: #4493f8;
    --docops-note: #4493f8;
    --docops-note-bg: #151b23;
    --docops-tip: #3fb950;
    --docops-tip-bg: #151b23;
    --docops-important: #ab7df8;
    --docops-important-bg: #151b23;
    --docops-warning: #d29922;
    --docops-warning-bg: #151b23;
    --docops-caution: #f85149;
    --docops-caution-bg: #151b23;
    --docops-banner-bg: #2e2a12;
    --docops-banner-fg: #f2cc60;
  }
}

*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body {
  margin: 0;
  font-family: var(--docops-font);
  font-size: 1rem;
  line-height: 1.6;
  color: var(--docops-fg);
  background: var(--docops-bg);
  overflow-wrap: break-word;
}
a { color: var(--docops-link); text-decoration: underline; text-underline-offset: 0.15em; }
a:hover { text-decoration-thickness: 2px; }
img { max-width: 100%; height: auto; }
code, kbd, samp, pre { font-family: var(--docops-mono); font-size: 0.875em; }
kbd { padding: 0.05em 0.35em; border: 1px solid var(--docops-muted); border-radius: 4px; }
[hidden] { display: none !important; }

/* Focus: always visible, at least 2px, 3:1 against the page (theme.css guarantees 4.5:1). */
:focus-visible { outline: 3px solid var(--docops-focus); outline-offset: 2px; }
#content:focus, #content:focus-visible { outline: none; }

.sr-only {
  position: absolute !important;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.skip-link {
  position: absolute;
  left: 1rem;
  top: -10rem;
  z-index: 100;
  padding: 0.75rem 1rem;
  color: var(--docops-fg);
  background: var(--docops-bg);
  border: 2px solid var(--docops-focus);
  border-radius: var(--docops-radius);
  font-weight: 700;
}
.skip-link:focus { top: 1rem; }

.preview-banner {
  padding: 0.5rem 1rem;
  text-align: center;
  font-weight: 700;
  color: var(--docops-banner-fg);
  background: var(--docops-banner-bg);
  border-bottom: 1px solid var(--docops-border);
}

/* Header */
.site-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem 1.5rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--docops-border);
}
.site-title {
  display: inline-flex;
  align-items: center;
  min-height: 2.75rem;
  font-size: 1.125rem;
  font-weight: 700;
  color: var(--docops-fg);
  text-decoration: none;
}
.version-switcher { display: flex; align-items: center; gap: 0.5rem; }
.version-label { font-size: 0.875rem; color: var(--docops-muted); }
.version-switcher ul { display: flex; flex-wrap: wrap; gap: 0.25rem; margin: 0; padding: 0; list-style: none; }
.version-switcher a, .version-switcher span[aria-current] {
  display: inline-flex;
  align-items: center;
  min-height: 1.75rem;
  min-width: 1.75rem;
  padding: 0.125rem 0.625rem;
  font-size: 0.875rem;
  border: 1px solid var(--docops-border);
  border-radius: 999px;
}
.version-switcher [aria-current="page"] { font-weight: 700; border-color: currentColor; }
.search { position: relative; display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.5rem; margin-left: auto; }
.search-label { font-weight: 600; }
.search input {
  width: min(18rem, 60vw);
  min-height: 2.25rem;
  padding: 0.25rem 0.5rem;
  font: inherit;
  color: var(--docops-fg);
  background: var(--docops-bg);
  border: 1px solid var(--docops-muted);
  border-radius: var(--docops-radius);
}
.search-status { flex-basis: 100%; margin: 0; font-size: 0.875rem; color: var(--docops-muted); }
.search-status:empty { display: none; }
.search-results {
  position: absolute;
  top: calc(100% + 0.25rem);
  right: 0;
  z-index: 20;
  width: min(32rem, calc(100vw - 2rem));
  max-height: 70vh;
  overflow: auto;
  margin: 0;
  padding: 0.5rem;
  list-style: none;
  background: var(--docops-bg);
  border: 1px solid var(--docops-border);
  border-radius: var(--docops-radius);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}
.search-results a { display: block; min-height: 1.75rem; padding: 0.25rem 0.5rem; font-weight: 600; }
.search-results p { margin: 0 0.5rem 0.5rem; font-size: 0.875rem; color: var(--docops-muted); }

/* Layout */
.layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1.5rem; max-width: 90rem; margin: 0 auto; padding: 1rem; }
.sidebar ul { margin: 0; padding: 0; list-style: none; }
.sidebar ul ul { margin-left: 0.5rem; padding-left: 0.5rem; border-left: 1px solid var(--docops-border); }
.sidebar a, .nav-group {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  min-height: 1.75rem;
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  color: var(--docops-fg);
  text-decoration: none;
}
.sidebar a:hover { text-decoration: underline; background: var(--docops-surface); }
.sidebar a[aria-current="page"] { font-weight: 700; background: var(--docops-surface); box-shadow: inset 3px 0 0 var(--docops-link); }
.nav-group { margin-top: 0.5rem; font-size: 0.8125rem; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase; color: var(--docops-muted); }
.nav-details summary { min-height: 2.75rem; padding: 0.5rem; font-weight: 700; cursor: pointer; }
main { display: grid; grid-template-columns: minmax(0, 1fr); grid-template-areas: "toc" "article" "pagefooter"; gap: 1rem; min-width: 0; }
main > .toc { grid-area: toc; }
main > article { grid-area: article; min-width: 0; max-width: 48rem; }
main > .page-footer { grid-area: pagefooter; max-width: 48rem; }

@media (min-width: 60rem) {
  .layout { grid-template-columns: 16rem minmax(0, 1fr); gap: 2.5rem; }
  .sidebar { position: sticky; top: 1rem; align-self: start; max-height: calc(100vh - 2rem); overflow-y: auto; }
  .nav-details summary { display: none; }
}
@media (min-width: 80rem) {
  main { grid-template-columns: minmax(0, 48rem) 14rem; grid-template-areas: "article toc" "pagefooter toc"; column-gap: 3rem; align-items: start; }
  main > .toc { position: sticky; top: 1rem; max-height: calc(100vh - 2rem); overflow-y: auto; }
}

/* On this page */
.toc { font-size: 0.9375rem; }
.toc-title { margin: 0 0 0.25rem; font-weight: 700; }
.toc ul { margin: 0; padding: 0; list-style: none; }
.toc ul ul { padding-left: 0.75rem; }
.toc a { display: inline-flex; align-items: center; min-height: 1.75rem; padding: 0.125rem 0; }

/* Article */
.doc h1 { margin: 0 0 1rem; font-size: 2rem; line-height: 1.25; }
.doc h2 { font-size: 1.5rem; line-height: 1.3; }
.doc h3 { font-size: 1.25rem; line-height: 1.35; }
.doc h4 { font-size: 1.0625rem; }
.doc h2, .doc h3, .doc h4, .doc h5, .doc h6 { margin: 2rem 0 0.75rem; }
.heading-wrapper { display: flex; align-items: baseline; gap: 0.25rem; margin: 2rem 0 0.75rem; }
.heading-wrapper > h2, .heading-wrapper > h3, .heading-wrapper > h4, .heading-wrapper > h5, .heading-wrapper > h6 { margin: 0; }
.heading-anchor {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.5rem;
  min-height: 1.5rem;
  color: var(--docops-muted);
  text-decoration: none;
}
.heading-anchor:hover { color: var(--docops-link); }
:target { scroll-margin-top: 1rem; }
.doc :not(pre) > code { padding: 0.1em 0.35em; background: var(--docops-code-bg); border: 1px solid var(--docops-border); border-radius: 4px; }
.doc blockquote { margin: 1rem 0; padding: 0 1rem; color: var(--docops-muted); border-left: 4px solid var(--docops-border); }
.doc hr { border: 0; border-top: 1px solid var(--docops-border); margin: 2rem 0; }
.lead { font-size: 1.125rem; }

/* Code */
.code-block { display: flex; flex-direction: column; margin: 1rem 0; }
.code-block pre {
  margin: 0;
  padding: 1rem;
  overflow-x: auto;
  line-height: 1.5;
  background: var(--docops-code-bg);
  border: 1px solid var(--docops-border);
  border-radius: var(--docops-radius);
}
.code-title {
  margin: 0;
  padding: 0.375rem 1rem;
  font-family: var(--docops-mono);
  font-size: 0.8125rem;
  background: var(--docops-surface);
  border: 1px solid var(--docops-border);
  border-bottom: 0;
  border-radius: var(--docops-radius) var(--docops-radius) 0 0;
}
.code-title + pre { border-top-left-radius: 0; border-top-right-radius: 0; }
.copy-button {
  align-self: flex-end;
  min-width: 3.5rem;
  min-height: 2rem;
  margin-bottom: 0.25rem;
  padding: 0.25rem 0.75rem;
  font: inherit;
  font-size: 0.8125rem;
  color: var(--docops-fg);
  background: var(--docops-bg);
  border: 1px solid var(--docops-muted);
  border-radius: 4px;
  cursor: pointer;
}

/* Tables */
.table-wrap { margin: 1rem 0; overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 0.9375rem; }
caption { padding: 0.25rem 0 0.5rem; font-weight: 700; text-align: left; caption-side: top; }
th, td { padding: 0.5rem 0.75rem; text-align: left; vertical-align: top; border: 1px solid var(--docops-border); }
thead th { background: var(--docops-surface); }
tbody th { font-weight: 400; }
tr.depth-2 > :first-child { padding-left: 1.75rem; }
tr.depth-3 > :first-child { padding-left: 3rem; }
.constraints { margin: 0; padding-left: 1rem; }

/* Callouts (the title names the type, so color is not the only cue) */
.callout {
  margin: 1rem 0;
  padding: 0.75rem 1rem;
  background: var(--callout-bg, var(--docops-surface));
  border-left: 4px solid var(--callout-color, var(--docops-border));
  border-radius: 0 var(--docops-radius) var(--docops-radius) 0;
}
.callout > :last-child { margin-bottom: 0; }
.callout-title { margin: 0 0 0.25rem; font-weight: 700; color: var(--callout-color, inherit); }
.callout-inline { display: inline; padding: 0.1em 0.4em; border-left-width: 3px; }
.callout-note { --callout-color: var(--docops-note); --callout-bg: var(--docops-note-bg); }
.callout-tip { --callout-color: var(--docops-tip); --callout-bg: var(--docops-tip-bg); }
.callout-important { --callout-color: var(--docops-important); --callout-bg: var(--docops-important-bg); }
.callout-warning, .stale-warning { --callout-color: var(--docops-warning); --callout-bg: var(--docops-warning-bg); }
.callout-caution { --callout-color: var(--docops-caution); --callout-bg: var(--docops-caution-bg); }
.stale-warning { padding: 0.75rem 1rem; color: var(--docops-fg); background: var(--callout-bg); border-left: 4px solid var(--callout-color); }

/* Tabs: without JavaScript every panel is shown with its heading. */
.tabs { margin: 1rem 0; }
.tab-panel { margin: 0.75rem 0; padding: 0.75rem 1rem; border: 1px solid var(--docops-border); border-radius: var(--docops-radius); }
.tab-heading { margin: 0 0 0.5rem !important; font-size: 1rem !important; }
.tabs-enhanced > .tab-panel { margin-top: 0; border-top-left-radius: 0; }
.tabs-enhanced > .tab-panel > .code-block:only-child { margin: 0; }
[role="tablist"] { display: flex; flex-wrap: wrap; gap: 0.25rem; }
[role="tab"] {
  min-width: 2.75rem;
  min-height: 2.25rem;
  margin-bottom: -1px;
  padding: 0.375rem 0.875rem;
  font: inherit;
  color: var(--docops-fg);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--docops-radius) var(--docops-radius) 0 0;
  cursor: pointer;
}
[role="tab"][aria-selected="true"] {
  font-weight: 700;
  background: var(--docops-bg);
  border-color: var(--docops-border);
  border-bottom: 3px solid var(--docops-link);
}

/* API reference */
.method {
  display: inline-block;
  min-width: 3.75rem;
  padding: 0.1em 0.45em;
  font-family: var(--docops-mono);
  font-size: 0.75em;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-align: center;
  color: var(--method-color, var(--docops-fg));
  background: var(--method-bg, var(--docops-surface));
  border: 1px solid currentColor;
  border-radius: 4px;
}
h1 .method { font-size: 0.55em; vertical-align: middle; }
.method-get { --method-color: var(--docops-tip); --method-bg: var(--docops-tip-bg); }
.method-post { --method-color: var(--docops-note); --method-bg: var(--docops-note-bg); }
.method-put { --method-color: var(--docops-warning); --method-bg: var(--docops-warning-bg); }
.method-patch { --method-color: var(--docops-important); --method-bg: var(--docops-important-bg); }
.method-delete { --method-color: var(--docops-caution); --method-bg: var(--docops-caution-bg); }
.api-path { overflow-wrap: anywhere; }
.api-meta, .generated-note { color: var(--docops-muted); }
.api-operation { margin: 1rem 0; padding: 0.75rem 1rem; border: 1px solid var(--docops-border); border-radius: var(--docops-radius); }
.api-operation-link { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; min-height: 1.75rem; font-weight: 600; }
.api-operation-missing { color: var(--docops-muted); }
.operation-list { padding: 0; list-style: none; }
.operation-list li { margin: 0.375rem 0; }
.operation-list a { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; min-height: 1.75rem; }
.jira-status { padding: 0.05em 0.4em; font-family: var(--docops-mono); font-size: 0.875em; border: 1px solid var(--docops-border); border-radius: 4px; }

/* Try it */
.try-it { margin: 2rem 0; padding: 1rem; border: 1px solid var(--docops-border); border-radius: var(--docops-radius); }
.try-it h2 { margin-top: 0; }
.field { display: flex; flex-direction: column; gap: 0.25rem; margin: 0.75rem 0; }
.field label { font-weight: 600; }
.field input, .field select, .field textarea {
  max-width: 100%;
  min-height: 2.25rem;
  padding: 0.375rem 0.5rem;
  font: inherit;
  color: var(--docops-fg);
  background: var(--docops-bg);
  border: 1px solid var(--docops-muted);
  border-radius: 4px;
}
.field textarea { min-height: 8rem; font-family: var(--docops-mono); font-size: 0.875rem; }
.try-it fieldset { margin: 0.75rem 0; padding: 0.5rem 1rem; border: 1px solid var(--docops-border); border-radius: 4px; }
.hint { margin: 0; font-size: 0.875rem; color: var(--docops-muted); }
.button {
  display: inline-flex;
  align-items: center;
  min-height: 2.5rem;
  padding: 0.5rem 1rem;
  font: inherit;
  font-weight: 700;
  color: var(--docops-bg);
  background: var(--docops-link);
  border: 1px solid var(--docops-link);
  border-radius: var(--docops-radius);
  cursor: pointer;
}
.try-it-response {
  min-height: 3rem;
  margin: 0.5rem 0 0;
  padding: 1rem;
  white-space: pre-wrap;
  background: var(--docops-code-bg);
  border: 1px solid var(--docops-border);
  border-radius: var(--docops-radius);
}

/* Footers */
.page-footer { margin-top: 2rem; padding-top: 1rem; font-size: 0.9375rem; color: var(--docops-muted); border-top: 1px solid var(--docops-border); }
.page-meta { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 0.25rem 1rem; margin: 0 0 1rem; }
.page-meta div { display: contents; }
.page-meta dt { font-weight: 700; }
.page-meta dd { margin: 0; }
.edit-link a { display: inline-flex; align-items: center; min-height: 1.75rem; }
.site-footer { padding: 1rem; font-size: 0.875rem; text-align: center; color: var(--docops-muted); border-top: 1px solid var(--docops-border); }
.site-footer p { margin: 0.25rem 0; }
.link-button {
  min-height: 1.75rem;
  padding: 0 0.25rem;
  font: inherit;
  color: var(--docops-link);
  text-decoration: underline;
  background: none;
  border: 0;
  cursor: pointer;
}

@media (prefers-reduced-motion: no-preference) {
  html { scroll-behavior: smooth; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
@media (forced-colors: active) {
  .method, .callout, .tab-panel, .stale-warning { border: 1px solid CanvasText; }
  [role="tab"][aria-selected="true"] { outline: 2px solid Highlight; }
  .sidebar a[aria-current="page"] { outline: 2px solid Highlight; }
}
@media print {
  .sidebar, .search, .toc, .skip-link, .try-it, .copy-button, .version-switcher { display: none !important; }
  .layout, main { display: block; }
  a { color: inherit; }
}
`;

export const DOCOPS_JS = String.raw`/* DocOps portal script: progressive enhancement only (every page works without it).
   No inline handlers, no eval, and credentials are never written to storage. */
(function () {
  "use strict";
  var doc = document;
  var root = doc.documentElement;
  var basePath = root.getAttribute("data-base-path") || "/";

  function all(selector, context) {
    return Array.prototype.slice.call((context || doc).querySelectorAll(selector));
  }

  // ---- Polite announcements -------------------------------------------------
  var liveRegion = null;
  function announce(message) {
    if (!liveRegion) {
      liveRegion = doc.createElement("div");
      liveRegion.className = "sr-only";
      liveRegion.setAttribute("role", "status");
      liveRegion.setAttribute("aria-live", "polite");
      doc.body.appendChild(liveRegion);
    }
    liveRegion.textContent = "";
    window.setTimeout(function () { liveRegion.textContent = message; }, 60);
  }

  // Non-sensitive preferences only.
  function readPreference(key) {
    try { return window.localStorage.getItem("docops:" + key); } catch (error) { return null; }
  }
  function writePreference(key, value) {
    try { window.localStorage.setItem("docops:" + key, value); } catch (error) { /* storage unavailable */ }
  }

  // ---- Sidebar: collapsed behind "Menu" on narrow screens ---------------------
  function initSidebar() {
    var details = doc.querySelector(".sidebar details");
    if (!details || !window.matchMedia) return;
    var narrow = window.matchMedia("(max-width: 59.99rem)");
    function sync() { details.open = !narrow.matches; }
    sync();
    if (narrow.addEventListener) narrow.addEventListener("change", sync);
  }

  // ---- Search -----------------------------------------------------------------
  function initSearch() {
    var form = doc.querySelector("form[role='search']");
    var input = form && form.querySelector("input[type='search']");
    var status = doc.getElementById("docops-search-status");
    var list = doc.getElementById("docops-search-results");
    if (!form || !input || !status || !list) return;
    var index = null;
    var loading = null;
    var timer = 0;

    function load() {
      if (!loading) {
        loading = fetch(basePath + "search-index.json", { credentials: "same-origin" })
          .then(function (response) { return response.ok ? response.json() : []; })
          .then(function (data) { index = Array.isArray(data) ? data : []; })
          .catch(function () { index = []; });
      }
      return loading;
    }

    function clear() {
      while (list.firstChild) list.removeChild(list.firstChild);
      list.hidden = true;
    }

    function excerpt(text, term) {
      var at = text.toLowerCase().indexOf(term);
      if (at < 0) return text.slice(0, 140) + (text.length > 140 ? "…" : "");
      var start = Math.max(0, at - 60);
      var end = Math.min(text.length, at + 80);
      return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
    }

    function run(query) {
      var terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      clear();
      if (!terms.length) { status.textContent = ""; return; }
      var results = [];
      (index || []).forEach(function (entry) {
        var title = String(entry.title || "").toLowerCase();
        var headings = (entry.headings || []).join(" ").toLowerCase();
        var text = String(entry.text || "").toLowerCase();
        var score = 0;
        for (var i = 0; i < terms.length; i++) {
          var term = terms[i];
          var points = 0;
          if (title.indexOf(term) !== -1) points += 10;
          if (headings.indexOf(term) !== -1) points += 4;
          if (text.indexOf(term) !== -1) points += 1;
          if (!points) return;
          score += points;
        }
        results.push({ entry: entry, score: score });
      });
      results.sort(function (a, b) {
        return b.score - a.score || (String(a.entry.title) < String(b.entry.title) ? -1 : 1);
      });
      var shown = results.slice(0, 10);
      shown.forEach(function (result) {
        var item = doc.createElement("li");
        var link = doc.createElement("a");
        link.href = basePath + result.entry.url;
        link.textContent = result.entry.title;
        item.appendChild(link);
        var summary = doc.createElement("p");
        summary.textContent = excerpt(String(result.entry.text || ""), terms[0]);
        item.appendChild(summary);
        list.appendChild(item);
      });
      list.hidden = shown.length === 0;
      var count = results.length;
      var quoted = "“" + query + "”";
      status.textContent = count === 0
        ? "No results for " + quoted
        : count + (count === 1 ? " result" : " results") + " for " + quoted + (count > shown.length ? ", showing the first " + shown.length : "");
    }

    function schedule() {
      window.clearTimeout(timer);
      timer = window.setTimeout(function () {
        load().then(function () { run(input.value.trim()); });
      }, 150);
    }

    input.addEventListener("focus", load);
    input.addEventListener("input", schedule);
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      load().then(function () {
        run(input.value.trim());
        var first = list.querySelector("a");
        if (first) first.focus();
      });
    });
    form.addEventListener("keydown", function (event) {
      var links = all("a", list);
      var at = links.indexOf(doc.activeElement);
      if (event.key === "Escape") {
        if (input.value || !list.hidden) {
          event.preventDefault();
          input.value = "";
          clear();
          status.textContent = "";
          input.focus();
        }
      } else if (event.key === "ArrowDown" && links.length) {
        event.preventDefault();
        (links[at + 1] || links[0]).focus();
      } else if (event.key === "ArrowUp" && links.length) {
        event.preventDefault();
        if (at <= 0) input.focus(); else links[at - 1].focus();
      }
    });
    form.addEventListener("focusout", function () {
      window.setTimeout(function () {
        if (!form.contains(doc.activeElement)) list.hidden = true;
      }, 0);
    });
    form.addEventListener("focusin", function () {
      if (list.firstChild) list.hidden = false;
    });

    // "/" focuses search (WCAG 2.1.4: the shortcut can be turned off in the footer).
    doc.addEventListener("keydown", function (event) {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      if (readPreference("shortcuts") === "off") return;
      var target = event.target;
      var tag = target && target.tagName;
      if (target && (target.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT")) return;
      event.preventDefault();
      input.focus();
      input.select();
    });
    initShortcutToggle();
  }

  function initShortcutToggle() {
    var holder = doc.getElementById("docops-shortcuts");
    var button = holder && holder.querySelector("button");
    if (!holder || !button) return;
    function sync() {
      button.textContent = readPreference("shortcuts") === "off" ? "Turn on the / shortcut" : "Turn off the / shortcut";
    }
    button.addEventListener("click", function () {
      var off = readPreference("shortcuts") === "off";
      writePreference("shortcuts", off ? "on" : "off");
      sync();
      announce(off ? "The / shortcut is on" : "The / shortcut is off");
    });
    holder.hidden = false;
    sync();
  }

  // ---- Tabs (WAI-ARIA tabs pattern, automatic activation) ---------------------
  var tabGroups = 0;
  function initTabs() {
    all("[data-tabs]").forEach(function (group) {
      var panels = all(":scope > .tab-panel", group);
      if (!panels.length) return;
      tabGroups += 1;
      var prefix = "docops-tabs-" + tabGroups;
      var tablist = doc.createElement("div");
      tablist.setAttribute("role", "tablist");
      var tabs = panels.map(function (panel, i) {
        var heading = panel.querySelector(":scope > .tab-heading");
        var label = panel.getAttribute("data-tab-label") || (heading ? heading.textContent : "Tab " + (i + 1));
        var tab = doc.createElement("button");
        tab.type = "button";
        tab.id = prefix + "-tab-" + i;
        tab.setAttribute("role", "tab");
        if (!panel.id) panel.id = prefix + "-panel-" + i;
        tab.setAttribute("aria-controls", panel.id);
        tab.textContent = label;
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", tab.id);
        panel.tabIndex = 0;
        if (heading) heading.hidden = true;
        tablist.appendChild(tab);
        return tab;
      });
      function select(index, focus) {
        tabs.forEach(function (tab, i) {
          var selected = i === index;
          tab.setAttribute("aria-selected", selected ? "true" : "false");
          tab.tabIndex = selected ? 0 : -1;
          panels[i].hidden = !selected;
        });
        if (focus) tabs[index].focus();
      }
      tablist.addEventListener("click", function (event) {
        var tab = event.target && event.target.closest ? event.target.closest("[role='tab']") : null;
        var i = tabs.indexOf(tab);
        if (i >= 0) select(i, false);
      });
      tablist.addEventListener("keydown", function (event) {
        var current = tabs.indexOf(doc.activeElement);
        if (current < 0) return;
        var next = -1;
        if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
        else if (event.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = tabs.length - 1;
        if (next >= 0) {
          event.preventDefault();
          select(next, true);
        }
      });
      group.insertBefore(tablist, group.firstChild);
      group.classList.add("tabs-enhanced");
      select(0, false);
    });

    // Show the panel that contains the URL fragment target.
    function revealTarget() {
      var id = "";
      try { id = decodeURIComponent(window.location.hash.slice(1)); } catch (error) { return; }
      var target = id ? doc.getElementById(id) : null;
      var panel = target && target.closest ? target.closest("[role='tabpanel'][hidden]") : null;
      if (!panel) return;
      var tab = doc.getElementById(panel.getAttribute("aria-labelledby") || "");
      if (tab) tab.click();
      target.scrollIntoView();
    }
    window.addEventListener("hashchange", revealTarget);
    revealTarget();
  }

  // ---- Copy buttons -------------------------------------------------------------
  function initCopyButtons() {
    if (!navigator.clipboard || !window.isSecureContext) return;
    all(".code-block").forEach(function (block) {
      var pre = block.querySelector("pre");
      if (!pre || block.querySelector(".copy-button")) return;
      var button = doc.createElement("button");
      button.type = "button";
      button.className = "copy-button";
      button.textContent = "Copy";
      button.addEventListener("click", function () {
        navigator.clipboard.writeText(pre.textContent || "").then(function () {
          button.textContent = "Copied";
          announce("Code copied to clipboard");
          window.setTimeout(function () { button.textContent = "Copy"; }, 2000);
        }, function () {
          announce("Copying failed");
        });
      });
      block.insertBefore(button, pre);
    });
  }

  // ---- Try it console -----------------------------------------------------------
  function allowedServer(url) {
    return /^https:\/\//i.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(url) || url.charAt(0) === "/";
  }

  function initTryIt() {
    if (!window.fetch) return;
    all("[data-try-it]").forEach(function (section) {
      var form = section.querySelector("form");
      var output = section.querySelector(".try-it-response");
      if (!form || !output) return;
      section.hidden = false;
      var method = (form.getAttribute("data-method") || "GET").toUpperCase();
      var template = form.getAttribute("data-path") || "/";
      var busy = false;
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        if (busy) return;
        var serverField = form.querySelector("[name='server']");
        var server = serverField ? serverField.value : "";
        if (!allowedServer(server)) {
          output.textContent = "Requests can only be sent to the HTTPS servers listed in the API description.";
          return;
        }
        var path = template;
        var query = [];
        var headers = {};
        var missing = [];
        all("[data-param-in]", form).forEach(function (field) {
          var where = field.getAttribute("data-param-in");
          var name = field.getAttribute("data-param-name") || "";
          var value = field.value;
          if (value === "") {
            if (field.required) missing.push(name);
            return;
          }
          if (where === "path") path = path.split("{" + name + "}").join(encodeURIComponent(value));
          else if (where === "query") query.push(encodeURIComponent(name) + "=" + encodeURIComponent(value));
          else if (where === "header") headers[name] = value;
        });
        if (missing.length) {
          output.textContent = "Fill in the required parameters: " + missing.join(", ");
          return;
        }
        // The token lives only in the password field (memory); it is never stored or logged.
        var token = form.querySelector("[name='token']");
        if (token && token.value) headers.Authorization = "Bearer " + token.value;
        var init = { method: method, headers: headers, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" };
        var body = form.querySelector("[name='body']");
        if (body && body.value.trim() && method !== "GET" && method !== "HEAD") {
          init.body = body.value;
          headers["Content-Type"] = body.getAttribute("data-content-type") || "application/json";
        }
        var url = server.replace(/\/+$/, "") + path + (query.length ? "?" + query.join("&") : "");
        busy = true;
        output.textContent = "Sending " + method + " request…";
        fetch(url, init)
          .then(function (response) {
            return response.text().then(function (text) {
              var shown = text;
              try { shown = JSON.stringify(JSON.parse(text), null, 2); } catch (error) { /* not JSON */ }
              output.textContent = "HTTP " + response.status + (response.statusText ? " " + response.statusText : "") + "\n\n" + shown;
            });
          })
          .catch(function (error) {
            output.textContent = "Request failed: " + (error && error.message ? error.message : "network error") +
              ". The API must allow cross-origin requests (CORS) from this site.";
          })
          .then(function () { busy = false; });
      });
    });
  }

  function init() {
    initSidebar();
    initSearch();
    initTabs();
    initCopyButtons();
    initTryIt();
  }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", init);
  else init();
})();
`;
