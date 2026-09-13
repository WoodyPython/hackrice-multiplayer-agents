import { useMemo, useState } from "react";
import {
  ChevronRight,
  FileCheck2,
  FileText,
  Folder,
  FolderOpen,
  PencilRuler,
} from "lucide-react";
import type { ApprovedFile, DraftFile, Material } from "@app/contracts";
import { cn } from "../lib/utils";

/**
 * The workspace library as a folder tree.
 *
 * Files previously arrived as four side-by-side panels, which made three
 * unrelated kinds of thing look like four equal lists and gave no sense of
 * structure. Each kind is now a top-level folder, because that is a shape
 * people already know how to read.
 *
 * The three kinds genuinely are different, and the tree does not pretend
 * otherwise:
 *
 * - **Approved files** and **shared drafts** carry real repository paths
 *   (`documents/…`, `code/…`), so they nest into real folders.
 * - **Reference materials** are immutable uploads addressed by ID. They have a
 *   filename and no path at all, so they sit flat inside their own folder.
 *   Splicing them into `documents/` would imply they live in the repository
 *   and can be edited or applied, and neither is true.
 */

export type Entry =
  | { kind: "approved"; name: string; path: string; file: ApprovedFile }
  | { kind: "draft"; name: string; path: string; draft: DraftFile }
  | { kind: "material"; name: string; path: string; material: Material };

type Node =
  | { type: "folder"; name: string; key: string; children: Node[] }
  | { type: "file"; name: string; key: string; entry: Entry };

/** Folders before files, each alphabetical — the ordering every explorer uses. */
function sortNodes(nodes: Node[]): Node[] {
  return nodes
    .map((node) =>
      node.type === "folder" ? { ...node, children: sortNodes(node.children) } : node,
    )
    .sort((a, b) =>
      a.type === b.type
        ? a.name.localeCompare(b.name)
        : a.type === "folder"
          ? -1
          : 1,
    );
}

/** Nest `documents/a/b.md` into folders; a flat name becomes a single file. */
function insert(root: Node[], segments: string[], entry: Entry, prefix: string): void {
  const [head, ...rest] = segments;
  if (head === undefined) return;
  const key = `${prefix}/${head}`;
  if (rest.length === 0) {
    root.push({ type: "file", name: head, key, entry });
    return;
  }
  let folder = root.find(
    (node): node is Extract<Node, { type: "folder" }> =>
      node.type === "folder" && node.name === head,
  );
  if (!folder) {
    folder = { type: "folder", name: head, key, children: [] };
    root.push(folder);
  }
  insert(folder.children, rest, entry, key);
}

/**
 * `roots` are the category folders, always present and in the order given.
 *
 * An empty category still has to appear. The panels this replaced said "No
 * approved files yet", which tells you the category exists and is empty; a tree
 * that simply omits it says nothing, and a new workspace would show no
 * structure at all. Their order is meaningful too, so it is preserved rather
 * than sorted -- only their contents are sorted.
 */
export function buildTree(entries: Entry[], roots: readonly string[] = []): Node[] {
  const root: Node[] = roots.map((name) => ({
    type: "folder" as const,
    name,
    key: `/${name}`,
    children: [],
  }));
  for (const entry of entries) insert(root, entry.path.split("/"), entry, "");
  return root.map((node) =>
    node.type === "folder" ? { ...node, children: sortNodes(node.children) } : node,
  );
}

const ENTRY_ICON = {
  approved: FileCheck2,
  draft: PencilRuler,
  material: FileText,
} as const;

function Row({
  depth,
  children,
  onClick,
  selected,
  expanded,
  title,
}: {
  depth: number;
  children: React.ReactNode;
  onClick: () => void;
  selected?: boolean;
  expanded?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      // A folder row is a real disclosure control, so its state is announced
      // rather than being carried only by a rotated chevron.
      {...(expanded === undefined ? {} : { "aria-expanded": expanded })}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-[12.5px] transition-colors",
        selected
          ? "bg-navy-100 text-navy-900 dark:bg-navy-900/70 dark:text-navy-100"
          : "hover:bg-muted",
      )}
      style={{ paddingLeft: `${depth * 14 + 8}px` }}
    >
      {children}
    </button>
  );
}

function TreeNode({
  node,
  depth,
  selected,
  onSelect,
  openFolders,
  onToggle,
}: {
  node: Node;
  depth: number;
  selected: string | null;
  onSelect: (entry: Entry) => void;
  openFolders: Set<string>;
  onToggle: (key: string) => void;
}) {
  if (node.type === "file") {
    const Icon = ENTRY_ICON[node.entry.kind];
    return (
      <li>
        <Row
          depth={depth}
          // Compared against the entry's own path, not the node key: the key
          // carries a leading separator from tree construction and the caller
          // holds an Entry, so keying off `node.key` silently never matches.
          selected={selected === node.entry.path}
          onClick={() => onSelect(node.entry)}
          title={node.entry.path}
        >
          <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
            {node.name}
          </span>
        </Row>
      </li>
    );
  }
  const open = openFolders.has(node.key);
  const count = countFiles(node);
  return (
    <li>
      <Row depth={depth} expanded={open} onClick={() => onToggle(node.key)}>
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        {open ? (
          <FolderOpen aria-hidden="true" className="size-3.5 shrink-0 text-navy-600 dark:text-navy-300" />
        ) : (
          <Folder aria-hidden="true" className="size-3.5 shrink-0 text-navy-600 dark:text-navy-300" />
        )}
        <span className="min-w-0 flex-1 truncate font-medium">{node.name}</span>
        <span className="shrink-0 text-[10.5px] text-muted-foreground tabular-nums">
          {count}
        </span>
      </Row>
      {open && node.children.length === 0 && (
        <p
          className="py-1.5 text-[11.5px] text-muted-foreground italic"
          style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}
        >
          Nothing here yet
        </p>
      )}
      {open && node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <TreeNode
              key={child.key}
              node={child}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
              openFolders={openFolders}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function countFiles(node: Node): number {
  return node.type === "file"
    ? 1
    : node.children.reduce((total, child) => total + countFiles(child), 0);
}

export function FileTree({
  entries,
  roots,
  selected,
  onSelect,
}: {
  entries: Entry[];
  /** Category folders, always shown, in this order. */
  roots: readonly string[];
  selected: string | null;
  onSelect: (entry: Entry) => void;
}) {
  const tree = useMemo(() => buildTree(entries, roots), [entries, roots]);
  // Folders default open and are tracked by what has been *closed*. At this
  // scale a workspace holds tens of files, so starting collapsed would hide the
  // whole library behind several clicks on first visit; tracking closures also
  // means a newly uploaded file appears without its folder needing a click.
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const openFolders = useMemo(() => {
    const open = new Set<string>();
    const walk = (nodes: Node[]) => {
      for (const node of nodes) {
        if (node.type !== "folder") continue;
        if (!closed.has(node.key)) open.add(node.key);
        walk(node.children);
      }
    };
    walk(tree);
    return open;
  }, [tree, closed]);

  return (
    <ul className="space-y-px">
      {tree.map((node) => (
        <TreeNode
          key={node.key}
          node={node}
          depth={0}
          selected={selected}
          onSelect={onSelect}
          openFolders={openFolders}
          onToggle={(key) =>
            setClosed((current) => {
              const next = new Set(current);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            })
          }
        />
      ))}
    </ul>
  );
}
