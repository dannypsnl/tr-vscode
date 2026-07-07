const path = require("path");
const fs = require("fs");

/**
 * Loads the list of cards for a project so mention search can offer them.
 *
 * Primary source is `_build/search.json` (produced by `raco tr build`) which
 * carries id / title / taxon / text — the same fields the website's
 * fullTextSearch.js indexes. If it isn't there yet (project never built), we
 * fall back to scanning the content directory and reading each `@title{...}`.
 *
 * Results are cached and invalidated by the search.json mtime, so a rebuild is
 * picked up automatically without restarting the extension.
 */
class CardStore {
  constructor() {
    // root -> { mtime, cards }
    this._cache = new Map();
  }

  invalidate(root) {
    if (root) this._cache.delete(root);
    else this._cache.clear();
  }

  /** @returns {{id:string,title:string,taxon:string,text:string}[]} */
  getCards(root) {
    if (!root) return [];
    const searchJson = path.join(root, "_build", "search.json");
    let mtime = 0;
    try {
      mtime = fs.statSync(searchJson).mtimeMs;
    } catch (_) {
      mtime = 0;
    }
    const cached = this._cache.get(root);
    if (cached && cached.mtime === mtime && mtime !== 0) {
      return cached.cards;
    }

    const cards = mtime ? loadFromSearchJson(searchJson) : scanContent(root);
    this._cache.set(root, { mtime, cards });
    return cards;
  }
}

function normalizeTitle(title) {
  if (Array.isArray(title)) return title.join("");
  if (typeof title === "string") return title;
  return "";
}

function loadFromSearchJson(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data
      .filter((d) => d && d.id)
      .map((d) => ({
        id: String(d.id),
        title: normalizeTitle(d.title),
        taxon: d.taxon ? String(d.taxon) : "",
        text: typeof d.text === "string" ? d.text : "",
      }));
  } catch (_) {
    return [];
  }
}

function scanContent(root) {
  const contentDir = path.join(root, "content");
  const cards = [];
  const stack = [contentDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.name.endsWith(".scrbl")) {
        cards.push({
          id: path.basename(e.name, ".scrbl"),
          title: readTitle(full),
          taxon: "",
          text: "",
        });
      }
    }
  }
  return cards;
}

function readTitle(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const m = raw.match(/@title(?:\[[^\]]*\])?\{([^}]*)\}/);
    return m ? m[1].trim() : "";
  } catch (_) {
    return "";
  }
}

module.exports = { CardStore };
