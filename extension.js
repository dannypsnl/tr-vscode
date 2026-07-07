const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const cp = require("child_process");

const { CardStore } = require("./src/cards");
const { PreviewManager } = require("./src/preview");
const { BuildManager } = require("./src/builder");
const { makeMentionTrigger, insertMentionCommand } = require("./src/mention");
const { projectRootFor, addrForDocument, racoPath } = require("./src/util");

let output;

function activate(context) {
  output = vscode.window.createOutputChannel("tr-notes");
  const store = new CardStore();
  const preview = new PreviewManager(context);
  const builder = new BuildManager({ runRaco, store, preview, output });
  context.subscriptions.push(output, builder, {
    dispose: () => preview.dispose(),
  });

  // --- Feature 1: @mention / @mention/hidden card search -----------------
  // Typing `{` after `@mention` opens a vscode QuickPick card search (like
  // vscode-violet's `\` picker), and the chosen address is dropped into the slot.
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(makeMentionTrigger(context, store)),
    vscode.commands.registerCommand("tr.insertMention", () =>
      insertMentionCommand(context, store)
    )
  );

  // --- Feature 2: new card ----------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand("tr.newCard", () =>
      newCard(store, preview, builder)
    )
  );

  // --- Feature 3: live preview ------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand("tr.showPreview", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !addrForDocument(editor.document.uri)) {
        vscode.window.showInformationMessage(
          "tr: open a .scrbl card to preview it."
        );
        return;
      }
      preview.show(editor.document);
    }),
    // Switching the active card updates the preview.
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && editor.document.languageId === "scribble") {
        preview.update(editor.document);
      }
    })
  );

  // --- Build integration -------------------------------------------------
  // A single coalesced background builder keeps `_build/` fresh: saving a card,
  // creating one, or changing a `.scrbl` on disk schedules a debounced rebuild
  // and refreshes the preview when it lands. `tr.buildOnSave` gates the
  // automatic rebuilds; the explicit command always builds.
  const autoBuild = (uri) => {
    const root = projectRootFor(uri);
    if (!root) return;
    const buildOnSave = vscode.workspace
      .getConfiguration("tr")
      .get("buildOnSave");
    if (buildOnSave) {
      builder.schedule(root);
    } else {
      store.invalidate(root);
      preview.refresh();
    }
  };

  // Watch every card on disk so external edits, new files, and deletions
  // (not just saves of open editors) trigger a rebuild.
  const watcher = vscode.workspace.createFileSystemWatcher(
    "**/content/**/*.scrbl"
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("tr.build", async () => {
      const root = projectRootFor(activeResource());
      if (!root) {
        vscode.window.showErrorMessage("tr: no tr project found.");
        return;
      }
      await builder.build(root);
    }),
    watcher,
    watcher.onDidChange(autoBuild),
    watcher.onDidCreate(autoBuild),
    watcher.onDidDelete(autoBuild),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId === "scribble") autoBuild(doc.uri);
    })
  );
}

function activeResource() {
  const e = vscode.window.activeTextEditor;
  return e ? e.document.uri : undefined;
}

// ---------------------------------------------------------------------------

async function newCard(store, preview, builder) {
  const root = projectRootFor(activeResource());
  if (!root) {
    vscode.window.showErrorMessage(
      "tr: no tr project found (need a folder with a `content` directory)."
    );
    return;
  }

  // New cards default to private: they live under `content/private/`, which the
  // build excludes from `release` output (but still renders in dev, so the
  // preview works). Pick "Public" to publish it under `content/` directly.
  const visibility = await vscode.window.showQuickPick(
    [
      {
        label: "$(lock) Private",
        description: "content/private — excluded from release builds",
        dir: path.join("content", "private"),
      },
      {
        label: "$(globe) Public",
        description: "content — published",
        dir: "content",
      },
    ],
    {
      title: "tr: new card",
      placeHolder: "Visibility (new cards are private by default)",
      ignoreFocusOut: true,
    }
  );
  if (!visibility) return; // cancelled (Esc)

  const prefix = await vscode.window.showInputBox({
    title: "tr: new card",
    prompt: "Address prefix (leave empty for none)",
    placeHolder: "e.g. note, guide, source-… — Enter for empty",
    ignoreFocusOut: true,
  });
  if (prefix === undefined) return; // cancelled (Esc). Empty string is allowed.

  let addr;
  try {
    const { stdout } = await runRaco(root, [
      "tr",
      "next",
      "--random",
      prefix,
    ]);
    addr = stdout.trim().split(/\r?\n/).pop().trim();
  } catch (e) {
    vscode.window.showErrorMessage(`tr next failed: ${e.message}`);
    return;
  }
  if (!addr) {
    vscode.window.showErrorMessage("tr next returned an empty address.");
    return;
  }

  const dir = path.join(root, visibility.dir);
  const file = path.join(dir, `${addr}.scrbl`);
  if (fs.existsSync(file)) {
    vscode.window.showErrorMessage(`tr: ${addr}.scrbl already exists.`);
    return;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, "@title{}\n", { flag: "wx" });
  } catch (e) {
    vscode.window.showErrorMessage(`tr: could not create card: ${e.message}`);
    return;
  }

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const editor = await vscode.window.showTextDocument(doc);
  // Drop the cursor inside @title{ | }.
  const caret = new vscode.Position(0, "@title{".length);
  editor.selection = new vscode.Selection(caret, caret);

  store.invalidate(root);
  if (preview.isOpen()) preview.update(doc);
  // Build the new card so the preview renders it (rather than "no build yet").
  builder.schedule(root);
}

// ---------------------------------------------------------------------------

function runRaco(root, args) {
  return new Promise((resolve, reject) => {
    cp.execFile(
      racoPath(),
      args,
      { cwd: root, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          err.message = (stderr || err.message).toString();
          reject(err);
        } else {
          resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
        }
      }
    );
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
