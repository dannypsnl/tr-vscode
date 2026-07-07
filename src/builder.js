const vscode = require("vscode");

/**
 * Coalesced background builder. New cards, edits, and saves all funnel through
 * `schedule(root)`: builds are debounced (so a burst of changes triggers one
 * build) and never overlap (a change arriving mid-build queues exactly one
 * rebuild afterwards). The preview refreshes whenever a build finishes, so a
 * freshly created or edited card renders without the user running anything.
 */
class BuildManager {
  constructor({ runRaco, store, preview, output }) {
    this.runRaco = runRaco;
    this.store = store;
    this.preview = preview;
    this.output = output;
    this._timers = new Map(); // root -> debounce timeout
    this._running = new Set(); // roots with a build in flight
    this._pending = new Set(); // roots that changed while building
    this._status = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left
    );
    this._status.text = "$(sync~spin) tr: building…";
  }

  dispose() {
    for (const t of this._timers.values()) clearTimeout(t);
    this._timers.clear();
    this._status.dispose();
  }

  /** Debounced request to (re)build `root`. */
  schedule(root, delay = 250) {
    if (!root) return;
    clearTimeout(this._timers.get(root));
    this._timers.set(
      root,
      setTimeout(() => {
        this._timers.delete(root);
        this._run(root);
      }, delay)
    );
  }

  /** Build `root` now (used by the explicit `tr: Build` command). */
  async build(root) {
    if (!root) return;
    clearTimeout(this._timers.get(root));
    this._timers.delete(root);
    await this._run(root);
  }

  async _run(root) {
    if (this._running.has(root)) {
      this._pending.add(root); // fold the change into a rebuild after this one
      return;
    }
    this._running.add(root);
    this._status.show();
    try {
      const { stderr } = await this.runRaco(root, ["tr", "build"]);
      if (stderr && stderr.trim()) this.output.appendLine(stderr.trim());
      this.store.invalidate(root);
      this.preview.refresh();
    } catch (e) {
      this.output.appendLine(`[build error] ${e.message}`);
      this.output.show(true);
      vscode.window.showErrorMessage(
        "tr build failed — see the tr-notes output channel."
      );
    } finally {
      this._running.delete(root);
      if (!this._running.size) this._status.hide();
      if (this._pending.delete(root)) this._run(root); // drain queued change
    }
  }
}

module.exports = { BuildManager };
