// SPDX-License-Identifier: AGPL-3.0-only
// Sheddit background script: keeps the history of caught posts and comments
// that the toolbar popup shows for the last 24 hours, 7 days and 30 days.
//
// The history lives in storage.local under "history", as
//   { [itemId]: [firstCaughtTime, isComment ? 1 : 0, [filterIds...]] }
// Each item is counted once, the first time it is caught, and entries older
// than 30 days are dropped. Only ids, times and filter ids are kept, never
// the text of a post or comment.

const api = typeof browser !== "undefined" ? browser : chrome;
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

// Item ids come from Reddit's page markup, so they are checked before they
// are stored: ids are short strings, filter ids look like Sheddit's own, and
// the history never grows past MAX_ENTRIES (the oldest are dropped first).
const MAX_ID_LENGTH = 120;
const MAX_ITEMS_PER_MESSAGE = 500;
const MAX_FILTERS_PER_ITEM = 32;
const MAX_ENTRIES = 50000;
const FILTER_ID = /^[a-z0-9-]{1,40}$/;

// Messages can arrive from several tabs at once; handling them one at a
// time keeps one write from overwriting another.
let queue = Promise.resolve();

api.runtime.onMessage.addListener((message, sender) => {
  if (sender && sender.id && sender.id !== api.runtime.id) return;
  if (message && message.type === "sheddit-caught" && Array.isArray(message.items)) {
    const items = message.items.slice(0, MAX_ITEMS_PER_MESSAGE);
    queue = queue.then(() => record(items)).catch(() => {});
  }
});

function clean(item) {
  if (!item || typeof item.id !== "string" || !item.id || item.id.length > MAX_ID_LENGTH) return null;
  // A key of "__proto__" would replace the history object's prototype.
  if (item.id === "__proto__") return null;
  const filters = Array.isArray(item.filters)
    ? item.filters.filter((f) => typeof f === "string" && FILTER_ID.test(f)).slice(0, MAX_FILTERS_PER_ITEM)
    : [];
  return { id: item.id, comment: item.kind === "comment" ? 1 : 0, filters };
}

async function record(items) {
  const { history = {} } = await api.storage.local.get("history");
  const now = Date.now();
  for (const raw of items) {
    const item = clean(raw);
    if (!item || Object.prototype.hasOwnProperty.call(history, item.id)) continue;
    history[item.id] = [now, item.comment, item.filters];
  }
  for (const [id, entry] of Object.entries(history)) {
    if (!Array.isArray(entry) || now - entry[0] > KEEP_MS) delete history[id];
  }
  const ids = Object.keys(history);
  if (ids.length > MAX_ENTRIES) {
    ids.sort((a, b) => history[a][0] - history[b][0]);
    for (const id of ids.slice(0, ids.length - MAX_ENTRIES)) delete history[id];
  }
  await api.storage.local.set({ history });
}
