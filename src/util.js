const vscode = require("vscode");
const path = require("path");
const fs = require("fs");

/**
 * A tr project root is a workspace folder that has a `content` directory
 * (that's where cards live) and usually a `site.rkt`. We resolve the root for
 * a given resource so the extension keeps working in multi-root workspaces
 * (e.g. tr-guide + bib2tr side by side).
 */
function isTrRoot(dir) {
  try {
    return fs.statSync(path.join(dir, "content")).isDirectory();
  } catch (_) {
    return false;
  }
}

/** Resolve the tr project root for a resource, or the first workspace root. */
function projectRootFor(resource) {
  const folders = vscode.workspace.workspaceFolders || [];
  if (resource) {
    const folder = vscode.workspace.getWorkspaceFolder(resource);
    if (folder && isTrRoot(folder.uri.fsPath)) return folder.uri.fsPath;
    // Walk up from the file until we hit a tr root inside the workspace.
    let dir = path.dirname(resource.fsPath);
    const stop = folder ? folder.uri.fsPath : path.parse(dir).root;
    while (dir.startsWith(stop)) {
      if (isTrRoot(dir)) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const hit = folders.find((f) => isTrRoot(f.uri.fsPath));
  if (hit) return hit.uri.fsPath;
  return folders.length ? folders[0].uri.fsPath : undefined;
}

/** The card address is the file's basename without the `.scrbl` extension. */
function addrForDocument(uri) {
  if (!uri || !uri.fsPath.endsWith(".scrbl")) return undefined;
  return path.basename(uri.fsPath, ".scrbl");
}

function racoPath() {
  return (
    vscode.workspace.getConfiguration("tr").get("racoPath") || "raco"
  ).toString();
}

module.exports = { isTrRoot, projectRootFor, addrForDocument, racoPath };
