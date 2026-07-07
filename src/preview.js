const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const { projectRootFor, addrForDocument } = require("./util");

/**
 * Owns the single preview webview panel and keeps it in sync with the active
 * card editor.
 *
 * The website's build root is `_build/` — every asset the built page references
 * with an absolute path (`/style.css`, `/katex.min.css`, a card's rendered
 * `tex*.svg`, ...) lives under it. A webview can't load `/absolute` URLs, so we
 * rewrite each `href="/..."` / `src="/..."` that resolves to a real file under
 * `_build/` into a `webview.asWebviewUri(...)`. Math is server-side rendered
 * (KaTeX HTML + SVG), so the card body needs no JavaScript to display.
 */
class PreviewManager {
  constructor(context) {
    this.context = context;
    this.panel = undefined;
    this.currentRoot = undefined;
    this.currentAddr = undefined;
  }

  dispose() {
    if (this.panel) this.panel.dispose();
  }

  /** Open (or reveal) the preview and bind it to the given document. */
  show(document) {
    const column = vscode.ViewColumn.Beside;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "trPreview",
        "tr Preview",
        { viewColumn: column, preserveFocus: true },
        { enableScripts: true, retainContextWhenHidden: true }
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
    }
    this.update(document, { reveal: true });
  }

  isOpen() {
    return !!this.panel;
  }

  /** Refresh the preview for `document` (or clear when it isn't a card). */
  update(document, opts = {}) {
    if (!this.panel) return;
    if (opts.reveal) this.panel.reveal(vscode.ViewColumn.Beside, true);

    const uri = document && document.uri;
    const addr = addrForDocument(uri);
    if (!addr) {
      // Keep showing the last card when the user tabs to a non-card editor.
      return;
    }
    const root = projectRootFor(uri);
    if (!root) {
      this.panel.webview.html = message("Not inside a tr project.");
      return;
    }

    this.currentRoot = root;
    this.currentAddr = addr;

    const buildDir = path.join(root, "_build");
    const htmlFile = htmlFileFor(buildDir, addr);
    this.panel.title = `tr: ${addr}`;
    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(buildDir)],
    };

    if (!fs.existsSync(htmlFile)) {
      this.panel.webview.html = message(
        `No build for <code>${addr}</code> yet.<br/>Save the file (or run <b>tr: Build</b>) to render it.`
      );
      return;
    }
    this.panel.webview.html = this.renderHtml(buildDir, htmlFile);
  }

  /** Re-render whatever card is currently bound (used after a build). */
  refresh() {
    if (!this.panel || !this.currentRoot || !this.currentAddr) return;
    const buildDir = path.join(this.currentRoot, "_build");
    const htmlFile = htmlFileFor(buildDir, this.currentAddr);
    if (fs.existsSync(htmlFile)) {
      this.panel.webview.html = this.renderHtml(buildDir, htmlFile);
    }
  }

  renderHtml(buildDir, htmlFile) {
    let html;
    try {
      html = fs.readFileSync(htmlFile, "utf8");
    } catch (e) {
      return message(`Failed to read build output: ${e.message}`);
    }
    const webview = this.panel.webview;

    const rewrite = (match, attr, rel) => {
      // Strip query/hash, map the absolute web path onto a file in _build.
      const clean = rel.split(/[?#]/)[0];
      if (clean === "" || clean === "/") return match; // home link, leave it
      let filePath = path.join(buildDir, clean);
      try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) filePath = path.join(filePath, "index.html");
        else if (!stat.isFile()) return match;
      } catch (_) {
        return match; // internal card link with no asset on disk; leave as-is
      }
      const uri = webview.asWebviewUri(vscode.Uri.file(filePath));
      return `${attr}="${uri}"`;
    };

    html = html.replace(/\b(href|src)="(\/[^"]*)"/g, rewrite);

    // Relax the default webview CSP just enough for the (already-inlined) KaTeX
    // CSS and local scripts to load. Card content itself needs no scripting.
    const csp =
      `<meta http-equiv="Content-Security-Policy" content="` +
      `default-src 'none'; ` +
      `img-src ${webview.cspSource} data:; ` +
      `style-src ${webview.cspSource} 'unsafe-inline'; ` +
      `font-src ${webview.cspSource}; ` +
      `script-src ${webview.cspSource} 'unsafe-inline';">`;
    html = html.replace(/<head>/i, `<head>${csp}`);
    return html;
  }
}

/**
 * Where a card's rendered HTML lands under `_build/`. Ordinary cards render to
 * `_build/<addr>/index.html`; the special homepage card `index` renders to the
 * build root as `_build/index.html`.
 */
function htmlFileFor(buildDir, addr) {
  if (addr === "index") return path.join(buildDir, "index.html");
  return path.join(buildDir, addr, "index.html");
}

function message(body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; padding: 2rem;
           color: var(--vscode-foreground); line-height: 1.6; }
    code { background: var(--vscode-textCodeBlock-background); padding: 0 .3em; border-radius: 3px; }
  </style></head><body><p>${body}</p></body></html>`;
}

module.exports = { PreviewManager };
