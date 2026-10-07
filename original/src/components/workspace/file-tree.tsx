"use client";

import { useMemo, useState } from "react";
import {
  Braces, ChevronDown, ChevronRight, FileCode2, FileJson2, FileText, FileType2, FolderClosed, FolderOpen, ImageIcon, Settings2,
} from "lucide-react";

export interface TreeFile { path: string; bytes: number }

interface Node {
  name: string;
  path: string;
  children: Node[];
  file?: TreeFile;
}

function buildTree(files: TreeFile[]): Node[] {
  const root: Node = { name: "", path: "", children: [] };
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = f.path.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const p = parts.slice(0, i + 1).join("/");
      let child = node.children.find((c) => c.name === part);
      if (!child) {
        child = { name: part, path: p, children: [], file: i === parts.length - 1 ? f : undefined };
        node.children.push(child);
      }
      node = child;
    });
  }
  const sortRec = (n: Node) => {
    n.children.sort((a, b) => (a.file ? 1 : 0) - (b.file ? 1 : 0) || a.name.localeCompare(b.name));
    n.children.forEach(sortRec);
    // Collapse single-child directory chains (src/components/... readability)
    n.children = n.children.map((c) => {
      while (!c.file && c.children.length === 1 && !c.children[0].file) {
        const only = c.children[0];
        c = { name: c.name + "/" + only.name, path: only.path, children: only.children };
      }
      return c;
    });
  };
  sortRec(root);
  return root.children;
}

function fileIcon(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["json", "lock", "yaml", "yml", "toml"].includes(ext)) return <FileJson2 size={13} className="shrink-0 text-[#f6c177]" />;
  if (["md", "txt"].includes(ext)) return <FileText size={13} className="shrink-0 text-[#8fc2ff]" />;
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"].includes(ext)) return <ImageIcon size={13} className="shrink-0 text-[#82e8c9]" aria-label={ext} />;
  if (["env", "gitignore", "config", "conf", "ini", "cfg", "dockerfile"].some((e) => path.toLowerCase().includes(e))) return <Settings2 size={13} className="shrink-0 text-[color:var(--ink-3)]" />;
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "c", "cpp", "h", "cs", "php", "rb", "swift", "kt", "vue", "svelte", "html", "css", "scss", "sql", "sh"].includes(ext))
    return <Braces size={13} className="shrink-0 text-[#a99bff]" />;
  return <FileType2 size={13} className="shrink-0 text-[color:var(--ink-2)]" />;
}

export function FileTree({
  files, selected, onSelect, newPaths,
}: {
  files: TreeFile[];
  selected: string | null;
  onSelect: (path: string) => void;
  newPaths?: Set<string>;
}) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (p: string) => {
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });
  };

  const renderNode = (node: Node, depth: number): React.ReactNode => {
    if (node.file) {
      return (
        <button
          key={node.path}
          className={`tree-item w-full text-left ${selected === node.path ? "active" : ""} ${newPaths?.has(node.path) ? "new-file" : ""}`}
          style={{ paddingLeft: 10 + depth * 14 }}
          onClick={() => onSelect(node.path)}
        >
          <FileCode2 size={0} className="hidden" />
          {fileIcon(node.path)}
          <span className="overflow-hidden text-ellipsis">{node.name}</span>
          <span className="ml-auto shrink-0 text-[10px] text-[color:var(--ink-3)]">
            {node.file.bytes > 1024 ? `${(node.file.bytes / 1024).toFixed(1)}k` : node.file.bytes}
          </span>
        </button>
      );
    }
    const isCollapsed = collapsed.has(node.path);
    return (
      <div key={node.path}>
        <button className="tree-item w-full text-left" style={{ paddingLeft: 10 + depth * 14 }} onClick={() => toggle(node.path)}>
          {isCollapsed ? <ChevronRight size={12} className="shrink-0 text-[color:var(--ink-3)]" /> : <ChevronDown size={12} className="shrink-0 text-[color:var(--ink-3)]" />}
          {isCollapsed ? <FolderClosed size={13} className="shrink-0 text-[#c4b5fd]" /> : <FolderOpen size={13} className="shrink-0 text-[#c4b5fd]" />}
          <span className="overflow-hidden text-ellipsis font-medium">{node.name}</span>
        </button>
        {!isCollapsed && node.children.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  return <div className="py-2">{tree.map((n) => renderNode(n, 0))}</div>;
}
