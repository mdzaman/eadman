/* DocOps portal script: progressive enhancement only (every page works without it).
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
        link.href = result.entry.url;
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
