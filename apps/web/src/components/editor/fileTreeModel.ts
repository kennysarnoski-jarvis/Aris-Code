import type { ProjectEntry } from "@t3tools/contracts";

/**
 * fileTree — pure logic for turning the flat `projects.listTree` entry
 * list into a nested tree the `FileTree` component can render.
 *
 * The server's workspace index already includes a `directory` entry for
 * every folder (git and filesystem index paths both synthesize ancestor
 * dirs), but `buildFileTree` doesn't rely on that — it splits each
 * path's segments and synthesizes any missing intermediate directory on
 * the fly. That keeps it robust to index gaps and to receiving entries
 * in any order.
 */

export interface FileTreeNode {
  /** Basename — the label rendered in the tree row. */
  readonly name: string;
  /** Full workspace-root-relative path — the stable React key + the
   *  value passed to `projects.readFile` when a file row is clicked. */
  readonly path: string;
  readonly kind: "file" | "directory";
  /** Empty for files. Mutated only during construction in `buildFileTree`. */
  readonly children: FileTreeNode[];
}

function basenameOf(path: string): string {
  const slashIndex = path.lastIndexOf("/");
  return slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
}

function parentOf(path: string): string | null {
  const slashIndex = path.lastIndexOf("/");
  return slashIndex >= 0 ? path.slice(0, slashIndex) : null;
}

/**
 * Build a sorted nested tree from the flat project index.
 *
 * Sort order per level: directories first, then alphabetical by name —
 * the conventional file-explorer ordering.
 */
export function buildFileTree(entries: readonly ProjectEntry[]): FileTreeNode[] {
  const roots: FileTreeNode[] = [];
  const nodeByPath = new Map<string, FileTreeNode>();

  // Ensure a directory node exists for `dirPath`, creating any missing
  // ancestor directories and linking the chain up to a root. Idempotent
  // — returns the existing node if already built.
  const ensureDir = (dirPath: string): FileTreeNode => {
    const existing = nodeByPath.get(dirPath);
    if (existing) {
      return existing;
    }
    const node: FileTreeNode = {
      name: basenameOf(dirPath),
      path: dirPath,
      kind: "directory",
      children: [],
    };
    nodeByPath.set(dirPath, node);
    const parent = parentOf(dirPath);
    if (parent === null) {
      roots.push(node);
    } else {
      ensureDir(parent).children.push(node);
    }
    return node;
  };

  for (const entry of entries) {
    // Skip duplicates defensively — the index shouldn't emit any, but a
    // double-push would corrupt the tree.
    if (nodeByPath.has(entry.path)) {
      continue;
    }
    if (entry.kind === "directory") {
      ensureDir(entry.path);
      continue;
    }
    const fileNode: FileTreeNode = {
      name: basenameOf(entry.path),
      path: entry.path,
      kind: "file",
      children: [],
    };
    nodeByPath.set(entry.path, fileNode);
    const parent = parentOf(entry.path);
    if (parent === null) {
      roots.push(fileNode);
    } else {
      ensureDir(parent).children.push(fileNode);
    }
  }

  const sortLevel = (nodes: FileTreeNode[]): void => {
    nodes.sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "directory" ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
    for (const node of nodes) {
      if (node.children.length > 0) {
        sortLevel(node.children);
      }
    }
  };
  sortLevel(roots);

  return roots;
}
