// Minimal markdown for answers: paragraphs, bullet/numbered lists (with nesting), **bold**, `code`.
import React from "react";

function inline(text: string, key: string | number): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <React.Fragment key={key}>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") ? <strong key={i}>{p.slice(2, -2)}</strong>
          : p.startsWith("`") && p.endsWith("`") ? <code key={i} className="rounded bg-panel-2 px-1 text-[0.9em]">{p.slice(1, -1)}</code>
            : p,
      )}
    </React.Fragment>
  );
}

export function Inline({ text }: { text: string }) {
  return <>{inline(String(text ?? ""), 0)}</>;
}

export default function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let list: { ordered: boolean; items: { depth: number; text: string }[] } | null = null;
  const flush = () => {
    if (!list) return;
    const L = list;
    const Tag = L.ordered ? "ol" : "ul";
    out.push(
      <Tag key={out.length} className={`${L.ordered ? "list-decimal" : "list-disc"} my-1 space-y-0.5 pl-5`}>
        {L.items.map((it, i) => (
          <li key={i} style={{ marginLeft: it.depth * 16 }} className={it.depth ? "list-[circle]" : ""}>{inline(it.text, i)}</li>
        ))}
      </Tag>,
    );
    list = null;
  };
  for (const raw of lines) {
    const m = raw.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (m) {
      const ordered = /\d+\./.test(m[2]);
      if (!list || (list.ordered !== ordered && m[1].length === 0)) { flush(); list = { ordered, items: [] }; }
      list.items.push({ depth: Math.floor(m[1].length / 2), text: m[3] });
      continue;
    }
    flush();
    if (raw.trim()) out.push(<p key={out.length} className="my-1.5">{inline(raw, 0)}</p>);
  }
  flush();
  return <div className="text-[15px] leading-relaxed">{out}</div>;
}
