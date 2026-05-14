import { memo, useState } from "react";
import { ChevronRightIcon, FileIcon, FolderIcon, FolderOpenIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import type { FileTreeNode } from "./fileTreeModel";

/**
 * FileTree — recursive project file tree for V2 editor mode.
 *
 * Renders the nested structure from `buildFileTree`. Directories toggle
 * open/closed; files invoke `onSelectFile` with their workspace-relative
 * path. The active file is highlighted. Root-level directories start
 * expanded so the project's top-level structure is visible on open;
 * deeper directories start collapsed.
 *
 * Expansion state is local component state per row — deliberately not
 * lifted. React keys are stable paths, so collapse state survives
 * re-renders within a project; switching projects produces a fresh
 * `nodes` tree with different paths, so expansion naturally resets.
 */
export const FileTree = memo(function FileTree(props: {
  nodes: readonly FileTreeNode[];
  activePath: string | null;
  onSelectFile: (path: string) => void;
}) {
  return (
    <ul className="py-1 text-sm">
      {props.nodes.map((node) => (
        <FileTreeRow
          key={node.path}
          node={node}
          depth={0}
          activePath={props.activePath}
          onSelectFile={props.onSelectFile}
        />
      ))}
    </ul>
  );
});

const INDENT_PER_DEPTH_PX = 12;
const ROW_BASE_PADDING_PX = 8;

function FileTreeRow(props: {
  node: FileTreeNode;
  depth: number;
  activePath: string | null;
  onSelectFile: (path: string) => void;
}) {
  const { node, depth, activePath, onSelectFile } = props;
  const [expanded, setExpanded] = useState(depth === 0);

  if (node.kind === "directory") {
    return (
      <li>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex w-full items-center gap-1.5 py-0.5 pr-2 text-left text-muted-foreground hover:bg-accent hover:text-foreground"
          style={{ paddingLeft: `${depth * INDENT_PER_DEPTH_PX + ROW_BASE_PADDING_PX}px` }}
          aria-expanded={expanded}
        >
          <ChevronRightIcon
            className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")}
            aria-hidden
          />
          {expanded ? (
            <FolderOpenIcon className="size-3.5 shrink-0" aria-hidden />
          ) : (
            <FolderIcon className="size-3.5 shrink-0" aria-hidden />
          )}
          <span className="min-w-0 truncate">{node.name}</span>
        </button>
        {expanded && node.children.length > 0 ? (
          <ul>
            {node.children.map((child) => (
              <FileTreeRow
                key={child.path}
                node={child}
                depth={depth + 1}
                activePath={activePath}
                onSelectFile={onSelectFile}
              />
            ))}
          </ul>
        ) : null}
      </li>
    );
  }

  const isActive = node.path === activePath;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelectFile(node.path)}
        className={cn(
          "flex w-full items-center gap-1.5 py-0.5 pr-2 text-left",
          isActive
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
        // Files indent one extra step past directory rows so their icon
        // aligns under the folder icons, not under the chevron column.
        style={{
          paddingLeft: `${depth * INDENT_PER_DEPTH_PX + ROW_BASE_PADDING_PX + INDENT_PER_DEPTH_PX}px`,
        }}
        aria-current={isActive ? "true" : undefined}
      >
        <FileIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{node.name}</span>
      </button>
    </li>
  );
}
