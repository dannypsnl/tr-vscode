const vscode = require("vscode");
const { projectRootFor, findCardFile } = require("./util");
const { chooseCard } = require("./mention");

/**
 * Card search that *opens* the chosen card's `.scrbl` file, as opposed to
 * `tr.insertMention`, which drops the address into the current buffer. Reuses
 * the same QuickPick and recent-cards list as mention search, so a card you
 * just linked is one keystroke away from being opened.
 */
async function openCardCommand(context, store) {
  const uri = activeResource();
  const root = projectRootFor(uri);
  if (!root) {
    vscode.window.showErrorMessage(
      "tr: no tr project found (need a folder with a `content` directory)."
    );
    return;
  }

  const id = await chooseCard(context, store, uri);
  if (!id) return; // cancelled or no cards (chooseCard already warned)

  const file = findCardFile(root, id);
  if (!file) {
    vscode.window.showErrorMessage(
      `tr: could not find a .scrbl file for "${id}".`
    );
    return;
  }

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(doc);
}

function activeResource() {
  const e = vscode.window.activeTextEditor;
  return e ? e.document.uri : undefined;
}

module.exports = { openCardCommand };
