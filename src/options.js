// SPDX-License-Identifier: AGPL-3.0-only
// Sheddit settings page: display mode plus one checkbox per filter, all
// saved immediately.

// Firefox for Android shows this page full-screen; the stylesheet adapts.
if (/Android/.test(navigator.userAgent)) document.documentElement.classList.add("android");

(async () => {
  const mode = await shedditLoadMode();
  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.checked = radio.value === mode;
    radio.addEventListener("change", async () => {
      if (radio.checked) await shedditApi.storage.sync.set({ mode: radio.value });
    });
  }

  const container = document.getElementById("filters");
  const enabled = await shedditLoadEnabled();
  const boxes = [];

  // "Enable all filters" sits above the list. It is checked only when every
  // filter is on.
  const allRow = filterRow("Enable all filters", "Absolute zen.", "icons/icon-48.png");
  allRow.row.classList.add("all");
  const allBox = allRow.box;
  // Each group's switch is on when all of its filters are, and shows a
  // dash when only some are.
  const groupSwitches = [];
  const syncAll = () => {
    const on = SHEDDIT_FILTERS.filter((f) => enabled[f.id]).length;
    allBox.checked = on === SHEDDIT_FILTERS.length;
    for (const { box, filters, count } of groupSwitches) {
      const n = filters.filter((f) => enabled[f.id]).length;
      box.checked = n === filters.length;
      box.indeterminate = n > 0 && n < filters.length;
      count.textContent = `${n} of ${filters.length} on`;
    }
  };
  allBox.addEventListener("change", async () => {
    for (const f of SHEDDIT_FILTERS) enabled[f.id] = allBox.checked;
    for (const { box, id } of boxes) box.checked = enabled[id];
    syncAll();
    if (allBox.checked) {
      // Decoration only: a problem here must never stop the setting saving.
      try {
        burst(allRow.row, allBox);
      } catch (e) {
        // Nothing to do; the filters are already on.
      }
    }
    await shedditApi.storage.sync.set({ enabled });
  });
  container.append(allRow.row);

  // The filters, under the group headings the website uses. Each group
  // starts folded away under its heading; the ones opened stay open the
  // next time the page is opened.
  const byId = new Map(SHEDDIT_FILTERS.map((f) => [f.id, f]));
  const grouped = new Set(SHEDDIT_GROUPS.flatMap((g) => g.ids));
  const groups = SHEDDIT_GROUPS.map((g) => ({ title: g.title, filters: g.ids.map((id) => byId.get(id)).filter(Boolean) }));
  const rest = SHEDDIT_FILTERS.filter((f) => !grouped.has(f.id));
  if (rest.length) groups.push({ title: "More", filters: rest });
  const open = new Set(await loadOpen());
  groups.forEach((group, i) => {
    const section = document.createElement("section");
    section.className = "group";
    const head = document.createElement("div");
    head.className = "group-head";
    const fold = document.createElement("button");
    fold.type = "button";
    fold.className = "fold";
    const listId = `group-${i}`;
    fold.setAttribute("aria-controls", listId);
    const name = document.createElement("span");
    name.className = "group-title";
    name.textContent = group.title;
    const count = document.createElement("span");
    count.className = "group-count";
    fold.append(name, count);
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.className = "switch";
    toggle.setAttribute("aria-label", `Turn on every filter in ${group.title}`);
    head.append(fold, toggle);
    const list = document.createElement("div");
    list.className = "group-list";
    list.id = listId;
    section.append(head, list);
    container.append(section);

    // Opening and folding slide the list open or shut, unless the reader
    // asks for reduced motion. A click partway through turns it around
    // from where it is.
    let sliding = null;
    const setFolded = (shut, animate = false) => {
      section.classList.toggle("folded", shut);
      fold.setAttribute("aria-expanded", String(!shut));
      const from = sliding ? list.getBoundingClientRect().height : null;
      if (sliding) sliding.cancel();
      sliding = null;
      if (!animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        list.hidden = shut;
        return;
      }
      list.hidden = false;
      const full = list.scrollHeight;
      const start = from !== null ? from : shut ? full : 0;
      sliding = list.animate(
        [{ height: `${start}px`, opacity: shut ? 1 : 0 }, { height: `${shut ? 0 : full}px`, opacity: shut ? 0 : 1 }],
        { duration: 280, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" });
      sliding.onfinish = () => {
        sliding = null;
        list.hidden = shut;
      };
    };
    setFolded(!open.has(group.title));
    fold.addEventListener("click", () => {
      const shut = !section.classList.contains("folded");
      setFolded(shut, true);
      if (shut) open.delete(group.title);
      else open.add(group.title);
      saveOpen([...open]);
    });

    groupSwitches.push({ box: toggle, filters: group.filters, count });
    toggle.addEventListener("change", async () => {
      for (const f of group.filters) enabled[f.id] = toggle.checked;
      for (const { box, id } of boxes) box.checked = enabled[id];
      syncAll();
      await shedditApi.storage.sync.set({ enabled });
    });

    for (const f of group.filters) {
      const { row, box } = filterRow(f.title, f.description, `images/filters/${f.id}.svg`);
      box.checked = enabled[f.id];
      box.addEventListener("change", async () => {
        enabled[f.id] = box.checked;
        syncAll();
        await shedditApi.storage.sync.set({ enabled });
      });
      boxes.push({ box, id: f.id });
      list.append(row);
    }
  });
  syncAll();
})();

// Which groups are open, kept on this device only.
async function loadOpen() {
  try {
    const { openGroups = [] } = await shedditApi.storage.local.get("openGroups");
    return openGroups;
  } catch (e) {
    return [];
  }
}

function saveOpen(titles) {
  try {
    Promise.resolve(shedditApi.storage.local.set({ openGroups: titles })).catch(() => {});
  } catch (e) {
    // Folding still works for this visit.
  }
}

// One checkbox row: an icon, then a title in bold with a description under
// it.
function filterRow(titleText, descText, iconSrc) {
  const row = document.createElement("label");
  row.className = "filter";
  const box = document.createElement("input");
  box.type = "checkbox";
  const icon = document.createElement("img");
  icon.className = "icon";
  icon.src = iconSrc;
  icon.alt = "";
  icon.width = 28;
  icon.height = 28;
  const info = document.createElement("div");
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = titleText;
  const desc = document.createElement("div");
  desc.className = "desc";
  desc.textContent = descText;
  info.append(title, desc);
  row.append(box, icon, info);
  return { row, box };
}

// A celebration for "Enable all filters": a golden glow swells from the
// checkbox, rays, and sparkles fly out across the row, a band of light sweeps
// over it and the title pops, then everything settles back down. Readers
// who ask for reduced motion get a short glow instead.
function burst(row, box) {
  const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  row.animate(
    [{ backgroundColor: "rgba(255, 214, 120, 0.7)" }, { backgroundColor: "rgba(255, 214, 120, 0)" }],
    { duration: calm ? 600 : 1800, easing: "ease-out" });
  if (calm) return;

  const layer = document.createElement("span");
  layer.className = "burst";
  const r = row.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  const x = b.left + b.width / 2 - r.left;
  const y = b.top + b.height / 2 - r.top;
  const piece = (cls, left = x, top = y) => {
    const el = document.createElement("span");
    el.className = cls;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    layer.append(el);
    return el;
  };

  piece("burst-glow").animate(
    [{ transform: "translate(-50%, -50%) scale(0)", opacity: 1 },
      { transform: "translate(-50%, -50%) scale(1)", opacity: 0.8, offset: 0.3 },
      { transform: "translate(-50%, -50%) scale(1.8)", opacity: 0 }],
    { duration: 1400, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)", fill: "both" });

  const shine = piece("burst-shine", 0, 0);
  shine.animate(
    [{ transform: "translateX(-60%)", opacity: 0 },
      { opacity: 1, offset: 0.2 },
      { transform: `translateX(${r.width}px)`, opacity: 0 }],
    { duration: 1100, delay: 120, easing: "cubic-bezier(0.3, 0.6, 0.4, 1)", fill: "both" });

  const rays = 16;
  for (let i = 0; i < rays; i++) {
    const angle = (360 / rays) * i;
    piece("burst-ray").animate(
      [{ transform: `rotate(${angle}deg) translateX(8px) scaleX(0.2)`, opacity: 1 },
        { transform: `rotate(${angle}deg) translateX(60px) scaleX(1)`, opacity: 1, offset: 0.35 },
        { transform: `rotate(${angle}deg) translateX(130px) scaleX(0.3)`, opacity: 0 }],
      { duration: 1000, delay: 30, easing: "cubic-bezier(0.15, 0.8, 0.3, 1)", fill: "both" });
  }

  for (let i = 0; i < 34; i++) {
    // Mostly to the right, since the checkbox sits at the row's left edge.
    const angle = (Math.random() - 0.5) * Math.PI * 1.5;
    const dist = 40 + Math.random() * Math.max(200, r.width - x);
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * Math.min(dist, 70);
    piece("burst-spark").animate(
      [{ transform: "translate(-50%, -50%) scale(1.3)", opacity: 1 },
        { transform: `translate(calc(-50% + ${dx * 0.7}px), calc(-50% + ${dy * 0.7}px)) scale(1)`, opacity: 1, offset: 0.5 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy + 16}px)) scale(0.2)`, opacity: 0 }],
      { duration: 1100 + Math.random() * 700, delay: 40 + Math.random() * 160, easing: "cubic-bezier(0.1, 0.7, 0.3, 1)", fill: "both" });
  }

  const title = row.querySelector(".title");
  title.animate(
    [{ transform: "scale(1)" }, { transform: "scale(1.12)", color: "#b07d0a", offset: 0.25 }, { transform: "scale(1)" }],
    { duration: 900, easing: "cubic-bezier(0.3, 1.6, 0.5, 1)" });

  row.append(layer);
  setTimeout(() => layer.remove(), 2100);
}
