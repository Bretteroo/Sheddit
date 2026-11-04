// SPDX-License-Identifier: AGPL-3.0-only
// Sheddit toolbar popup: asks the active tab what Sheddit has caught on it
// and shows the totals, a per-filter breakdown and a link to the settings.

// Firefox for Android shows this page full-screen; the stylesheet adapts.
if (/Android/.test(navigator.userAgent)) document.documentElement.classList.add("android");

const $ = (id) => document.getElementById(id);
const plural = (n, word) => (n === 1 ? word : word + "s");

async function activeTabCounts() {
  try {
    const [tab] = await shedditApi.tabs.query({ active: true, currentWindow: true });
    if (!tab) return null;
    return (await shedditApi.tabs.sendMessage(tab.id, { type: "sheddit-counts" })) || null;
  } catch (e) {
    // No Sheddit content script in this tab: not a Reddit page.
    return null;
  }
}

function render(counts) {
  const onReddit = counts !== null;
  $("numbers").hidden = !onReddit;
  $("lead").hidden = !onReddit;
  $("note").hidden = onReddit && counts.posts + counts.comments > 0;

  if (!onReddit) {
    $("mode").textContent = "Not on Reddit";
    $("note").textContent = "Open a Reddit tab to see what Sheddit hides there.";
    $("breakdown").hidden = true;
    return;
  }

  $("mode").textContent = counts.mode === "veil" ? "Covering matches with an overlay" : "Removing matches";
  $("posts").textContent = counts.posts;
  $("posts-unit").textContent = plural(counts.posts, "post");
  $("comments").textContent = counts.comments;
  $("comments-unit").textContent = plural(counts.comments, "comment");
  $("note").textContent = "Nothing caught on this page yet.";

  const rows = SHEDDIT_FILTERS
    .filter((f) => counts.byFilter[f.id])
    .sort((a, b) => counts.byFilter[b.id] - counts.byFilter[a.id]);
  $("breakdown").hidden = rows.length === 0;
  $("filters").replaceChildren(...rows.map((f) => {
    const li = document.createElement("li");
    li.title = f.description;
    const name = document.createElement("span");
    name.textContent = f.title;
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = counts.byFilter[f.id];
    li.append(name, count);
    return li;
  }));
}

// History kept by background.js: { id: [firstCaughtTime, isComment, filters] }.
async function renderHistory() {
  const { history = {} } = await shedditApi.storage.local.get("history");
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const windows = { day: DAY, week: 7 * DAY, month: 30 * DAY };
  for (const [name, span] of Object.entries(windows)) {
    let posts = 0;
    let comments = 0;
    for (const [time, isComment] of Object.values(history)) {
      if (now - time > span) continue;
      if (isComment) comments++;
      else posts++;
    }
    $(`h-${name}-posts`).textContent = posts.toLocaleString();
    $(`h-${name}-comments`).textContent = comments.toLocaleString();
  }
}

async function refresh() {
  render(await activeTabCounts());
  await renderHistory();
}

$("settings").addEventListener("click", () => {
  shedditApi.runtime.openOptionsPage();
  window.close();
});

(async () => {
  const enabled = await shedditLoadEnabled();
  const on = SHEDDIT_FILTERS.filter((f) => enabled[f.id]).length;
  $("enabled").textContent = `${on} of ${SHEDDIT_FILTERS.length} filters on`;
  await refresh();
  // Infinite scroll keeps catching posts while the popup is open.
  setInterval(refresh, 1000);
})();
