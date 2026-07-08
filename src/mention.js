const vscode = require("vscode");
const { projectRootFor } = require("./util");

// Cursor is in a card-*address* slot when the text before it is one of:
//   @mention{<addr>            @mention/hidden{<addr>
//   @mention["<addr>           @mention/hidden["<addr>
//   @transclude{<addr>
// `@transclude` takes a card address just like `@mention`, so it gets the same
// picker.
const TAG = /@(?:mention(?:\/hidden)?|transclude)/.source;
const ADDR_SLOT = new RegExp(`${TAG}\\s*(?:\\[\\s*"|\\{)([^"}\\]]*)$`);

// Detects the moment an address slot is *opened* by typing `{` or `"`, so we can
// pop the card picker (like vscode-violet pops its QuickPick on `\`).
const JUST_OPENED = new RegExp(`${TAG}(?:\\[\\s*"|\\{)$`);

const RECENTS_KEY = "tr.mentionRecents";
const RECENTS_MAX = 8;

/**
 * The card search, presented as an interactive vscode QuickPick (mirroring
 * vscode-violet's unicode picker): live fuzzy filtering over id / title /
 * taxon, recently-used cards floated to the top under a separator.
 *
 * @returns {Promise<{id:string,title:string,taxon:string}|undefined>}
 */
function pickCard(cards, recents) {
  return new Promise((resolve) => {
    let resolved = false;
    const qp = vscode.window.createQuickPick();
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.placeholder = "Search cards by id, title or taxon…";

    const toItem = (c) => ({
      label: c.id,
      description: c.taxon || "",
      detail: c.title || "",
      card: c,
    });

    const byId = new Map(cards.map((c) => [c.id, c]));
    const recentCards = recents
      .map((id) => byId.get(id))
      .filter(Boolean);
    const recentSet = new Set(recentCards.map((c) => c.id));
    const rest = cards.filter((c) => !recentSet.has(c.id));

    const flat = cards.map(toItem);
    const grouped = recentCards.length
      ? [
          { label: "recent", kind: vscode.QuickPickItemKind.Separator },
          ...recentCards.map(toItem),
          { label: "cards", kind: vscode.QuickPickItemKind.Separator },
          ...rest.map(toItem),
        ]
      : flat;

    qp.items = grouped;
    // Separators only make sense in the unfiltered view; drop them once the user
    // starts typing so fuzzy matching ranks across everything.
    qp.onDidChangeValue((v) => {
      qp.items = v.length === 0 ? grouped : flat;
    });
    qp.onDidAccept(() => {
      resolved = true;
      const sel = qp.selectedItems[0];
      qp.hide();
      resolve(sel && sel.card);
    });
    qp.onDidHide(() => {
      qp.dispose();
      if (!resolved) resolve(undefined);
    });
    qp.show();
  });
}

function getRecents(context) {
  const v = context.globalState.get(RECENTS_KEY);
  return Array.isArray(v) ? v : [];
}

async function pushRecent(context, id) {
  const next = [id, ...getRecents(context).filter((x) => x !== id)].slice(
    0,
    RECENTS_MAX
  );
  await context.globalState.update(RECENTS_KEY, next);
}

/**
 * Run the card search and return the chosen id, remembering it as recent.
 */
async function chooseCard(context, store, uri) {
  const cards = store.getCards(projectRootFor(uri));
  if (!cards.length) {
    vscode.window.showWarningMessage(
      "tr: no cards found. Run `tr: Build` first, or open a tr project."
    );
    return undefined;
  }
  const card = await pickCard(cards, getRecents(context));
  if (card) await pushRecent(context, card.id);
  return card ? card.id : undefined;
}

/**
 * Text-change listener: when the user types `{` / `"` right after `@mention`
 * (or `@mention/hidden`), open the picker and drop the chosen address into the
 * freshly-opened slot.
 */
function makeMentionTrigger(context, store) {
  let busy = false;
  return async function onChange(event) {
    if (busy) return;
    const doc = event.document;
    // Match on the file extension, not the language id: another extension may
    // own `.scrbl` with a different id, and the id isn't what we care about.
    if (!doc.uri.fsPath.endsWith(".scrbl")) return;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== doc.uri.toString()) return;

    // Find a change that just typed an opening `{` or `"`. We derive the slot
    // position from the change range (the editor's *selection* isn't updated to
    // the post-edit caret yet while this event fires).
    let slot;
    for (const c of event.contentChanges) {
      const idx = firstOpenerIndex(c.text);
      if (idx < 0) continue;
      const after = doc.offsetAt(c.range.start) + idx + 1;
      const pos = doc.positionAt(after);
      const prefix = doc.lineAt(pos.line).text.slice(0, pos.character);
      if (JUST_OPENED.test(prefix)) {
        slot = pos;
        break;
      }
    }
    if (!slot) return;

    busy = true;
    try {
      const id = await chooseCard(context, store, doc.uri);
      if (id) await editor.edit((b) => b.insert(slot, id));
    } finally {
      busy = false;
    }
  };
}

// Index of the first `{` or `"` in a just-typed chunk (auto-closing may deliver
// `{}` or `""`), or -1.
function firstOpenerIndex(text) {
  const b = text.indexOf("{");
  const q = text.indexOf('"');
  if (b < 0) return q;
  if (q < 0) return b;
  return Math.min(b, q);
}

/**
 * Command version: open the card search from anywhere. Inserts just the address
 * when the cursor already sits in a mention slot, otherwise a full
 * `@mention["addr"]`.
 */
async function insertMentionCommand(context, store) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const id = await chooseCard(context, store, editor.document.uri);
  if (!id) return;

  const pos = editor.selection.active;
  const prefix = editor.document.lineAt(pos.line).text.slice(0, pos.character);
  const inSlot = ADDR_SLOT.test(prefix);
  const text = inSlot ? id : `@mention["${id}"]`;
  await editor.edit((b) => b.replace(editor.selection, text));
}

module.exports = { makeMentionTrigger, insertMentionCommand, chooseCard };
