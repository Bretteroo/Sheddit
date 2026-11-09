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
  // Height of the Hide again tab on the post a thread page is about.
  const HIDE_TAB_HEIGHT = 30;
  // Height of the placeholder bar that replaces a hidden post or comment.
  const BAR_HEIGHT = { post: 64, comment: 44 };
  // On phone-width screens a comment bar's two lines of text wrap, so it
  // gets more room there.
  const NARROW = "(max-width: 480px)";
  const NARROW_COMMENT_BAR = 64;
  function barHeight(kind, target) {
    const own = target && parseFloat(target.style.getPropertyValue("--sheddit-bar"));
    if (own >= 0) return own;
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
  // Bumped whenever a post's animation starts or is canceled, so a stale
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

  // The height that keeps whatever follows `el` in place while `el` clips
  // its overflow. Clipping pulls a last child's bottom margin, which
  // otherwise sticks out below `el`, inside it, so that margin counts too.
  // Measured with a 1px probe placed right after `el`.
  function clippedHeight(el) {
    // A post nudged to center it is measured where its layout puts it,
    // like the probe.
    const nudge = el.style.getPropertyValue("top");
    const nudgePriority = el.style.getPropertyPriority("top");
    if (nudge) el.style.removeProperty("top");
    try {
      return probeHeight(el);
    } finally {
      if (nudge) el.style.setProperty("top", nudge, nudgePriority);
    }
  }

  function probeHeight(el) {
    const own = el.offsetHeight;
    const probe = document.createElement("div");
    probe.style.cssText = "display: block; height: 1px; margin: 0; padding: 0; border: 0;";
    const slot = el.getAttribute("slot");
    if (slot) probe.setAttribute("slot", slot);
    el.after(probe);
    const gap = probe.getBoundingClientRect().top - el.getBoundingClientRect().top -
      (parseFloat(getComputedStyle(el).marginBottom) || 0);
    probe.remove();
    // A layout that doesn't stack the probe below `el`, like a grid, gives a
    // number that means nothing; the plain height is the safe answer there.
    return gap >= own && gap - own <= 64 ? gap : own;
  }

  // The height a post takes when nothing holds it.
  function naturalHeight(el) {
    return clippedHeight(el);
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
    .sheddit-veiled-comment { height: var(--sheddit-bar, ${BAR_HEIGHT.comment}px) !important; }
    @media ${NARROW} {
      .sheddit-veiled-comment { height: var(--sheddit-bar, ${NARROW_COMMENT_BAR}px) !important; }
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
        linear-gradient(160deg, rgb(255, 250, 236), rgb(241, 234, 255));
      box-shadow:
        inset 0 0 0 1px rgba(214, 170, 60, 0.45),
        0 0 28px rgba(255, 196, 80, 0.22);
    }
    /* Cloud haze along the edge of a post growing back in after Peek. */
    .sheddit-sep-hidden { visibility: hidden !important; }
    /* A revealed comment's name line, the top row of its box. */
    .sheddit-revealed-head {
      background: rgba(255, 250, 235, 0.94) !important;
      border-top-left-radius: 14px;
      box-sizing: border-box !important;
    }
    html.sheddit-theme-dark .sheddit-revealed-head { background: rgba(44, 36, 22, 0.95) !important; }
    .sheddit-rehide-head .sheddit-rehide-tab { padding-top: 0; align-items: center; }
    /* The phone layout's collapse button sits in the avatar's column, on a
       white background of its own, inside a revealed comment's box. */
    .sheddit-reach-grid > svg,
    .sheddit-reach-grid > svg * { background-color: transparent !important; }
    /* A revealed post shows on the overlay's colors. The box's top and its
       cap below are flat in the colors the post's gradient starts and ends
       with, so the three read as one background. Reddit's own white behind
       a post is cleared for it. */
    .sheddit-revealed {
      background: linear-gradient(180deg, rgba(255, 250, 235, 0.94), rgba(249, 245, 252, 0.94)) !important;
    }
    /* An overlay that's open over a post, during Peek and Hide again, takes
       the revealed post's colors, so the two meet without a seam. Those
       colors are a layer under its contents that fades in and out, so the
       change never snaps. */
    .sheddit-veil-card { isolation: isolate; }
    .sheddit-veil-card::after {
      content: "";
      position: absolute;
      /* 1px in, so the card's border (an inset shadow) still shows. */
      inset: 1px;
      z-index: -1;
      border-radius: inherit;
      background: linear-gradient(180deg, rgb(255, 250, 236), rgb(249, 245, 252));
      opacity: 0;
      transition: opacity 280ms ease;
      pointer-events: none;
    }
    .sheddit-veil-card.sheddit-veil-open::after { opacity: 1; }
    html.sheddit-theme-dark .sheddit-veil-card::after {
      background: linear-gradient(180deg, rgb(44, 36, 22), rgb(36, 30, 36));
    }
    @media (prefers-reduced-motion: reduce) {
      .sheddit-veil-card::after { transition: none; }
    }
    /* A revealed post keeps its children's margins inside it, so its height
       is the same whether it's clipped while animating or not, and its box
       doesn't jump when the animation ends. */
    .sheddit-revealed {
      display: flow-root !important;
      /* Its added side padding stays inside its width; otherwise a post
         that's as wide as its column grows past it. */
      box-sizing: border-box !important;
    }
    .sheddit-revealed shreddit-post { background: transparent !important; }
    .sheddit-revealed-box .sheddit-rehide-tab {
      background: rgba(255, 250, 235, 0.94);
    }
    .sheddit-revealed-box ~ .sheddit-rehide-cap,
    .sheddit-revealed-row ~ .sheddit-rehide-cap {
      background: rgba(249, 245, 252, 0.94) !important;
    }
    /* A comment's text and its row of buttons share one gradient, laid
       over both: the text shows its top part, the row its bottom part. */
    .sheddit-revealed-row,
    .sheddit-revealed.sheddit-spans-row {
      background: linear-gradient(180deg, rgba(255, 250, 235, 0.94), rgba(249, 245, 252, 0.94))
        0 var(--sheddit-grad-y, 0px) / 100% var(--sheddit-grad-h, 100%) no-repeat !important;
      box-sizing: border-box;
    }
    html.sheddit-theme-dark .sheddit-revealed {
      background: linear-gradient(180deg, rgba(44, 36, 22, 0.95), rgba(36, 30, 36, 0.95)) !important;
    }
    html.sheddit-theme-dark .sheddit-revealed-box .sheddit-rehide-tab {
      background: rgba(44, 36, 22, 0.95);
    }
    html.sheddit-theme-dark .sheddit-revealed-box ~ .sheddit-rehide-cap,
    html.sheddit-theme-dark .sheddit-revealed-row ~ .sheddit-rehide-cap {
      background: rgba(36, 30, 36, 0.95) !important;
    }
    html.sheddit-theme-dark .sheddit-revealed-row,
    html.sheddit-theme-dark .sheddit-revealed.sheddit-spans-row {
      background: linear-gradient(180deg, rgba(44, 36, 22, 0.95), rgba(36, 30, 36, 0.95))
        0 var(--sheddit-grad-y, 0px) / 100% var(--sheddit-grad-h, 100%) no-repeat !important;
    }
    .sheddit-haze-holder {
      position: relative !important;
      display: block !important;
      height: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
    }
    .sheddit-haze-clip {
      position: absolute;
      overflow: hidden;
      pointer-events: none;
      z-index: 4;
    }
    .sheddit-haze {
      position: absolute;
      left: -10%;
      right: -10%;
      top: 0;
      background-repeat: repeat-x;
      background-size: auto 160%;
      /* Soft top and bottom, whatever part of the clouds is showing. */
      mask-image: linear-gradient(to bottom, transparent, #000 35%, #000 65%, transparent);
      opacity: 0;
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
    /* On comments and posts in lists, the bar takes no room: "Caught by"
       sits in the revealed post's own top padding, at the box's top-right,
       on the post's background, and the frame draws the box's whole
       outline. The box's top edge is exactly where the overlay's top edge
       was, so it stays put through Peek and Hide again. */
    .sheddit-rehide-wide { margin-top: 0; }
    .sheddit-rehide-wide .sheddit-rehide-tab {
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      z-index: 1;
      justify-content: flex-end;
      padding: 6px 14px 0 16px;
      background: none !important;
      pointer-events: none;
    }
    .sheddit-rehide-wide .sheddit-rehide-tab > * { pointer-events: auto; }
    .sheddit-rehide-wide .sheddit-rehide-tab::before { display: none; }
    .sheddit-revealed.sheddit-revealed-wide { border-top-left-radius: 14px !important; }
    /* Hide again on a comment: a tab standing on the box's top-right
       corner, up beside the commenter's name. It overlaps the box's top
       edge by 1px so the two read as one shape, and that corner of the box
       is square. */
    .sheddit-rehide-again {
      position: absolute;
      right: 0;
      bottom: calc(100% - 1px);
      z-index: 1;
      margin: 0;
      padding: 6px 14px 7px;
      border: 0;
      border-radius: 12px 12px 0 0;
      font: inherit;
      color: inherit;
      cursor: pointer;
      background:
        radial-gradient(ellipse 70% 140% at 50% -30%, rgba(255, 214, 120, 0.5), transparent 70%),
        rgb(255, 250, 235);
      box-shadow:
        inset 0 1px 0 rgba(214, 170, 60, 0.45),
        inset 1px 0 0 rgba(214, 170, 60, 0.45),
        inset -1px 0 0 rgba(214, 170, 60, 0.45);
    }
    /* Exactly as tall as the room it replaces, so revealing moves nothing. */
    .sheddit-rehide-stacked { height: ${HIDE_TAB_HEIGHT - 1}px; }
    .sheddit-rehide-stacked .sheddit-rehide-again {
      position: relative;
      right: auto;
      bottom: auto;
      height: ${HIDE_TAB_HEIGHT}px;
      box-sizing: border-box;
      margin: 0 0 -1px auto;
    }
    .sheddit-rehide-again:hover {
      background:
        radial-gradient(ellipse 70% 140% at 50% -30%, rgba(255, 214, 120, 0.8), transparent 75%),
        rgb(255, 246, 222);
    }
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
    /* Under Reddit's fixed header (z-index 3), so nothing Sheddit draws
       for a post shows over it while scrolling. */
    .sheddit-rehide { position: relative; z-index: 2; }
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
    /* Logged-in thread pages draw the open post's author line a second
       time, in Reddit's fixed header (#pdp-credit-bar), over an empty space
       at the top of the post. That copy isn't inside the post, so it's
       hidden while the post is covered and moved down by the Hide again
       tab's height while the post is revealed. Its avatar sets its own
       visibility, so the rule covers everything inside it too. */
    html.sheddit-pdp-covered #pdp-credit-bar,
    html.sheddit-pdp-covered #pdp-credit-bar * { visibility: hidden !important; }
    html.sheddit-pdp-shifted #pdp-credit-bar {
      translate: 0 var(--sheddit-pdp-shift, 0px) !important;
      clip-path: inset(var(--sheddit-pdp-clip, 0px) 0 0 0) !important;
      /* Its own white would sit on the revealed post's colors. */
      background: transparent !important;
    }
    /* Dark colors follow Reddit's own theme, not the system's: Sheddit sets
       this class when the page's background is dark (see updateTheme). */
    html.sheddit-theme-dark .sheddit-veil-card {
      color: #f3e2b3;
      background:
        radial-gradient(ellipse 60% 120% at 50% -20%, rgba(255, 196, 80, 0.3), transparent 70%),
        linear-gradient(160deg, rgb(44, 36, 22), rgb(28, 24, 48));
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
    html.sheddit-theme-dark .sheddit-rehide-again {
      background:
        radial-gradient(ellipse 70% 140% at 50% -30%, rgba(255, 196, 80, 0.28), transparent 70%),
        rgb(44, 36, 22);
    }
    html.sheddit-theme-dark .sheddit-rehide-again:hover {
      background:
        radial-gradient(ellipse 70% 140% at 50% -30%, rgba(255, 196, 80, 0.45), transparent 75%),
        rgb(52, 42, 26);
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
    explained = { line, panel, width: window.innerWidth };
  }

  document.addEventListener("pointerdown", (e) => {
    if (explained && !explained.panel.contains(e.target) && !explained.line.contains(e.target)) {
      closeExplain();
    }
  }, true);
  // Phones resize the viewport whenever the address bar slides away, so
  // only a change of width (like turning the phone) closes the panel.
  // The description closes when the screen's width changes. Its width is
  // read only when it opens: reading window.innerWidth while the page is
  // still loading makes Firefox lay the page out early, and Firefox for
  // Android decides at that first layout, for good, whether to enlarge
  // long blocks of text. Done before it has read the page's viewport tag,
  // it turns enlarging on, and comments come out in different sizes.
  window.addEventListener("resize", () => {
    if (explained && window.innerWidth !== explained.width) closeExplain();
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

  // Whether `target` is the open post whose author line Reddit draws in its
  // header (see the #pdp-credit-bar styles). The post keeps an empty
  // #slot-credit-bar where that line appears.
  function hasHeaderCopy(target) {
    return !!target.querySelector(":scope > #slot-credit-bar");
  }

  function coverHeaderCopy(target, covered) {
    if (hasHeaderCopy(target)) document.documentElement.classList.toggle("sheddit-pdp-covered", covered);
  }

  // Reddit's copy of the author line lives in its fixed header, lined up
  // with the post's empty slot only while the page is at the top. While
  // the post is revealed, Sheddit keeps the copy lined up with that slot,
  // wherever the post has moved it to and however far the page scrolls,
  // so it moves with the post instead of floating over it.
  let headerCopyTarget = null;
  function shiftHeaderCopy(target, px) {
    if (!hasHeaderCopy(target)) return;
    const root = document.documentElement;
    if (px > 0) {
      headerCopyTarget = target;
      root.classList.add("sheddit-pdp-shifted");
      alignHeaderCopy();
      followHeaderCopy();
    } else {
      headerCopyTarget = null;
      root.classList.remove("sheddit-pdp-shifted");
      root.style.removeProperty("--sheddit-pdp-shift");
      root.style.removeProperty("--sheddit-pdp-clip");
    }
  }

  function alignHeaderCopy() {
    const target = headerCopyTarget;
    const copy = document.getElementById("pdp-credit-bar");
    const slot = target && target.isConnected && target.querySelector(":scope > #slot-credit-bar");
    if (!copy || !slot) return;
    const root = document.documentElement;
    const current = parseFloat(root.style.getPropertyValue("--sheddit-pdp-shift")) || 0;
    const natural = copy.getBoundingClientRect().top - current;
    const top = slot.getBoundingClientRect().top;
    root.style.setProperty("--sheddit-pdp-shift", `${Math.round(top - natural)}px`);
    // The copy is drawn as part of the header, so any of it that has
    // scrolled up behind the header's bar is cut off, as the post is.
    const bar = copy.parentElement.getBoundingClientRect();
    const hidden = Math.max(0, Math.min(copy.offsetHeight, bar.top + bar.height - top));
    root.style.setProperty("--sheddit-pdp-clip", `${Math.round(hidden)}px`);
  }

  // Reddit's header slides in and out with an animation as the page
  // scrolls, carrying the copy with it, so the copy is realigned on every
  // frame until things have been still for a moment.
  let alignUntil = 0;
  function followHeaderCopy() {
    if (!headerCopyTarget) return;
    const running = alignUntil > performance.now();
    alignUntil = performance.now() + 700;
    if (running) return;
    const step = () => {
      if (!headerCopyTarget) return;
      alignHeaderCopy();
      if (performance.now() < alignUntil) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  window.addEventListener("scroll", followHeaderCopy, { passive: true });


  // Reddit swaps thread pages without reloading, so when the open post that
  // Sheddit covered or revealed leaves the page, its header copy goes back
  // to normal for the next thread.
  function releaseStaleHeaderCopy() {
    const root = document.documentElement;
    if (!root.classList.contains("sheddit-pdp-covered") && !root.classList.contains("sheddit-pdp-shifted")) return;
    const ours = document.querySelector(`[${HIDDEN_ATTR}] > #slot-credit-bar, [${REVEALED_ATTR}] > #slot-credit-bar`);
    if (ours) return;
    root.classList.remove("sheddit-pdp-covered", "sheddit-pdp-shifted");
    root.style.removeProperty("--sheddit-pdp-shift");
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

  // Feeds put a 1px <hr> between posts. The ones right above and below a
  // covered or revealed post are hidden, keeping their space, so the
  // overlay or frame isn't fenced in by gray lines. Sheddit's own pieces
  // between the post and a line are skipped over.
  const separators = new Map();
  // Feeds add posts, and the lines between them, as they load, so this
  // runs again on every scan to catch lines that arrived late.
  function hideSeparators(target) {
    // Every line between the post and the next real post on each side.
    // Sheddit's own pieces are passed over, and so are elements that take
    // no room, like an ad slot Reddit left empty, which leave two lines
    // back to back.
    const near = (step) => {
      const found = [];
      for (let el = target[step]; el; el = el[step]) {
        if (el.tagName === "HR") found.push(el);
        else if (!isOwnPiece(el) && el.getBoundingClientRect().height > 0) break;
      }
      return found;
    };
    const seps = [...near("previousElementSibling"), ...near("nextElementSibling")];
    for (const sep of seps) sep.classList.add("sheddit-sep-hidden");
    separators.set(target, seps);
  }

  // How far to move a covered post's overlay so it sits midway between
  // what's visible in the posts above and below it. The posts' own padding
  // isn't the same at their tops and bottoms, which shows once the post
  // between them is a short bar. Only done in feeds, where hidden lines
  // mark the neighbors.
  function centerBetweenNeighbors(target) {
    const seps = separators.get(target);
    if (!seps || !seps.length) return 0;
    const neighbor = (step) => {
      let el = target[step];
      while (el && (el.tagName === "HR" || isOwnPiece(el) || !el.getBoundingClientRect().height)) el = el[step];
      return el;
    };
    const prev = neighbor("previousElementSibling");
    const next = neighbor("nextElementSibling");
    if (!prev || !next) return 0;
    const r = target.getBoundingClientRect();
    const current = shifts.get(target) || 0;
    // Room kept above the post for its tab isn't part of the gap to even out.
    const room = tabRooms.has(target) ? HIDE_TAB_HEIGHT - 1 : 0;
    const t = { top: r.top - current - room, bottom: r.bottom - current };
    const bottom = contentEdge(prev, "bottom");
    const top = contentEdge(next, "top");
    if (bottom === null || top === null) return 0;
    // Reddit's own padding leaves the two gaps a few pixels apart at most.
    // A bigger difference means a neighbor hasn't finished loading, and
    // centering on it would push the overlay against the other one.
    const shift = ((top - t.bottom) - (t.top - bottom)) / 2;
    return Math.abs(shift) <= 8 ? Math.round(shift) : 0;
  }

  // The topmost or bottommost edge of what's visible in a post: its
  // smallest elements with a real size, leaving out the link Reddit lays
  // over a whole post. A covered post counts as its bar.
  function contentEdge(el, side) {
    const box = el.getBoundingClientRect();
    // A caught neighbor counts as its box, covered or revealed, so that
    // revealing it doesn't move this post: its top is the same either way,
    // and its bottom is the bottom of its cap, when it has one.
    if (el.hasAttribute(CAUGHT_ATTR) || el.querySelector(`[${CAUGHT_ATTR}]`)) {
      if (side === "top") return box.top;
      const cap = el.nextElementSibling;
      return cap && cap.classList.contains("sheddit-rehide-cap") ? cap.getBoundingClientRect().bottom : box.bottom;
    }
    let edge = null;
    // Reddit draws some rows, like a post's vote and comment buttons,
    // inside its elements' shadow trees.
    const nodes = [...el.querySelectorAll("*")];
    for (const host of [el, ...nodes]) if (host.shadowRoot) nodes.push(...host.shadowRoot.querySelectorAll("*"));
    for (const n of nodes) {
      if (n.childElementCount || n.tagName === "SLOT" || n.closest('[slot="full-post-link"]')) continue;
      const r = n.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom <= box.top || r.top >= box.bottom) continue;
      edge = side === "top" ? Math.min(edge ?? Infinity, r.top) : Math.max(edge ?? -Infinity, r.bottom);
    }
    return edge;
  }

  // A covered post in a feed, with everything Sheddit draws for it, is
  // drawn this many pixels up or down, to sit midway between its
  // neighbors. Only drawn there: the feed's layout doesn't change.
  const shifts = new Map();
  // Posts whose shift has been worked out at least once.
  const centered = new WeakSet();
  function offScreen(el) {
    const r = el.getBoundingClientRect();
    return r.bottom < 0 || r.top > window.innerHeight;
  }
  // The shift is a relative offset, not a translate: a translated post
  // becomes the box Reddit's fixed elements inside it are placed in, like
  // its menu's bottom sheet, which is three screens wide while closed and
  // makes the page scroll sideways once the post is revealed.
  const shiftPositioned = new WeakSet();
  function setShift(target, px) {
    if (px) {
      shifts.set(target, px);
      if (!shiftPositioned.has(target) && getComputedStyle(target).position === "static") {
        shiftPositioned.add(target);
        target.style.setProperty("position", "relative", "important");
      }
      target.style.setProperty("top", `${px}px`, "important");
    } else {
      shifts.delete(target);
      target.style.removeProperty("top");
      if (shiftPositioned.has(target)) {
        shiftPositioned.delete(target);
        target.style.removeProperty("position");
      }
    }
  }

  function showSeparators(target) {
    setShift(target, 0);
    centered.delete(target);
    for (const sep of separators.get(target) || []) sep.classList.remove("sheddit-sep-hidden");
    separators.delete(target);
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
  // (`leaving`) fade out at full size, then the post shrinks to the bar's
  // height as the tab's and cap's space closes, and last the bar fades in,
  // background and contents together.
  function veil(target, matches, kind, animated = false, leaving = []) {
    injectStyles();
    const ids = matches.map((f) => f.id).join(" ");
    target.setAttribute(HIDDEN_ATTR, ids);
    coverHeaderCopy(target, true);
    if (kind === "post") hideSeparators(target);
    // A post in a list right under another caught post has no free space
    // above it for its Hide again tab, since that post's overlay or box sits
    // there, so it keeps a gap the tab's height.
    if (!animated && (opensUnderHeader(target, kind) ||
        (kind === "post" && !onThreadPage() && caughtAbove(target)))) {
      keepTabRoom(target, true);
    }
    const current = startRun(target);
    if (getComputedStyle(target).display === "inline") target.classList.add("sheddit-block");
    // A comment whose overlay also covers its name line and row of buttons
    // shrinks its text by their height, so the overlay as a whole is as
    // tall as a covered post's.
    // Worked out once, while the comment is in its natural state; it stays
    // on the comment for Hide again.
    if (kind === "comment" && !target.style.getPropertyValue("--sheddit-bar")) {
      const parts = [commentHead(target, kind), commentRow(target, kind)].filter(Boolean);
      const taken = parts.reduce((sum, el) => sum + el.getBoundingClientRect().height, 0);
      if (taken) target.style.setProperty("--sheddit-bar", `${Math.max(0, Math.round(BAR_HEIGHT.post - taken))}px`);
    }
    const collapse = () => {
      target.classList.add("sheddit-veiled");
      if (kind === "comment") target.classList.add("sheddit-veiled-comment");
    };
    if (animated) {
      // The post fades out at its natural height (see the note on font
      // sizes in unveil); its height is fixed once it's invisible.
      setInline(target, { "box-sizing": "border-box", opacity: "1", "pointer-events": "none" });
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

    // With Hide again, the overlay starts at the top of the revealed box,
    // its Hide again bar, and keeps that top edge in place while the bar's
    // space closes.
    // During Peek the overlay keeps the same top edge too: the bar opens
    // below the overlay's top, and the overlay grows with it.
    const above = leaving.find((el) => el.classList.contains("sheddit-rehide"));
    const row = commentRow(target, kind);
    const head = commentHead(target, kind);
    const fit = () => {
      // The bar Hide again is closing, or the one a later Peek opened;
      // whichever is still in the page.
      const pieces = rehideBars.get(target);
      const bar = [above, pieces && pieces[0]].find((b) => b && b.isConnected);
      const top = bar && !bar.classList.contains("sheddit-rehide-stacked") ? bar : target;
      // The post's shift to center it is worked out while it's covered,
      // and kept while it's revealed, so the edges don't jump.
      // It's left alone while the post is on screen, where a change would
      // show as a jump; Reddit finishing the posts around it can change it.
      if (!bar && (!centered.has(target) || offScreen(target))) {
        setShift(target, centerBetweenNeighbors(target));
        centered.add(target);
      }
      const shift = shifts.get(target) || 0;
      for (const el of pieces || []) el.style.setProperty("translate", shift ? `0 ${shift}px` : "none", "important");
      // The post's offsetTop already counts its shift; the bar's doesn't.
      card.style.top = `${top.offsetTop - marker.offsetTop + (top === target ? 0 : shift)}px`;
      // A comment's overlay starts at its name line, which is inside it.
      if (head) card.style.top = `${head.getBoundingClientRect().top - marker.getBoundingClientRect().top}px`;
      card.style.left = `${target.offsetLeft - marker.offsetLeft}px`;
      card.style.width = `${target.offsetWidth}px`;
      // ...and reaches left over the avatar.
      if (head) {
        const h = head.getBoundingClientRect(), t = target.getBoundingClientRect();
        const left = Math.min(h.left, t.left);
        card.style.left = `${left - marker.getBoundingClientRect().left}px`;
        card.style.width = `${t.right - left}px`;
      }
      // It reaches down over the cap too, when there is one, so the box
      // never shows two bottom edges.
      // A comment's overlay covers its row of buttons too.
      const cap = pieces && pieces[1] && pieces[1].isConnected ? pieces[1] : null;
      const last = cap || row || target;
      const from = head || top;
      card.style.height = `${last.getBoundingClientRect().bottom - from.getBoundingClientRect().top}px`;
    };
    fit();
    const resize = new ResizeObserver(fit);
    resize.observe(target);
    if (row) resize.observe(row);
    if (head) resize.observe(head);
    if (above) resize.observe(above);
    veils.set(target, { marker, resize, kind, fit });

    if (animated) {
      (async () => {
        const ms = motionMs();
        // The overlay stays invisible while the post fades out and its space
        // closes, then fades in whole, background and contents together.
        let sinking = false;
        card.style.opacity = "0";
        for (const el of leaving) {
          el.style.pointerEvents = "none";
          // A comment's Hide again tab sinks into the box's top edge instead
          // of fading, so the rest of its bar fades piece by piece around it.
          const again = el.querySelector(":scope > .sheddit-rehide-again");
          const fading = again ? [...el.children].filter((c) => c !== again) : [el];
          if (again) {
            sinking = true;
            const h = again.offsetHeight;
            again.animate([
              { transform: "none", clipPath: "inset(0 0 0 0)" },
              { transform: `translateY(${h}px)`, clipPath: `inset(0 0 ${h}px 0)` },
            // Peek's bouncing rise played backward: a little hop up, then
            // down into the box.
            ], { duration: ms * 1.4, easing: "cubic-bezier(0.45, 0, 0.7, -0.6)", fill: "forwards" });
          }
          for (const f of fading) {
            // Faded-out elements keep opacity 0 once the fade ends; otherwise
            // they flash back for a frame before the timer below catches up.
            f.style.opacity = "0";
            fade(f, [{ opacity: 1 }, { opacity: 0 }]);
          }
        }
        setInline(target, { transition: `opacity ${ms}ms ease` });
        void target.offsetHeight;
        setInline(target, { opacity: "0" });
        // The box's top closes once a sinking Hide again tab is all the way
        // in; closing it clips everything above it.
        await pause(sinking ? ms * 1.4 : ms);
        if (!current()) {
          leaving.forEach((el) => el.remove());
          shiftHeaderCopy(target, 0);
          return unpad(target);
        }
        setInline(target, { transition: "none" });
        setInline(target, { height: `${naturalHeight(target)}px`, overflow: "hidden" });
        void target.offsetHeight;
        for (const el of leaving) if (!el.classList.contains("sheddit-rehide-stacked")) slide(el, "close");
        setInline(target, { transition: `height ${ms}ms ease` });
        setInline(target, { height: `${barHeight(kind, target)}px` });
        await pause(ms);
        if (leaving.some((el) => el.classList.contains("sheddit-rehide-stacked"))) keepTabRoom(target, true);
        leaving.forEach((el) => el.remove());
        shiftHeaderCopy(target, 0);
        unpad(target);
        if (!current()) return;
        collapse();
        restoreInline(target);
        fade(card, [{ opacity: 0 }, { opacity: 1 }]).then(() => card.style.removeProperty("opacity"), () => {});
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

  // The post a thread page is about. Reddit's fixed header sits right above
  // it, so its Hide again tab can't reach up past the post's top edge the
  // way it does elsewhere. Instead the post keeps a tab's height of room
  // above it while covered, and the tab stands in that room once revealed,
  // so nothing moves either way.
  const tabRooms = new Map();
  function opensUnderHeader(target, kind) {
    return kind === "post" && target.tagName === "SHREDDIT-POST" && onThreadPage();
  }

  function keepTabRoom(target, keep) {
    if (keep && !tabRooms.has(target)) {
      tabRooms.set(target, [target.style.getPropertyValue("margin-top"), target.style.getPropertyPriority("margin-top")]);
      target.style.setProperty("margin-top", `${HIDE_TAB_HEIGHT - 1}px`, "important");
    } else if (!keep && tabRooms.has(target)) {
      const [v, priority] = tabRooms.get(target);
      if (v) target.style.setProperty("margin-top", v, priority);
      else target.style.removeProperty("margin-top");
      tabRooms.delete(target);
    }
  }

  // Whether `el` is one of the elements Sheddit adds beside a post, as
  // opposed to a post Sheddit has only styled.
  function isOwnPiece(el) {
    return el.matches(".sheddit-veil, .sheddit-rehide, .sheddit-rehide-cap, .sheddit-haze-holder");
  }

  // Whether the nearest real post above `target` in a list is caught too.
  function caughtAbove(target) {
    for (let el = target.previousElementSibling; el; el = el.previousElementSibling) {
      if (el.tagName === "HR" || isOwnPiece(el) || !el.getBoundingClientRect().height) continue;
      return el.matches(`[${CAUGHT_ATTR}]`) || !!el.querySelector(`[${CAUGHT_ATTR}]`);
    }
    return false;
  }

  // The row with a comment's vote buttons, Reply, and "...", when `target`
  // is a comment's text. Wide layouts slot it right after the text; the
  // phone layout puts the text and the row in two blocks side by side in
  // the comment's grid.
  function commentRow(target, kind) {
    if (kind !== "comment") return null;
    const ROW = 'shreddit-comment-action-row, [slot="actionRow"]';
    const next = target.nextElementSibling;
    if (next && next.matches(ROW)) return next;
    const block = target.parentElement && target.parentElement.nextElementSibling;
    return block && block.querySelector(ROW) ? block : null;
  }

  // A comment's whole top row, avatar included, when it has a name line
  // above `target`: the phone layout's <summary>, or the name line itself.
  function commentHead(target, kind) {
    const meta = commentMeta(target, kind);
    if (!meta) return null;
    const summary = meta.closest("summary");
    return summary && summary.closest("shreddit-comment") === meta.closest("shreddit-comment") ? summary : meta;
  }

  // The line with a comment's author and age, when `target` is a comment's
  // text and that line sits above it.
  function commentMeta(target, kind) {
    if (kind !== "comment") return null;
    const comment = target.closest("shreddit-comment");
    if (!comment) return null;
    const meta = [...comment.querySelectorAll('[slot="commentMeta"]')]
      .find((m) => m.closest("shreddit-comment") === comment);
    return meta && meta.getBoundingClientRect().top < target.getBoundingClientRect().top ? meta : null;
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
    // On a comment, Hide again is a tab up beside the commenter's name; on
    // a post in a list, the same tab reaches up into the gap above the post.
    // The bar's own tab keeps only "Caught by". The post a thread page is
    // about sits right under Reddit's fixed header, where a tab reaching up
    // would hide behind it, so that post keeps Hide again in its tab.
    const meta = commentMeta(target, kind);
    // The post a thread page is about, and a post in a list right under
    // another caught one, have a tab's height of room kept above them; their
    // tab stands in it.
    const stacked = opensUnderHeader(target, kind) || tabRooms.has(target);
    if (meta || stacked || (kind === "post" && !onThreadPage())) {
      again.className = "sheddit-rehide-again";
      bar.append(again);
      // With only "Caught by" left in it, the tab spans the comment as the
      // top of its box, the filter names in the top-right corner.
      bar.classList.add("sheddit-rehide-wide");
      if (stacked) bar.classList.add("sheddit-rehide-stacked");
      // A comment's box takes in its name line: the box's top edge sits
      // above it, "Caught by" sits at its right end, and Hide again stands
      // on the box.
      if (meta) bar.classList.add("sheddit-rehide-head");
    } else {
      tab.append(again);
    }
    const frame = div("sheddit-rehide-frame");
    bar.append(frame);
    target.before(bar);
    // A comment's box closes below its row of buttons, which then sits
    // inside it, in the slot the row uses when it has one.
    const row = commentRow(target, kind);
    (row || target).after(cap);
    if (row && row.getAttribute("slot")) cap.setAttribute("slot", row.getAttribute("slot"));
    // In the phone layout's grid, the cap takes the row's column.
    if (row) cap.style.gridColumn = meta ? "1 / -1" : getComputedStyle(row).gridColumn;
    // The frame spans the gap between the bar and the cap, which is the
    // post's height; it follows the post when it grows or shrinks.
    const fitFrame = () => {
      if (!bar.isConnected) return frameWatch.disconnect();
      const barRect = bar.getBoundingClientRect();
      // With a name line in the box, the box starts at the name line.
      const headEl = bar.classList.contains("sheddit-rehide-head") ? commentHead(target, kind) : null;
      const headRect = headEl ? headEl.getBoundingClientRect() : null;
      const boxTop = headRect ? headRect.top : barRect.bottom;
      if (headRect) {
        frame.style.top = `${boxTop - barRect.top}px`;
        frame.style.left = `${Math.min(0, headRect.left - barRect.left)}px`;
        tab.style.top = `${headRect.top - barRect.top}px`;
        tab.style.height = `${headRect.height}px`;
        again.style.bottom = `${barRect.bottom - boxTop - 1}px`;
      }
      const gap = cap.getBoundingClientRect().top - boxTop;
      frame.style.height = `${Math.max(0, gap)}px`;
      // The shared gradient runs from the text's top to the row's bottom.
      const row = commentRow(target, kind);
      if (row) {
        const t = target.getBoundingClientRect(), r = row.getBoundingClientRect();
        const span = `${Math.round(r.bottom - t.top)}px`;
        target.classList.add("sheddit-spans-row");
        for (const el of [target, row]) el.style.setProperty("--sheddit-grad-h", span);
        row.style.setProperty("--sheddit-grad-y", `${Math.round(t.top - r.top)}px`);
      }
      // The top line reaches the tab's left edge, overlapping its 1px border;
      // in the box-top style it runs the whole width.
      const wide = bar.classList.contains("sheddit-rehide-wide");
      const shoulder = wide ? barRect.width : tab.getBoundingClientRect().left - barRect.left + 1;
      frame.style.setProperty("--shoulder", `${Math.max(0, shoulder)}px`);
      frame.style.setProperty("--corner", `${Math.min(14, Math.max(0, shoulder), Math.max(0, gap))}px`);
      // The post's content sits lower by the bar's full height, margins
      // included, plus the room made for "Caught by".
      const cs = getComputedStyle(bar);
      shiftHeaderCopy(target, barRect.height + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom) +
        (captionRoom.get(target) || 0));
    };
    const frameWatch = new ResizeObserver(fitFrame);
    frameWatch.observe(target);
    frameWatch.observe(bar);
    if (meta) frameWatch.observe(commentHead(target, kind));
    padInside(target, kind, bar);
    target.classList.add("sheddit-revealed");
    bar.classList.add("sheddit-revealed-box");
    fitFrame();
    const pieces = [bar, cap];
    rehideBars.set(target, pieces);
    // The bar and cap take no room until showRehideBar opens them, in the
    // same movement as the post's resize.
    for (const el of pieces) {
      el.style.opacity = "0";
      // The open post's bar takes over the room kept above the post, at
      // once, so the post doesn't move.
      if (el === bar && stacked) continue;
      el.style.setProperty("height", "0px");
      el.style.setProperty("margin-top", "0px");
      el.style.setProperty("margin-bottom", "0px");
      el.style.setProperty("overflow", "hidden");
    }
    if (stacked) keepTabRoom(target, false);
    // The overlay is still over the post then; it follows the post down.
    const v = veils.get(target);
    if (v) {
      v.resize.observe(bar);
      v.resize.observe(cap);
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

  // The bar opens above the post while its tab slides up out of the post's
  // top edge, the two passing each other halfway; the bar clips whatever
  // part of the tab is still below its bottom edge. The frame along the
  // post's sides, which the clip hides, and the cap below the post fade in
  // afterward.
  function showRehideBar(target) {
    const pieces = rehideBars.get(target);
    if (!pieces) return;
    const [bar, cap] = pieces;
    const tab = bar.querySelector(".sheddit-rehide-tab");
    const frame = bar.querySelector(".sheddit-rehide-frame");
    const again = bar.querySelector(".sheddit-rehide-again");
    for (const el of pieces) {
      for (const k of ["height", "margin-top", "margin-bottom", "overflow"]) el.style.removeProperty(k);
    }
    bar.style.removeProperty("opacity");
    frame.style.opacity = "0";
    if (again) again.style.opacity = "0";
    const h = tabHeight(tab);
    cap.style.height = `${capHeight(bar, h)}px`;
    const wide = bar.classList.contains("sheddit-rehide-wide");
    if (wide) {
      // In the box-top style "Caught by" just fades in, inside the box.
      tab.style.opacity = "0";
      fade(tab, [{ opacity: 0 }, { opacity: 1 }]).then(() => tab.style.removeProperty("opacity"), () => {});
    } else {
      tab.animate([{ transform: `translateY(${h}px)` }, { transform: "none" }],
        { duration: motionMs(), easing: "ease" });
    }
    slide(cap, "open");
    // A box-top bar takes no room, so there's nothing to open, and opening
    // it would clip "Caught by" below it.
    const opened = wide ? pause(motionMs()) : slide(bar, "open").finished;
    opened.then(() => {
      for (const el of [frame, cap]) {
        fade(el, [{ opacity: 0 }, { opacity: 1 }]).then(() => el.style.removeProperty("opacity"), () => {});
      }
      // A comment's Hide again tab rises out of the box's top edge: the
      // way it sinks into it on Hide again, played backward.
      if (again) {
        again.style.removeProperty("opacity");
        const ah = again.offsetHeight;
        again.animate([
          { transform: `translateY(${ah}px)`, clipPath: `inset(0 0 ${ah}px 0)` },
          { transform: "none", clipPath: "inset(0 0 0 0)" },
        // An overshooting curve gives it a little bounce at the top: it
        // rises about a tenth of its height past its place and settles.
        ], { duration: motionMs() * 1.4, easing: "cubic-bezier(0.3, 1.6, 0.55, 1)" });
      }
    }, () => {});
  }

  // While a post is revealed, padding keeps its text off the frame's side
  // edges. Reddit's own padding values are saved and put back afterwards.
  const pads = new Map();
  // Extra top padding a revealed post has for its "Caught by" line.
  const captionRoom = new Map();
  function padInside(target, kind, bar) {
    if (pads.has(target)) return;
    const saved = ["padding-left", "padding-right", "padding-top", "padding-bottom", "margin-left"].map((k) =>
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
    // A comment's top row, avatar and name line, is the top of its box,
    // and the box reaches left to the avatar's edge: the text and row get a
    // band of the box's colors beside them, over the avatar's column.
    const head = bar.classList.contains("sheddit-rehide-head") ? commentHead(target, kind) : null;
    const headSaved = head && ["padding-left", "padding-right", "padding-top"].map((k) =>
      [k, head.style.getPropertyValue(k), head.style.getPropertyPriority(k)]);
    let reach = 0;
    if (head) {
      const h = head.getBoundingClientRect();
      reach = Math.max(0, t.left - h.left);
      head.style.setProperty("padding-left", `${(parseFloat(getComputedStyle(head).paddingLeft) || 0) + space}px`, "important");
      head.style.setProperty("padding-right", `${Math.max(0, right - (t.right - h.right))}px`, "important");
      head.style.setProperty("padding-top", `${(parseFloat(getComputedStyle(head).paddingTop) || 0) + 6}px`, "important");
      head.classList.add("sheddit-revealed-head");
      // The text starts where the name does.
      const meta = commentMeta(target, kind);
      if (meta) {
        const nameLeft = meta.getBoundingClientRect().left + (parseFloat(getComputedStyle(meta).paddingLeft) || 0);
        target.style.setProperty("padding-left", `${Math.max(0, nameLeft - t.left)}px`, "important");
      }
      // The text block reaches left over the avatar's column, keeping its
      // text where it was, so its background fills that column.
      if (reach) {
        const pl = parseFloat(target.style.getPropertyValue("padding-left")) || 0;
        target.style.setProperty("margin-left", `${-reach}px`, "important");
        target.style.setProperty("padding-left", `${pl + reach}px`, "important");
      }
    }
    // In the box-top style, "Caught by" sits in the post's top padding,
    // unless it's on the name line.
    if (bar.classList.contains("sheddit-rehide-wide") && !head) {
      const caption = tabHeight(bar.querySelector(".sheddit-rehide-tab"));
      target.style.setProperty("padding-top", `${(parseFloat(cs.paddingTop) || 0) + caption + 4}px`, "important");
      captionRoom.set(target, caption + 4);
      target.classList.add("sheddit-revealed-wide");
    }
    // A comment's row of buttons sits in the box with it, on its colors and
    // with the same side padding.
    const row = commentRow(target, kind);
    const rowSaved = row && ["padding-left", "padding-right", "margin-left"].map((k) =>
      [k, row.style.getPropertyValue(k), row.style.getPropertyPriority(k)]);
    if (row) {
      const r = row.getBoundingClientRect();
      const textLeft = (parseFloat(target.style.getPropertyValue("padding-left")) || left) - reach;
      row.style.setProperty("padding-left", `${Math.max(0, textLeft - (r.left - t.left)) + reach}px`, "important");
      if (reach) {
        row.style.setProperty("margin-left", `${-reach}px`, "important");
        // The phone layout's collapse button sits in that column, on a
        // white background of its own.
        if (row.parentElement) row.parentElement.classList.add("sheddit-reach-grid");
      }
      row.style.setProperty("padding-right", `${Math.max(0, right - (t.right - r.right))}px`, "important");
      row.classList.add("sheddit-revealed-row");
    }
    pads.set(target, () => {
      if (head) {
        for (const [k, v, priority] of headSaved) {
          if (v) head.style.setProperty(k, v, priority);
          else head.style.removeProperty(k);
        }
        head.classList.remove("sheddit-revealed-head");
      }
      if (row) {
        for (const [k, v, priority] of rowSaved) {
          if (v) row.style.setProperty(k, v, priority);
          else row.style.removeProperty(k);
        }
        row.classList.remove("sheddit-revealed-row");
        for (const k of ["--sheddit-grad-h", "--sheddit-grad-y"]) row.style.removeProperty(k);
        target.style.removeProperty("--sheddit-grad-h");
        target.classList.remove("sheddit-spans-row");
        if (row.parentElement) row.parentElement.classList.remove("sheddit-reach-grid");
      }
      for (const [k, v, priority] of saved) {
        if (v) target.style.setProperty(k, v, priority);
        else target.style.removeProperty(k);
      }
      target.classList.remove("sheddit-revealed-wide");
      captionRoom.delete(target);
      if (blockify && !target.classList.contains("sheddit-veiled")) target.classList.remove("sheddit-block");
    });
  }

  // A revealed comment's frame runs from the bar above it to the bottom of
  // the cap below it, and the cap adds room under the text that nothing
  // matches above it. Padding on the shorter side evens the two gaps.
  // Measured with the comment at its natural height and the bar and cap
  // still closed, which leaves the distances between them unchanged.
  // The tab's open height: its padding plus its tallest child. Read from
  // the children because the tab itself is squashed while its bar is
  // closed.
  function tabHeight(tab) {
    const cs = getComputedStyle(tab);
    const inner = Math.max(0, ...[...tab.children].map((c) => c.offsetHeight));
    return inner + (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  }

  // The cap under a revealed post: a third of the tab's height, or a
  // quarter for the box-top style, which sits the post closer to its edges.
  function capHeight(bar, tabH) {
    return Math.round(tabH / (bar.classList.contains("sheddit-rehide-wide") ? 4 : 3));
  }

  function balanceSpacing(target) {
    const pieces = rehideBars.get(target);
    if (!pieces || !pads.has(target)) return;
    const [bar, cap] = pieces;
    const tab = bar.querySelector(".sheddit-rehide-tab");
    const range = document.createRange();
    range.selectNodeContents(target);
    const text = range.getBoundingClientRect();
    if (!text.height) return;
    let above = text.top - bar.getBoundingClientRect().bottom;
    // In the box-top style the gap above counts from the "Caught by" line,
    // which sits inside the top of the box.
    if (bar.classList.contains("sheddit-rehide-wide") && !bar.classList.contains("sheddit-rehide-head")) {
      above -= tabHeight(tab);
    }
    // A comment's row of buttons is the bottom of what's in the box.
    const row = commentRow(target, "comment");
    const bottom = row ? row.getBoundingClientRect().bottom - (parseFloat(getComputedStyle(row).paddingBottom) || 0) : text.bottom;
    const below = cap.getBoundingClientRect().top - bottom + capHeight(bar, tabHeight(tab));
    const extra = Math.round(below - above);
    if (!extra) return;
    const side = extra > 0 ? "padding-top" : "padding-bottom";
    const current = parseFloat(getComputedStyle(target).getPropertyValue(side)) || 0;
    target.style.setProperty(side, `${current + Math.abs(extra)}px`, "important");
  }

  function unpad(target) {
    target.classList.remove("sheddit-revealed");
    const restore = pads.get(target);
    if (!restore) return;
    pads.delete(target);
    restore();
  }

  function removeRehideBar(target) {
    unpad(target);
    if (rehideBars.has(target)) shiftHeaderCopy(target, 0);
    for (const el of rehideBars.get(target) || []) el.remove();
    rehideBars.delete(target);
  }

  // Remove a post's placeholder bar and show the post. With `animated`
  // (Peek), the bar's contents fade out, the bar then grows to the post's
  // full height while `onExpanded` runs alongside (Peek's tab rises), and
  // finally the bar fades away as the post fades in.
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
      coverHeaderCopy(target, false);
      // A revealed post keeps its frame, so the lines stay hidden with it.
      if (!target.hasAttribute(REVEALED_ATTR)) {
        showSeparators(target);
        keepTabRoom(target, false);
      }
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
      const start = target.offsetHeight;
      setInline(target, { "box-sizing": "border-box", height: `${start}px`,
        "min-height": "0", "max-height": "none", overflow: "hidden", opacity: "0",
        "pointer-events": "none" });
      target.classList.remove("sheddit-veiled", "sheddit-veiled-comment");
      // Peek adds the Hide again bar and its side padding right after this
      // call, which can rewrap the text, so the full height is measured a
      // microtask later, still before anything is drawn. It's measured
      // unclipped, as the post will finally sit.
      await Promise.resolve();
      if (!current()) return;
      setInline(target, { height: "auto", overflow: "visible" });
      if (v.kind === "comment") balanceSpacing(target);
      const full = naturalHeight(target);
      setInline(target, { height: `${start}px`, overflow: "hidden" });
      void target.offsetHeight;
      // The overlay's contents fade out first, leaving its background to
      // grow with the post. The overlay goes away whole at the end, so they
      // never need their opacity back.
      const card = v.marker.querySelector(".sheddit-veil-card");
      const contents = card ? [...card.children] : [];
      for (const el of contents) {
        el.style.opacity = "0";
        fade(el, [{ opacity: 1 }, { opacity: 0 }]);
      }
      if (contents.length) {
        await pause(ms);
        if (!current()) return;
      }
      if (card) card.classList.add("sheddit-veil-open");
      // In one movement the post takes its full height while, with Peek,
      // the Hide again bar opens above it and the overlay, its top edge
      // staying put, grows to cover both. Done one after the other, a post
      // shorter than the bar would shrink and then get pushed back down.
      setInline(target, { transition: `height ${ms}ms ease` });
      setInline(target, { height: `${full}px` });
      if (onExpanded) onExpanded();
      await pause(ms);
      if (!current()) return;
      const veilCard = v.marker.querySelector(".sheddit-veil-card");
      coverHeaderCopy(target, false);
      // Firefox for Android enlarges text in long blocks, but never inside a
      // box with a fixed height, so the post lets go of its height before it
      // shows. Otherwise its text would appear and then jump to a larger
      // size. The height it had already counted any margin that sticks out,
      // so nothing around it moves.
      // The post keeps the height it grew to while it's uncovered: Reddit
      // finishes laying out parts of a post a moment after they come into
      // view, which can change its real height by a few pixels. Once it's
      // uncovered, that difference is eased out (see settleHeight).
      setInline(target, { overflow: "visible", transition: "none", opacity: "1" });
      const revealMs = revealThroughHaze(target, veilCard);
      await pause(revealMs);
      if (!current()) return;
      await settleHeight(target, full, current);
      if (!current()) return;
      finish();
    })();
  }

  // The post grows in from its top edge: the overlay, which is the same
  // colors as the revealed post's box, is wiped away from the top down
  // behind a soft edge, uncovering the post already in place beneath it.
  // A band of cloud rolls slowly down the post meanwhile. The clouds blend
  // with what's under them (multiply on light pages, screen on dark ones),
  // so the text stays crisp and they read as lying beneath it. They keep
  // drifting a little after the post is fully shown, then remove
  // themselves. Returns how long the wipe takes.
  function revealThroughHaze(target, card) {
    const ms = motionMs();
    const revealMs = ms * 4.5;
    if (card) {
      // Transparent above the edge, opaque below it; sliding it down wipes
      // the card away from the top. It stays hidden after, until the
      // overlay is removed.
      const edge = "linear-gradient(to bottom, transparent 0%, transparent 42%, #000 58%, #000 100%)";
      card.animate([
        { maskImage: edge, maskSize: "100% 300%", maskRepeat: "no-repeat", maskPosition: "0 100%" },
        { maskImage: edge, maskSize: "100% 300%", maskRepeat: "no-repeat", maskPosition: "0 0%" },
      ], { duration: revealMs, easing: "cubic-bezier(0.4, 0, 0.3, 1)", fill: "forwards" });
    }
    if (!ms) return 0;
    const hazeMs = ms * 7.5;
    let h = target.offsetHeight;
    const band0 = () => Math.min(110, Math.max(60, h * 0.6));
    // A zero-height holder right before the post, outside the overlay's
    // layer, so the clouds blend with the post itself.
    const holder = div("sheddit-haze-holder");
    const slot = target.getAttribute("slot");
    if (slot) holder.setAttribute("slot", slot);
    target.before(holder);
    // The clouds cover the whole box below its top row: a comment's text,
    // its row of buttons, and the avatar's column beside them.
    const t = target.getBoundingClientRect();
    const o = holder.getBoundingClientRect();
    const head = commentHead(target, "comment");
    const row = commentRow(target, "comment");
    const left = head ? Math.min(t.left, head.getBoundingClientRect().left) : t.left;
    const bottom = row ? row.getBoundingClientRect().bottom : t.bottom;
    const clip = div("sheddit-haze-clip");
    clip.style.top = `${t.top - o.top}px`;
    clip.style.left = `${left - o.left}px`;
    clip.style.width = `${t.right - left}px`;
    clip.style.height = `${bottom - t.top}px`;
    h = bottom - t.top;
    const band = band0();
    const dark = document.documentElement.classList.contains("sheddit-theme-dark");
    clip.style.mixBlendMode = dark ? "screen" : "multiply";
    const haze = div("sheddit-haze");
    haze.style.backgroundImage =
      `url("${shedditApi.runtime.getURL(`images/haze-${dark ? "dark" : "light"}.webp`)}")`;
    haze.style.height = `${band}px`;
    clip.append(haze);
    holder.append(clip);
    // The band starts just above the post and rolls to its bottom, its
    // texture sliding down inside it as it goes.
    haze.animate([
      { transform: `translateY(${-band / 2}px)`, backgroundPositionY: "0%" },
      { transform: `translateY(${h - band / 2}px)`, backgroundPositionY: "100%" },
    ], { duration: hazeMs, easing: "cubic-bezier(0.25, 0.1, 0.4, 1)", fill: "forwards" });
    haze.animate([
      { opacity: 0 }, { opacity: 0.85, offset: 0.15 }, { opacity: 0.7, offset: 0.6 }, { opacity: 0 },
    ], { duration: hazeMs, fill: "forwards" }).finished.then(() => holder.remove(), () => holder.remove());
    return revealMs;
  }

  // Let a post that was held at `held` pixels take its own height, easing
  // into it if Reddit has changed the post's size since it was measured.
  async function settleHeight(target, held, current) {
    setInline(target, { transition: "none" });
    setInline(target, { height: "auto" });
    const settled = naturalHeight(target);
    setInline(target, { height: `${held}px` });
    void target.offsetHeight;
    if (Math.abs(settled - held) >= 1) {
      const ms = Math.round(motionMs() / 2);
      setInline(target, { transition: `height ${ms}ms ease` });
      setInline(target, { height: `${settled}px` });
      await pause(ms);
      if (!current()) return;
    }
    setInline(target, { transition: "none" });
    setInline(target, { height: "auto" });
  }

  function unhideAll() {
    for (const el of document.querySelectorAll(`[${HIDDEN_ATTR}], [${REVEALED_ATTR}], [${CAUGHT_ATTR}]`)) {
      unveil(el);
      showSeparators(el);
      keepTabRoom(el, false);
      el.removeAttribute(HIDDEN_ATTR);
      el.removeAttribute(REVEALED_ATTR);
      el.removeAttribute(CAUGHT_ATTR);
      el.removeAttribute(KIND_ATTR);
      el.style.removeProperty("display");
    }
  }

  function scan() {
    updateTheme();
    // Covered posts in feeds recenter as the posts and lines around them
    // load in.
    for (const [target, v] of veils) {
      if (v.kind !== "post" || !separators.has(target)) continue;
      hideSeparators(target);
      v.fit();
    }
    releaseStaleHeaderCopy();
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
