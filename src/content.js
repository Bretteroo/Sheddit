// SPDX-License-Identifier: AGPL-3.0-only
// Sheddit: hide Reddit posts that match any enabled filter (see filters.js).
//
// Only the page you're looking at is checked:
//   - listing pages (front page, subreddits, search): thread titles only
//   - thread pages (/comments/...): the opened post's title and body

(() => {
  "use strict";

  // Holds the ids of the filters that hid an element, separated by spaces.
  const HIDDEN_ATTR = "data-sheddit-hidden";
  // Set on a veiled post after the reader clicks Peek, so rescans leave it be.
  const REVEALED_ATTR = "data-sheddit-revealed";
  // Every caught element keeps the ids of the filters that caught it and
  // whether it is a post or a comment, even after Peek, for the toolbar
  // popup's counts.
  const CAUGHT_ATTR = "data-sheddit-caught";
  const KIND_ATTR = "data-sheddit-kind";

  // One entry per Reddit layout: how to find a post, its title, its body, and
  // the address a link post points to.
  const LAYOUTS = [
    {
      // Current Reddit (shreddit web components).
      post: "shreddit-post",
      title: (p) => p.getAttribute("post-title") || text(p, '[slot="title"]'),
      body: (p) => blockText(p, '[slot="text-body"]'),
      bodySelector: '[slot="text-body"]',
      link: (p) => p.getAttribute("content-href") || p.getAttribute("domain") || "",
      wrapper: "article",
    },
    {
      // Current Reddit search results. Each result is an sdui-post-unit;
      // earlier versions of the page called it search-post-unit.
      post: '[data-testid="sdui-post-unit"], [data-testid="search-post-unit"]',
      title: (p) => text(p, '[data-testid="post-title"], [data-testid="post-title-text"]'),
      body: () => "",
      link: () => "",
      wrapper: "search-telemetry-tracker",
    },
    {
      // Older React redesign.
      post: '[data-testid="post-container"]',
      title: (p) => text(p, "h1, h3"),
      body: (p) => blockText(p, '[data-click-id="text"], [data-adclicklocation="media"]'),
      bodySelector: '[data-click-id="text"]',
      link: (p) => attr(p, 'a[data-testid="outbound-link"]', "href"),
    },
    {
      // old.reddit.com
      post: "div.thing.link",
      title: (p) => text(p, "a.title"),
      body: (p) => blockText(p, ".usertext-body"),
      bodySelector: ".usertext-body",
      link: (p) => p.getAttribute("data-url") || p.getAttribute("data-domain") || "",
    },
    {
      // old.reddit.com search results, which use their own markup.
      post: "div.search-result-link",
      title: (p) => text(p, "a.search-title"),
      body: (p) => blockText(p, ".search-result-body"),
      bodySelector: ".search-result-body",
      link: (p) => attr(p, "a.search-link", "href"),
    },
  ];

  // Comment layouts: the comment element and its own text, excluding replies.
  const COMMENT_LAYOUTS = [
    // Current Reddit. On wide screens the comment's text is a direct child.
    // The phone layout (m.reddit.com) nests it inside a <details> element
    // that also holds the replies; the comment's own text comes before
    // them, so the first match is it, unless the comment has no text.
    {
      comment: "shreddit-comment",
      body: (c) => {
        const el = c.querySelector(':scope > [slot="comment"], :scope > details [slot="comment"]');
        return el && el.closest("shreddit-comment") === c ? el : null;
      },
    },
    // old.reddit.com
    { comment: "div.thing.comment", body: (c) => c.querySelector(":scope > .entry .usertext-body") },
  ];

  let postFilters = [];
  let commentFilters = [];
  let mode = "hide";

  // Per veiled post: its overlay marker and the observer that keeps the
  // overlay the same size as the post.
  const veils = new Map();
  // Per post revealed with Peek: the "Hide again" tab above it and the cap
  // below it.
  const rehideBars = new Map();

  // Peek and Hide again fade the post in or out over this many milliseconds,
  // or instantly for readers who ask their system for reduced motion.
  const FADE_MS = 280;
  // Height of the placeholder bar that replaces a hidden post or comment.
  const BAR_HEIGHT = { post: 64, comment: 44 };
  // On phone-width screens a comment bar's two lines of text wrap, so it
  // gets more room there.
  const NARROW = "(max-width: 480px)";
  const NARROW_COMMENT_BAR = 64;
  function barHeight(kind) {
    return kind === "comment" && window.matchMedia(NARROW).matches ? NARROW_COMMENT_BAR : BAR_HEIGHT[kind];
  }

  function motionMs() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : FADE_MS;
  }
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Peek and Hide again animate a post's height and opacity with inline
  // !important styles, which outrank the .sheddit-veiled class. Reddit's own
  // inline values for these properties are saved first and put back after.
  const ANIMATED_PROPS = ["height", "min-height", "max-height", "overflow", "opacity",
    "box-sizing", "pointer-events", "transition"];
  const savedInline = new Map();
  // Bumped whenever a post's animation starts or is cancelled, so a stale
  // animation stops at its next step.
  const animRuns = new Map();

  function setInline(el, props) {
    if (!savedInline.has(el)) {
      savedInline.set(el, ANIMATED_PROPS.map((k) =>
        [k, el.style.getPropertyValue(k), el.style.getPropertyPriority(k)]));
    }
    for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v, "important");
  }

  function restoreInline(el) {
    const saved = savedInline.get(el);
    if (!saved) return;
    for (const [k, v, priority] of saved) {
      if (v) el.style.setProperty(k, v, priority);
      else el.style.removeProperty(k);
    }
    savedInline.delete(el);
  }

  function startRun(el) {
    const run = (animRuns.get(el) || 0) + 1;
    animRuns.set(el, run);
    return () => animRuns.get(el) === run;
  }

  function fade(el, frames) {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    return el.animate(frames, { duration: reduce ? 0 : FADE_MS, easing: "ease" }).finished;
  }

  const VEIL_CSS = `
    .sheddit-veiled {
      box-sizing: border-box !important;
      height: ${BAR_HEIGHT.post}px !important;
      min-height: 0 !important;
      max-height: none !important;
      overflow: hidden !important;
      opacity: 0 !important;
      pointer-events: none !important;
      user-select: none !important;
    }
    .sheddit-veiled-comment { height: ${BAR_HEIGHT.comment}px !important; }
    @media ${NARROW} {
      .sheddit-veiled-comment { height: ${NARROW_COMMENT_BAR}px !important; }
    }
    /* Inline elements ignore height, so they become blocks while hidden. */
    .sheddit-block { display: block !important; }
    .sheddit-veil {
      position: relative !important;
      height: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
      z-index: 3;
    }
    .sheddit-veil-card {
      position: absolute;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 14px;
      padding: 10px 18px;
      border-radius: 14px;
      overflow: hidden;
      font: 14px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
      text-align: left;
      color: #5b4a1f;
      background:
        radial-gradient(ellipse 60% 120% at 50% -20%, rgba(255, 214, 120, 0.55), transparent 70%),
        linear-gradient(160deg, rgba(255, 250, 235, 0.94), rgba(240, 233, 255, 0.94));
      box-shadow:
        inset 0 0 0 1px rgba(214, 170, 60, 0.45),
        0 0 28px rgba(255, 196, 80, 0.22);
    }
    .sheddit-veil-sun {
      flex: none;
      width: 30px;
      height: 30px;
      color: #d9a21b;
      filter: drop-shadow(0 0 6px rgba(255, 190, 60, 0.7));
    }
    .sheddit-veil-text { min-width: 0; }
    .sheddit-veil-compact {
      justify-content: flex-start;
      gap: 10px;
      padding: 4px 12px;
      border-radius: 10px;
      font-size: 13px;
    }
    .sheddit-veil-compact .sheddit-veil-sun { width: 20px; height: 20px; }
    .sheddit-veil-compact .sheddit-veil-text { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
    .sheddit-veil-line { font-weight: 600; }
    .sheddit-veil-why { opacity: 0.75; font-size: 12px; }
    .sheddit-filter { white-space: nowrap; }
    .sheddit-info {
      display: inline-flex;
      vertical-align: -2px;
      margin-left: 3px;
      color: inherit;
      opacity: 0.8;
    }
    .sheddit-info:hover, .sheddit-info:focus-visible { opacity: 1; color: #c98f0e; }
    .sheddit-info svg { width: 13px; height: 13px; }
    .sheddit-caught-tap { cursor: pointer; -webkit-tap-highlight-color: transparent; }
    .sheddit-explain {
      position: absolute;
      z-index: 2147483000;
      box-sizing: border-box;
      max-width: min(320px, calc(100vw - 16px));
      padding: 10px 14px;
      border-radius: 12px;
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
      text-align: left;
      color: #5b4a1f;
      background: linear-gradient(160deg, rgb(255, 250, 235), rgb(240, 233, 255));
      box-shadow:
        inset 0 0 0 1px rgba(214, 170, 60, 0.55),
        0 6px 24px rgba(0, 0, 0, 0.18);
    }
    .sheddit-explain-item + .sheddit-explain-item { margin-top: 8px; }
    .sheddit-explain-title { font-weight: 600; }
    .sheddit-veil-peek {
      flex: none;
      font: inherit;
      font-size: 12px;
      padding: 4px 14px;
      border-radius: 999px;
      border: 1px solid rgba(201, 150, 30, 0.7);
      background: rgba(255, 255, 255, 0.5);
      color: inherit;
      cursor: pointer;
    }
    .sheddit-veil-peek:hover { background: rgba(255, 226, 150, 0.7); }
    .sheddit-rehide {
      display: flex !important;
      justify-content: flex-end;
      margin: 4px 0 0;
      font: 12px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
      color: #8a6d1f;
    }
    /* A rounded tab in the overlay's colors that fades out toward the
       post below it. */
    .sheddit-rehide-tab {
      position: relative;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 7px 10px 12px 16px;
      border-radius: 14px 14px 0 0;
      background:
        radial-gradient(ellipse 70% 140% at 50% -30%, rgba(255, 214, 120, 0.5), transparent 70%),
        linear-gradient(180deg, rgba(255, 250, 235, 0.95), rgba(240, 233, 255, 0.55) 55%, rgba(240, 233, 255, 0));
    }
    /* The tab turned upside down, a third as tall and full width, below
       the post. */
    .sheddit-rehide-cap {
      position: relative;
      display: block !important;
      clear: both;
      box-sizing: border-box;
      margin: 0 0 4px;
      border-radius: 0 0 14px 14px;
      background:
        radial-gradient(ellipse 70% 140% at 50% 130%, rgba(255, 214, 120, 0.5), transparent 70%),
        linear-gradient(0deg, rgba(255, 250, 235, 0.95), rgba(240, 233, 255, 0.55) 55%, rgba(240, 233, 255, 0));
    }
    /* Thin edges down both sides of a revealed post, joining the tab above
       to the cap below. They hang from the tab's bar, so they fade and
       slide along with it. */
    /* Above the post, so the post's own backgrounds can't paint over the
       side edges. */
    .sheddit-rehide { position: relative; z-index: 3; }
    .sheddit-rehide-frame {
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      border-right: 1px solid rgba(214, 170, 60, 0.45);
      pointer-events: none;
      --shoulder: 0px;
      --corner: 14px;
    }
    /* The left edge, below the rounded corner. */
    .sheddit-rehide-frame::after {
      content: "";
      position: absolute;
      top: var(--corner);
      bottom: 0;
      left: 0;
      border-left: 1px solid rgba(214, 170, 60, 0.45);
    }
    /* The line from the left edge across to the tab, curving down into the
       left edge. */
    .sheddit-rehide-frame::before {
      content: "";
      position: absolute;
      top: 0;
      left: 0;
      width: var(--shoulder);
      height: var(--corner);
      box-sizing: border-box;
      border-top: 1px solid rgba(214, 170, 60, 0.45);
      border-left: 1px solid rgba(214, 170, 60, 0.45);
      border-top-left-radius: var(--corner);
    }
    .sheddit-rehide-cap::before {
      content: "";
      position: absolute;
      inset: 0;
      border: 1px solid rgba(214, 170, 60, 0.45);
      border-top: none;
      border-radius: inherit;
      pointer-events: none;
    }
    .sheddit-rehide-tab::before {
      content: "";
      position: absolute;
      inset: 0;
      border: 1px solid rgba(214, 170, 60, 0.45);
      border-bottom: none;
      border-radius: inherit;
      pointer-events: none;
    }
    /* Dark colors follow Reddit's own theme, not the system's: Sheddit sets
       this class when the page's background is dark (see updateTheme). */
    html.sheddit-theme-dark .sheddit-veil-card {
      color: #f3e2b3;
      background:
        radial-gradient(ellipse 60% 120% at 50% -20%, rgba(255, 196, 80, 0.3), transparent 70%),
        linear-gradient(160deg, rgba(44, 36, 22, 0.95), rgba(28, 24, 48, 0.95));
      box-shadow:
        inset 0 0 0 1px rgba(214, 170, 60, 0.4),
        0 0 28px rgba(255, 196, 80, 0.15);
    }
    html.sheddit-theme-dark .sheddit-explain {
      color: #f3e2b3;
      background: linear-gradient(160deg, rgb(44, 36, 22), rgb(28, 24, 48));
      box-shadow:
        inset 0 0 0 1px rgba(214, 170, 60, 0.5),
        0 6px 24px rgba(0, 0, 0, 0.5);
    }
    html.sheddit-theme-dark .sheddit-veil-peek { background: rgba(0, 0, 0, 0.25); }
    html.sheddit-theme-dark .sheddit-veil-peek:hover { background: rgba(214, 170, 60, 0.3); }
    html.sheddit-theme-dark .sheddit-rehide { color: #d9b866; }
    html.sheddit-theme-dark .sheddit-rehide-cap {
      background:
        radial-gradient(ellipse 70% 140% at 50% 130%, rgba(255, 196, 80, 0.28), transparent 70%),
        linear-gradient(0deg, rgba(44, 36, 22, 0.95), rgba(28, 24, 48, 0.55) 55%, rgba(28, 24, 48, 0));
    }
    html.sheddit-theme-dark .sheddit-rehide-tab {
      background:
        radial-gradient(ellipse 70% 140% at 50% -30%, rgba(255, 196, 80, 0.28), transparent 70%),
        linear-gradient(180deg, rgba(44, 36, 22, 0.95), rgba(28, 24, 48, 0.55) 55%, rgba(28, 24, 48, 0));
    }
  `;

  // Reddit has its own light/dark switch, separate from the system's, so the
  // overlay matches the page: dark when the page's background is dark.
  function pageIsDark() {
    for (const el of [document.body, document.documentElement]) {
      if (!el) continue;
      const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(el).backgroundColor);
      if (!m) continue;
      const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(parseFloat);
      if (a < 0.5) continue;
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
    }
    return false;
  }

  function updateTheme() {
    document.documentElement.classList.toggle("sheddit-theme-dark", pageIsDark());
  }

  const SVG_NS = "http://www.w3.org/2000/svg";

  // A small sun: a filled circle with eight rays.
  function sunIcon() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "sheddit-veil-sun");
    svg.setAttribute("viewBox", "0 0 32 32");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", "16");
    circle.setAttribute("cy", "16");
    circle.setAttribute("r", "6");
    circle.setAttribute("fill", "currentColor");
    circle.setAttribute("fill-opacity", "0.25");
    const rays = document.createElementNS(SVG_NS, "path");
    rays.setAttribute("d",
      "M16 2v4M16 26v4M2 16h4M26 16h4M6.1 6.1l2.8 2.8M23.1 23.1l2.8 2.8M6.1 25.9l2.8-2.8M23.1 8.9l2.8-2.8");
    svg.append(circle, rays);
    return svg;
  }

  function withChildren(el, ...children) {
    el.append(...children);
    return el;
  }

  function div(className, text) {
    const el = document.createElement("div");
    el.className = className;
    if (text) el.textContent = text;
    return el;
  }

  function injectStyles() {
    if (document.getElementById("sheddit-styles")) return;
    const style = document.createElement("style");
    style.id = "sheddit-styles";
    style.textContent = VEIL_CSS;
    (document.head || document.documentElement).append(style);
  }

  function attr(root, selector, name) {
    const el = root.querySelector(selector);
    return (el && el.getAttribute(name)) || "";
  }

  // "https://www.youtube.com/watch?v=..." or a bare "youtube.com" becomes
  // "youtube.com". Reddit's own addresses (self posts) come back as-is and
  // never match an outside site.
  function domainOf(link) {
    if (!link) return "";
    try {
      const url = new URL(/^[a-z]+:/i.test(link) || link.startsWith("/") ? link : "https://" + link, location.href);
      return url.hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return "";
    }
  }

  // Embedded media can name its source in a few places: an iframe or video
  // src, the HTML Reddit stores for an embed (shreddit-embed's "html", old
  // Reddit's "data-cachedhtml"), or a URL-encoded address inside a Reddit or
  // Embedly wrapper URL. Collect every address found there, plus links in
  // the post body, and return their domains.
  const MEDIA = "iframe, embed, object, video, source, shreddit-embed, [data-cachedhtml], [html]";
  const MEDIA_ATTRS = ["src", "data-src", "data", "html", "data-cachedhtml"];
  // Matches only the scheme and host, so an address nested inside another
  // (".../media.html?src=https://www.youtube.com/...") is found separately.
  const HOST_RE = /https?:\/\/([^\s"'<>\/?#&:]+)/gi;

  function hostsIn(value) {
    const found = new Set();
    let decoded = value;
    // Wrapper URLs carry the real address encoded once or twice.
    for (let i = 0; i < 3; i++) {
      for (const m of decoded.matchAll(HOST_RE)) {
        found.add(m[1].replace(/^www\./i, "").toLowerCase());
      }
      try {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      } catch {
        break;
      }
    }
    return found;
  }

  function linkedDomains(post, bodySelector) {
    const domains = new Set();
    for (const el of post.querySelectorAll(MEDIA)) {
      for (const name of MEDIA_ATTRS) {
        const value = el.getAttribute(name);
        if (!value) continue;
        for (const host of hostsIn(value)) domains.add(host);
      }
    }
    const body = bodySelector && post.querySelector(bodySelector);
    if (body) {
      for (const a of body.querySelectorAll("a[href]")) domains.add(domainOf(a.getAttribute("href")));
    }
    domains.delete("");
    return [...domains];
  }

  // Body text with web addresses removed, so a body that is nothing but a
  // pasted link counts as having no text. Addresses are anything starting
  // with http(s):// or www., or a word like "youtu.be/abc" with a dot before
  // its first slash.
  function hasRealText(body) {
    return body
      .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "")
      .replace(/(^|\s)[\w-]+(?:\.[\w-]+)+\/\S*/g, "$1")
      .trim().length > 0;
  }

  function text(root, selector) {
    const el = root.querySelector(selector);
    return el ? el.textContent : "";
  }

  // Body text with a blank line between paragraphs, list items, headings and
  // code blocks, so filters can tell how the post is laid out.
  const BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, pre, blockquote";

  function blockText(root, selector) {
    const el = root.querySelector(selector);
    if (!el) return "";
    const blocks = el.querySelectorAll(BLOCKS);
    if (!blocks.length) return el.textContent;
    return Array.from(blocks, (b) => b.textContent.trim()).join("\n\n");
  }

  function onThreadPage() {
    return /\/comments\//.test(location.pathname);
  }

  function setHidden(el, filterId) {
    el.setAttribute(HIDDEN_ATTR, filterId);
    el.style.setProperty("display", "none", "important");
  }

  function hide(post, layout, matches, title) {
    const target = (layout.wrapper && post.closest(layout.wrapper)) || post;
    const link = post.querySelector('a[href*="/comments/"]');
    const id = post.getAttribute("data-fullname") ||
      (/^t3_/.test(post.id) ? post.id : "") ||
      post.getAttribute("permalink") ||
      (link && new URL(link.href, location.href).pathname) ||
      "h" + hashText(title);
    conceal(target, matches, "post", id, isOpenPost(post, layout));
  }

  // Whether `post` is the one this thread page is about, as opposed to
  // other posts Reddit suggests around it. Compared by the post id in the
  // permalink; a layout without permalinks counts its first post.
  function isOpenPost(post, layout) {
    const threadId = (path) => (/\/comments\/([a-z0-9]+)/i.exec(path) || [])[1];
    const here = threadId(location.pathname);
    if (!here) return false;
    const link = post.getAttribute("permalink") || post.getAttribute("data-permalink");
    if (link) return threadId(new URL(link, location.href).pathname) === here;
    return document.querySelector(layout.post) === post;
  }

  // A short, stable fingerprint for items that carry no Reddit id.
  function hashText(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  // Caught items are sent to the background script in batches, which keeps
  // the 24-hour, 7-day and 30-day history shown in the toolbar popup.
  let pendingHistory = [];
  let historyTimer = null;
  function remember(id, kind, matches) {
    pendingHistory.push({ id, kind, filters: matches.map((f) => f.id) });
    if (historyTimer) return;
    historyTimer = setTimeout(() => {
      const items = pendingHistory;
      pendingHistory = [];
      historyTimer = null;
      Promise.resolve(shedditApi.runtime.sendMessage({ type: "sheddit-caught", items })).catch(() => {});
    }, 1000);
  }

  // "Caught by A", "Caught by A and B", "Caught by A, B, and C", with an
  // info icon after each name that shows the filter's description on hover.
  // On phones, where nothing can hover, tapping the line opens a panel
  // with the descriptions instead (see explain).
  function caughtBy(matches) {
    const line = document.createElement("span");
    if (isTouch()) {
      line.className = "sheddit-caught-tap";
      line.setAttribute("role", "button");
      line.setAttribute("aria-expanded", "false");
      line.tabIndex = 0;
      line.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        explain(line, matches);
      });
    }
    line.append("Caught by ");
    matches.forEach((f, i) => {
      if (i > 0) {
        const last = i === matches.length - 1;
        line.append(matches.length > 2 ? (last ? ", and " : ", ") : " and ");
      }
      const name = document.createElement("span");
      name.className = "sheddit-filter";
      name.append(f.title, infoIcon(f));
      line.append(name);
    });
    return line;
  }

  // Firefox for Android reports a fine pointer that can hover, so the user
  // agent decides too.
  function isTouch() {
    return /Android|iPhone|iPad|Mobi/i.test(navigator.userAgent) ||
      window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  }

  // The open description panel and the line it belongs to, if any.
  let explained = null;

  function closeExplain() {
    if (!explained) return;
    explained.panel.remove();
    explained.line.setAttribute("aria-expanded", "false");
    explained = null;
  }

  // Show each filter's description in a panel just below `line`. It lives
  // on <body>, since the overlay card clips anything drawn outside it.
  // Tapping the line again, or anywhere else, closes it.
  function explain(line, matches) {
    const same = explained && explained.line === line;
    closeExplain();
    if (same) return;
    injectStyles();
    const panel = div("sheddit-explain");
    for (const f of matches) {
      const item = div("sheddit-explain-item");
      item.append(div("sheddit-explain-title", f.title), div("", f.description));
      panel.append(item);
    }
    panel.addEventListener("click", (e) => e.stopPropagation());
    document.body.append(panel);
    const r = line.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(r.left, window.innerWidth - panel.offsetWidth - margin));
    panel.style.left = `${left + window.scrollX}px`;
    panel.style.top = `${r.bottom + 6 + window.scrollY}px`;
    line.setAttribute("aria-expanded", "true");
    explained = { line, panel };
  }

  document.addEventListener("pointerdown", (e) => {
    if (explained && !explained.panel.contains(e.target) && !explained.line.contains(e.target)) {
      closeExplain();
    }
  }, true);
  // Phones resize the viewport whenever the address bar slides away, so
  // only a change of width (like turning the phone) closes the panel.
  let explainWidth = window.innerWidth;
  window.addEventListener("resize", () => {
    if (window.innerWidth !== explainWidth) closeExplain();
    explainWidth = window.innerWidth;
  });

  // A circled "i". The browser's own tooltip shows the description, since
  // the card clips anything drawn outside it.
  function infoIcon(filter) {
    const wrap = document.createElement("span");
    wrap.className = "sheddit-info";
    wrap.title = filter.description;
    wrap.tabIndex = 0;
    wrap.setAttribute("role", "img");
    wrap.setAttribute("aria-label", `About ${filter.title}: ${filter.description}`);
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    const ring = document.createElementNS(SVG_NS, "circle");
    ring.setAttribute("cx", "8");
    ring.setAttribute("cy", "8");
    ring.setAttribute("r", "6.5");
    ring.setAttribute("fill", "none");
    ring.setAttribute("stroke", "currentColor");
    ring.setAttribute("stroke-width", "1.3");
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("cx", "8");
    dot.setAttribute("cy", "4.9");
    dot.setAttribute("r", "0.95");
    dot.setAttribute("fill", "currentColor");
    const stem = document.createElementNS(SVG_NS, "path");
    stem.setAttribute("d", "M8 7.2v4.3");
    stem.setAttribute("stroke", "currentColor");
    stem.setAttribute("stroke-width", "1.5");
    stem.setAttribute("stroke-linecap", "round");
    svg.append(ring, dot, stem);
    wrap.append(svg);
    return wrap;
  }

  // Hide or veil an element. `matches` lists every enabled filter it
  // triggered. For comments the element is the comment's own text, so its
  // author line and replies stay visible.
  // In Remove mode, `keepVisible` (the post a thread page is about) still
  // gets the overlay, so opening a thread never shows an empty page.
  function conceal(target, matches, kind, id, keepVisible = false) {
    if (target.hasAttribute(HIDDEN_ATTR) || target.hasAttribute(REVEALED_ATTR)) return;
    target.setAttribute(CAUGHT_ATTR, matches.map((f) => f.id).join(" "));
    target.setAttribute(KIND_ATTR, kind);
    remember(id, kind, matches);
    if (mode === "veil" || keepVisible) {
      veil(target, matches, kind);
      return;
    }
    const filterId = matches.map((f) => f.id).join(" ");
    setHidden(target, filterId);

    // Feeds and search results put an <hr> between posts; hide the orphaned
    // one too.
    const next = target.nextElementSibling;
    if (/^(ARTICLE|SEARCH-TELEMETRY-TRACKER)$/.test(target.tagName) && next && next.tagName === "HR") {
      setHidden(next, filterId);
    }
  }

  // Cover a post with an overlay. The overlay hangs from a zero-height
  // marker inserted just before the post, so Reddit's own elements are
  // styled but never moved or rewritten.
  // Replace a post with a short placeholder bar. The post itself stays in
  // the page, shrunk to the bar's height and made invisible, and the bar
  // hangs over it from a zero-height marker inserted just before it, so
  // Reddit's own elements are styled but never moved or rewritten.
  //
  // With `animated` (Hide again), the post and its Hide again tab and cap
  // (`leaving`) fade out at full size while the bar fades in over the
  // post, then the post shrinks to the bar's height as the tab's and cap's
  // space closes.
  function veil(target, matches, kind, animated = false, leaving = []) {
    injectStyles();
    const ids = matches.map((f) => f.id).join(" ");
    target.setAttribute(HIDDEN_ATTR, ids);
    const current = startRun(target);
    if (getComputedStyle(target).display === "inline") target.classList.add("sheddit-block");
    const collapse = () => {
      target.classList.add("sheddit-veiled");
      if (kind === "comment") target.classList.add("sheddit-veiled-comment");
    };
    if (animated) {
      setInline(target, { "box-sizing": "border-box", height: `${target.offsetHeight}px`,
        overflow: "hidden", opacity: "1", "pointer-events": "none" });
    } else {
      collapse();
    }

    const marker = document.createElement("div");
    marker.className = "sheddit-veil";
    // A slotted element (like a shreddit comment's text) only renders in its
    // named slot, so the marker has to join the same slot to sit beside it.
    const slot = target.getAttribute("slot");
    if (slot) marker.setAttribute("slot", slot);
    const card = div("sheddit-veil-card" + (kind === "comment" ? " sheddit-veil-compact" : ""));
    const words = div("sheddit-veil-text");
    words.append(
      div("sheddit-veil-line", `You have risen above this ${kind}.`),
      withChildren(div("sheddit-veil-why"), caughtBy(matches)),
    );
    const peek = document.createElement("button");
    peek.type = "button";
    peek.className = "sheddit-veil-peek";
    peek.textContent = "Peek";
    card.append(sunIcon(), words, peek);
    marker.append(card);
    target.before(marker);

    const fit = () => {
      card.style.top = `${target.offsetTop - marker.offsetTop}px`;
      card.style.left = `${target.offsetLeft - marker.offsetLeft}px`;
      card.style.width = `${target.offsetWidth}px`;
      card.style.height = `${target.offsetHeight}px`;
    };
    fit();
    const resize = new ResizeObserver(fit);
    resize.observe(target);
    veils.set(target, { marker, resize, kind });

    if (animated) {
      (async () => {
        const ms = motionMs();
        fade(card, [{ opacity: 0 }, { opacity: 1 }]);
        for (const el of leaving) {
          el.style.pointerEvents = "none";
          fade(el, [{ opacity: 1 }, { opacity: 0 }]);
        }
        setInline(target, { transition: `opacity ${ms}ms ease` });
        void target.offsetHeight;
        setInline(target, { opacity: "0" });
        await pause(ms);
        if (!current()) {
          leaving.forEach((el) => el.remove());
          return unpad(target);
        }
        for (const el of leaving) {
          el.style.opacity = "0";
          slide(el, "close");
        }
        setInline(target, { transition: `height ${ms}ms ease` });
        setInline(target, { height: `${barHeight(kind)}px` });
        await pause(ms);
        leaving.forEach((el) => el.remove());
        unpad(target);
        if (!current()) return;
        collapse();
        restoreInline(target);
      })();
    }

    peek.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      target.removeAttribute(HIDDEN_ATTR);
      target.setAttribute(REVEALED_ATTR, "");
      unveil(target, true, () => showRehideBar(target));
      addRehideBar(target, matches, kind);
    });
  }

  // After Peek, a tab above the post offers to cover it again, and a
  // matching cap a third of its height closes off the bottom. Both start
  // invisible and make room for themselves while the post expands;
  // showRehideBar fades them in once the post is at full height.
  function addRehideBar(target, matches, kind) {
    const tab = withChildren(div("sheddit-rehide-tab"), caughtBy(matches));
    const bar = withChildren(div("sheddit-rehide"), tab);
    const cap = div("sheddit-rehide-cap");
    const slot = target.getAttribute("slot");
    if (slot) {
      bar.setAttribute("slot", slot);
      cap.setAttribute("slot", slot);
    }
    const again = document.createElement("button");
    again.type = "button";
    again.className = "sheddit-veil-peek";
    again.textContent = "Hide again";
    tab.append(again);
    const frame = div("sheddit-rehide-frame");
    bar.append(frame);
    target.before(bar);
    target.after(cap);
    cap.style.height = `${Math.round(tab.offsetHeight / 3)}px`;
    // The frame spans the gap between the bar and the cap, which is the
    // post's height; it follows the post when it grows or shrinks.
    const fitFrame = () => {
      if (!bar.isConnected) return frameWatch.disconnect();
      const barRect = bar.getBoundingClientRect();
      const gap = cap.getBoundingClientRect().top - barRect.bottom;
      frame.style.height = `${Math.max(0, gap)}px`;
      // The top line reaches the tab's left edge, overlapping its 1px border.
      const shoulder = tab.getBoundingClientRect().left - barRect.left + 1;
      frame.style.setProperty("--shoulder", `${Math.max(0, shoulder)}px`);
      frame.style.setProperty("--corner", `${Math.min(14, Math.max(0, shoulder), Math.max(0, gap))}px`);
    };
    const frameWatch = new ResizeObserver(fitFrame);
    frameWatch.observe(target);
    padInside(target, kind, bar);
    fitFrame();
    const pieces = [bar, cap];
    rehideBars.set(target, pieces);
    for (const el of pieces) {
      el.style.opacity = "0";
      slide(el, "open");
    }

    again.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // The tab and cap leave with the post: veil fades them out, then
      // closes their space while the post shrinks, the reverse of Peek.
      rehideBars.delete(target);
      target.removeAttribute(REVEALED_ATTR);
      veil(target, matches, kind, true, pieces);
    });
  }

  // Open up or close a tab's space, margins included.
  function slide(el, direction) {
    const cs = getComputedStyle(el);
    const full = { height: `${el.offsetHeight}px`, marginTop: cs.marginTop, marginBottom: cs.marginBottom };
    const none = { height: "0px", marginTop: "0px", marginBottom: "0px" };
    el.style.overflow = "hidden";
    const anim = el.animate(direction === "open" ? [none, full] : [full, none],
      { duration: motionMs(), easing: "ease", fill: direction === "open" ? "none" : "forwards" });
    if (direction === "open") anim.finished.then(() => el.style.removeProperty("overflow"), () => {});
    return anim;
  }

  function showRehideBar(target) {
    for (const el of rehideBars.get(target) || []) {
      fade(el, [{ opacity: 0 }, { opacity: 1 }]).then(() => el.style.removeProperty("opacity"), () => {});
    }
  }

  // While a post is revealed, padding keeps its text off the frame's side
  // edges. Reddit's own padding values are saved and put back afterwards.
  const pads = new Map();
  function padInside(target, kind, bar) {
    if (pads.has(target)) return;
    const saved = ["padding-left", "padding-right"].map((k) =>
      [k, target.style.getPropertyValue(k), target.style.getPropertyPriority(k)]);
    // Inline elements only pad their first and last line, so they become
    // blocks while padded. One that was covered is a block already.
    const blockify = target.classList.contains("sheddit-block") ||
      getComputedStyle(target).display === "inline";
    if (blockify) target.classList.add("sheddit-block");
    // The frame follows the bar's edges, and Reddit sometimes lets a post
    // stick out past them with negative margins, so the padding is measured
    // from the frame line, and never less than Reddit's own.
    const space = kind === "comment" ? 10 : 12;
    const t = target.getBoundingClientRect();
    const b = bar.getBoundingClientRect();
    const cs = getComputedStyle(target);
    const left = Math.max(parseFloat(cs.paddingLeft) || 0, space + Math.max(0, b.left - t.left));
    const right = Math.max(parseFloat(cs.paddingRight) || 0, space + Math.max(0, t.right - b.right));
    target.style.setProperty("padding-left", `${left}px`, "important");
    target.style.setProperty("padding-right", `${right}px`, "important");
    pads.set(target, () => {
      for (const [k, v, priority] of saved) {
        if (v) target.style.setProperty(k, v, priority);
        else target.style.removeProperty(k);
      }
      if (blockify && !target.classList.contains("sheddit-veiled")) target.classList.remove("sheddit-block");
    });
  }

  function unpad(target) {
    const restore = pads.get(target);
    if (!restore) return;
    pads.delete(target);
    restore();
  }

  function removeRehideBar(target) {
    unpad(target);
    for (const el of rehideBars.get(target) || []) el.remove();
    rehideBars.delete(target);
  }

  // Remove a post's placeholder bar and show the post. With `animated`
  // (Peek), the bar first grows to the post's full height, then fades away
  // as the post fades in; `onExpanded` runs when that fade starts.
  function unveil(target, animated = false, onExpanded = null) {
    removeRehideBar(target);
    const current = startRun(target);
    // The overlay stays in `veils` until it is gone, so cancelling a Peek
    // halfway (say, by changing settings) still finds and removes it.
    const v = veils.get(target);
    const finish = () => {
      if (v) {
        v.resize.disconnect();
        v.marker.remove();
        if (veils.get(target) === v) veils.delete(target);
      }
      target.classList.remove("sheddit-veiled", "sheddit-veiled-comment");
      // A revealed post stays a block while it is padded inside its frame;
      // turning it back into an inline element here would rearrange it.
      if (!pads.has(target)) target.classList.remove("sheddit-block");
      restoreInline(target);
    };
    if (!animated || !v || !target.classList.contains("sheddit-veiled")) {
      finish();
      if (onExpanded) Promise.resolve().then(onExpanded);
      return;
    }
    (async () => {
      const ms = motionMs();
      v.marker.style.pointerEvents = "none";
      // While clipped, scrollHeight is the post's full content height.
      const borders = target.offsetHeight - target.clientHeight;
      const full = target.scrollHeight + borders;
      setInline(target, { "box-sizing": "border-box", height: `${target.offsetHeight}px`,
        "min-height": "0", "max-height": "none", overflow: "hidden", opacity: "0",
        "pointer-events": "none" });
      target.classList.remove("sheddit-veiled", "sheddit-veiled-comment");
      void target.offsetHeight;
      setInline(target, { transition: `height ${ms}ms ease` });
      setInline(target, { height: `${full}px` });
      await pause(ms);
      if (!current()) return;
      fade(v.marker, [{ opacity: 1 }, { opacity: 0 }]);
      if (onExpanded) onExpanded();
      setInline(target, { transition: `opacity ${ms}ms ease` });
      void target.offsetHeight;
      setInline(target, { opacity: "1" });
      await pause(ms);
      if (!current()) return;
      finish();
    })();
  }

  function unhideAll() {
    for (const el of document.querySelectorAll(`[${HIDDEN_ATTR}], [${REVEALED_ATTR}], [${CAUGHT_ATTR}]`)) {
      unveil(el);
      el.removeAttribute(HIDDEN_ATTR);
      el.removeAttribute(REVEALED_ATTR);
      el.removeAttribute(CAUGHT_ATTR);
      el.removeAttribute(KIND_ATTR);
      el.style.removeProperty("display");
    }
  }

  function scan() {
    updateTheme();
    const thread = onThreadPage();
    if (thread && commentFilters.length) scanComments();
    if (!postFilters.length) return;
    for (const layout of LAYOUTS) {
      for (const post of document.querySelectorAll(layout.post)) {
        const title = layout.title(post);
        const fullBody = layout.body(post);
        const body = thread ? fullBody : "";
        const haystack = body ? title + "\n" + body : title;
        const parts = {
          title,
          body,
          domain: domainOf(layout.link(post)),
          embeds: linkedDomains(post, layout.bodySelector),
          hasText: hasRealText(fullBody),
        };
        const matches = postFilters.filter((f) => f.test(haystack, parts));
        if (matches.length) hide(post, layout, matches, title);
      }
    }
  }

  function scanComments() {
    for (const layout of COMMENT_LAYOUTS) {
      for (const comment of document.querySelectorAll(layout.comment)) {
        const el = layout.body(comment);
        if (!el) continue;
        const blocks = el.querySelectorAll(BLOCKS);
        const text = blocks.length
          ? Array.from(blocks, (b) => b.textContent.trim()).join("\n\n")
          : el.textContent;
        if (!text.trim()) continue;
        const matches = commentFilters.filter((f) => f.test(text, { title: "", body: text }));
        if (matches.length) {
          const id = comment.getAttribute("thingid") || comment.getAttribute("data-fullname") ||
            "h" + hashText(text);
          conceal(el, matches, "comment", id);
        }
      }
    }
  }

  async function applySettings() {
    const enabled = await shedditLoadEnabled();
    mode = await shedditLoadMode();
    const active = SHEDDIT_FILTERS.filter((f) => enabled[f.id]);
    // Every filter checks both posts and comments.
    postFilters = active;
    commentFilters = active;
    unhideAll();
    scan();
  }

  // Reddit loads more titles on scroll and swaps pages without a full reload,
  // so rescan when the page changes, at most once per animation frame.
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      scan();
    });
  });

  // The toolbar popup asks the open tab what Sheddit has caught on it.
  function counts() {
    const result = { posts: 0, comments: 0, byFilter: {}, mode };
    for (const el of document.querySelectorAll(`[${CAUGHT_ATTR}]`)) {
      if (el.getAttribute(KIND_ATTR) === "comment") result.comments++;
      else result.posts++;
      for (const id of el.getAttribute(CAUGHT_ATTR).split(" ")) {
        result.byFilter[id] = (result.byFilter[id] || 0) + 1;
      }
    }
    return result;
  }

  shedditApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === "sheddit-counts") sendResponse(counts());
  });

  shedditApi.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && (changes.enabled || changes.mode)) applySettings();
  });

  // Sheddit starts before the page is drawn. Until the saved settings are
  // loaded and the page has finished parsing, posts and comments stay
  // invisible, so a caught post never flashes on screen before its overlay.
  // The guard lifts after 3 seconds at most, so a hiccup can't blank a page.
  const guard = document.createElement("style");
  guard.textContent = `${LAYOUTS.map((l) => l.post).join(", ")}, shreddit-comment, div.thing.comment
    { visibility: hidden !important; }`;
  document.documentElement.append(guard);
  const releaseGuard = () => guard.remove();
  setTimeout(releaseGuard, 3000);

  applySettings().then(() => {
    if (document.readyState !== "loading") {
      releaseGuard();
      return;
    }
    document.addEventListener("DOMContentLoaded", () => {
      scan();
      releaseGuard();
    }, { once: true });
  }, releaseGuard);
  // Reddit switches themes by changing classes or styles on <html> or
  // <body>, which the observer below ignores.
  const themeWatch = new MutationObserver(updateTheme);
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
  const watchBody = () => document.body &&
    themeWatch.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });
  if (!watchBody()) document.addEventListener("DOMContentLoaded", watchBody, { once: true });
  if (window.matchMedia) window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", updateTheme);

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["post-title"],
  });
})();
