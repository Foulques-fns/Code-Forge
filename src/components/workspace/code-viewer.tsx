"use client";

import { useMemo } from "react";
import { Copy, Download } from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Hand-rolled, aesthetic syntax highlighting (regex tokenizer).      */
/*  Not a parser — a fast visual aid tuned to the CodeForge palette.   */
/* ------------------------------------------------------------------ */

interface Tok { text: string; cls: string }

const KW: Record<string, string[]> = {
  code: [
    "import", "export", "from", "default", "const", "let", "var", "function", "return", "if", "else", "for",
    "while", "do", "switch", "case", "break", "continue", "new", "class", "extends", "implements", "interface",
    "type", "enum", "async", "await", "try", "catch", "finally", "throw", "typeof", "instanceof", "of", "in",
    "null", "undefined", "true", "false", "this", "super", "yield", "static", "get", "set", "public", "private",
    "protected", "readonly", "abstract", "as", "satisfies", "keyof", "namespace", "declare", "module", "require",
    "def", "elif", "pass", "lambda", "None", "True", "False", "with", "global", "nonlocal", "raise", "assert",
    "fn", "let", "mut", "pub", "struct", "impl", "trait", "match", "use", "mod", "where", "func", "package",
    "go", "chan", "defer", "select", "range", "map", "var", "void", "int", "string", "bool", "float", "double",
    "char", "long", "short", "unsigned", "signed", "sizeof", "union", "typedef", "extern", "inline", "final",
    "namespace", "using", "echo", "foreach", "print", "include", "require_once", "fn",
  ],
  markup: ["doctype", "html", "head", "body", "div", "span", "script", "style", "link", "meta", "title"],
};

function tokenize(src: string, lang: string): Tok[] {
  const isMarkup = lang === "html" || lang === "xml" || lang === "svg";
  const isCss = lang === "css" || lang === "scss" || lang === "less";
  const isJson = lang === "json";
  const isMd = lang === "markdown";
  const kws = new Set(KW.code);

  if (isMd) {
    return src.split("\n").flatMap((line, i) => {
      const cls = /^#{1,6}\s/.test(line) ? "tok-kw" : /^\s*[-*]\s/.test(line) ? "tok-str" : /```/.test(line) ? "tok-punc" : "tok-plain";
      return [{ text: line, cls }, { text: "\n", cls: "tok-plain" }];
    });
  }

  const re = isMarkup
    ? /(<!--[\s\S]*?-->)|(&lt;\/?|<\/?)([a-zA-Z][\w-]*)|("[^"\n]*"|'[^'\n]*')|([{}()[\]]|\/?>|>)|([a-zA-Z-]+)(?==)/g
    : isCss
      ? /(\/\*[\s\S]*?\*\/)|("[^"\n]*"|'[^'\n]*')|([#.][\w-]+)|([\w-]+)(?=\s*:)|(:{1,2}[\w-]+)|([\d.]+(?:px|em|rem|%|vh|vw|s|ms|fr|deg)?)|([{}();,@>+~*]|!important)/g
      : isJson
        ? /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+\.?\d*(?:e[+-]?\d+)?)|(\btrue\b|\bfalse\b|\bnull\b)|([{}[\],])/g
        : /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(\b\d[\d_]*\.?\d*(?:e[+-]?\d+)?\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)|([{}()[\].,;:!?&|<>=+\-*/%@~^])/g;

  const toks: Tok[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const push = (text: string, cls: string) => { if (text) toks.push({ text, cls }); };

  while ((m = re.exec(src))) {
    if (m.index > last) push(src.slice(last, m.index), "tok-plain");
    if (isMarkup) {
      const [, com, , tag, str, punc, attr] = m;
      if (com) push(com, "tok-com");
      else if (tag) push(m[2] + tag, "tok-tag");
      else if (str) push(str, "tok-str");
      else if (punc) push(punc, "tok-punc");
      else if (attr) push(attr, "tok-attr");
    } else if (isCss) {
      const [, com, str, sel, prop, pseudo, num, punc] = m;
      if (com) push(com, "tok-com");
      else if (str) push(str, "tok-str");
      else if (sel) push(sel, "tok-fn");
      else if (prop) push(prop, "tok-prop");
      else if (pseudo) push(pseudo, "tok-type");
      else if (num) push(num, "tok-num");
      else if (punc) push(punc, "tok-punc");
    } else if (isJson) {
      const [, str, colon, num, kw, punc] = m;
      if (str) { push(str, colon ? "tok-key" : "tok-str"); if (colon) push(colon, "tok-punc"); }
      else if (num) push(num, "tok-num");
      else if (kw) push(kw, "tok-kw");
      else if (punc) push(punc, "tok-punc");
    } else {
      const [, com, str, num, fn, word, punc] = m;
      if (com) push(com, "tok-com");
      else if (str) push(str, "tok-str");
      else if (num) push(num, "tok-num");
      else if (fn) push(fn, "tok-fn");
      else if (word) {
        if (kws.has(word)) push(word, "tok-kw");
        else if (/^[A-Z]/.test(word)) push(word, "tok-type");
        else push(word, "tok-plain");
      } else if (punc) push(punc, "tok-punc");
    }
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < src.length) push(src.slice(last), "tok-plain");
  return toks;
}

export function CodeViewer({ path, content, language }: { path: string; content: string; language: string }) {
  const lines = useMemo(() => {
    const capped = content.length > 300_000 ? content.slice(0, 300_000) : content;
    return tokenize(capped, language);
  }, [content, language]);

  const lineNumbers = useMemo(() => content.slice(0, 300_000).split("\n").length, [content]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(content); } catch { /* clipboard unavailable */ }
  };
  const download = () => {
    const blob = new Blob([content], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = path.split("/").pop() ?? "file";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-[color:var(--line)] px-4 py-2.5">
        <div className="mono flex min-w-0 items-center gap-2 text-[12px] text-[color:var(--ink-2)]">
          <span className="truncate">{path}</span>
          <span className="hidden text-[color:var(--ink-3)] sm:inline">· {language}</span>
          <span className="text-[color:var(--ink-3)]">· {(content.length / 1024).toFixed(1)} Ko</span>
        </div>
        <div className="flex items-center gap-1">
          <button className="icon-btn" onClick={copy} title="Copier le contenu"><Copy size={14} /></button>
          <button className="icon-btn" onClick={download} title="Télécharger ce fichier"><Download size={14} /></button>
        </div>
      </div>
      <div className="code-scroll flex-1">
        <table className="code-table">
          <tbody>
            <tr>
              <td className="code-ln">{Array.from({ length: lineNumbers }, (_, i) => (<div key={i}>{i + 1}</div>))}</td>
              <td className="code-line">
                <pre className="m-0">
                  <code>
                    {lines.map((t, i) => (
                      <span key={i} className={t.cls}>{t.text}</span>
                    ))}
                  </code>
                </pre>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
