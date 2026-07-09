const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const { projectRootFor, addrForDocument, cardFileMap } = require("./util");

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
    // For back/forward in the preview history
    this.history = [];
    this.historyIndex = -1;
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
      // Clicking a card link in the preview opens that card's source for
      // editing (and re-points the preview at it) rather than navigating the
      // built page inside the webview.
      this.panel.webview.onDidReceiveMessage((msg) => {
        if (!msg) return;
        if (msg.type === "open" && msg.addr) this.openCard(msg.addr);
        else if (msg.type === "nav" && msg.dir) this.navigate(msg.dir);
      });
    }
    this.update(document, { reveal: true });
  }

  /** Open the `.scrbl` source of `addr` in the editor and preview it. */
  async openCard(addr) {
    if (!this.currentRoot) return;
    const file = cardFileMap(this.currentRoot).get(addr);
    if (!file) {
      vscode.window.showWarningMessage(
        `tr: no source file found for card "${addr}".`
      );
      return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
    });
    this.update(doc);
  }

  /**
   * Note that the preview now shows `addr`. A no-op when it's already the
   * current entry (re-render/rebuild, or the update triggered by our own
   * back/forward), so those don't pollute the trail. Any other addr starts a
   * new branch: forward history is dropped and the addr is appended.
   */
  recordHistory(addr) {
    if (this.history[this.historyIndex] === addr) return;
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(addr);
    this.historyIndex = this.history.length - 1;
  }

  /** Step back/forward through the visited-card trail. */
  navigate(dir) {
    const next = this.historyIndex + (dir === "back" ? -1 : 1);
    if (next < 0 || next >= this.history.length) return;
    this.historyIndex = next;
    // openCard → update → recordHistory, which no-ops since the target addr is
    // already the current entry. Scroll position is restored per-addr by the
    // in-page script, so returning to a card lands where you left it.
    this.openCard(this.history[next]);
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
    this.recordHistory(addr);

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
    this.panel.webview.html = this.renderHtml(buildDir, htmlFile, addr);
  }

  /** Re-render whatever card is currently bound (used after a build). */
  refresh() {
    if (!this.panel || !this.currentRoot || !this.currentAddr) return;
    const buildDir = path.join(this.currentRoot, "_build");
    const htmlFile = htmlFileFor(buildDir, this.currentAddr);
    if (fs.existsSync(htmlFile)) {
      this.panel.webview.html = this.renderHtml(
        buildDir,
        htmlFile,
        this.currentAddr
      );
    }
  }

  renderHtml(buildDir, htmlFile, addr) {
    let html;
    try {
      html = fs.readFileSync(htmlFile, "utf8");
    } catch (e) {
      return message(`Failed to read build output: ${e.message}`);
    }
    const webview = this.panel.webview;
    const root = path.dirname(buildDir);
    const cards = cardFileMap(root);

    const rewrite = (match, attr, rel) => {
      // Strip query/hash, map the absolute web path onto a file in _build.
      const clean = rel.split(/[?#]/)[0];
      const addr = clean.replace(/^\/+|\/+$/g, "");
      // A link to a card (including the home link `/` → the `index` card):
      // forward the click to the extension so it opens the source to edit.
      const cardAddr = addr === "" ? "index" : addr;
      if (cards.has(cardAddr)) {
        return `${attr}="#" data-tr-open="${cardAddr}"`;
      }
      if (clean === "" || clean === "/") return match; // home, no index card
      let filePath = path.join(buildDir, clean);
      let mtime;
      try {
        let stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          filePath = path.join(filePath, "index.html");
          stat = fs.statSync(filePath);
        }
        if (!stat.isFile()) return match;
        mtime = stat.mtimeMs;
      } catch (_) {
        return match; // internal link with no asset on disk; leave as-is
      }
      // The webview caches resources by URI, so a rebuilt asset that keeps its
      // filename (a card's `tex*.svg`, say) would serve stale from cache. Bust
      // it with the file's mtime so the URI changes whenever the file does.
      const uri = webview
        .asWebviewUri(vscode.Uri.file(filePath))
        .with({ query: `v=${Math.round(mtime)}` });
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

    // A floating back/forward toolbar for the visited-card trail. Disabled at
    // the ends; clicks post a `nav` message the extension turns into
    // history steps. Sits above the card content in the top-right corner.
    const canBack = this.historyIndex > 0;
    const canForward = this.historyIndex < this.history.length - 1;
    const navBar =
      `<style>` +
      `#tr-nav{position:fixed;top:8px;right:8px;z-index:2147483647;display:flex;gap:4px;}` +
      `#tr-nav button{cursor:pointer;width:26px;height:24px;font-size:13px;line-height:1;` +
      `border:1px solid var(--vscode-panel-border,transparent);border-radius:4px;opacity:.85;` +
      `background:var(--vscode-button-secondaryBackground,rgba(128,128,128,.2));` +
      `color:var(--vscode-button-secondaryForeground,var(--vscode-foreground));}` +
      `#tr-nav button:hover:not(:disabled){opacity:1;}` +
      `#tr-nav button:disabled{opacity:.35;cursor:default;}` +
      `</style>` +
      `<div id="tr-nav">` +
      `<button id="tr-back" title="Back"${canBack ? "" : " disabled"}>&#8592;</button>` +
      `<button id="tr-fwd" title="Forward"${canForward ? "" : " disabled"}>&#8594;</button>` +
      `</div>`;
    if (/<body[^>]*>/i.test(html)) {
      html = html.replace(/(<body[^>]*>)/i, `$1${navBar}`);
    } else {
      html = navBar + html;
    }

    // Forward clicks on card links (tagged with data-tr-open above) to the
    // extension, which opens the corresponding `.scrbl` source for editing.
    //
    // Setting `webview.html` reloads the page, so navigating between cards (or
    // rebuilding the current one) would otherwise reset the scroll back to the
    // top. Persist the scroll offset per addr in the webview's own state — it
    // survives html reloads within the panel — and restore it on load, so
    // returning to a card lands where you left it.
    const bridge =
      `<script>(function(){` +
      `const vs=acquireVsCodeApi();` +
      `const ADDR=${JSON.stringify(addr)};` +
      `function scrollMap(){const s=vs.getState();return (s&&s.scroll)||{};}` +
      `function restore(){const y=scrollMap()[ADDR];if(typeof y==='number')window.scrollTo(0,y);}` +
      `restore();window.addEventListener('load',restore);` +
      `let t;window.addEventListener('scroll',function(){` +
      `clearTimeout(t);t=setTimeout(function(){` +
      `const m=scrollMap();m[ADDR]=window.scrollY;` +
      `vs.setState(Object.assign({},vs.getState(),{scroll:m}));` +
      `},100);},{passive:true});` +
      `const back=document.getElementById('tr-back');` +
      `const fwd=document.getElementById('tr-fwd');` +
      `if(back)back.addEventListener('click',function(){vs.postMessage({type:'nav',dir:'back'});});` +
      `if(fwd)fwd.addEventListener('click',function(){vs.postMessage({type:'nav',dir:'forward'});});` +
      `document.addEventListener('click',function(e){` +
      `const a=e.target.closest&&e.target.closest('a[data-tr-open]');` +
      `if(!a)return;e.preventDefault();` +
      `vs.postMessage({type:'open',addr:a.getAttribute('data-tr-open')});` +
      `});})();</script>`;
    if (/<\/body>/i.test(html)) {
      html = html.replace(/<\/body>/i, `${bridge}</body>`);
    } else {
      html += bridge;
    }
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
