"use client";

import { cloneElement, createContext, isValidElement, useContext, useRef, useState, type ReactElement, type ReactNode } from "react";
import { glossaryEntry, glossarySpans, type GlossarySpan } from "@sim/engine/glossary";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export type GlossarySurface = "chat" | "ticket" | "kt" | "system" | "review";

const GlossaryLog = createContext<(term: string, surface: GlossarySurface) => void>(() => undefined);

export function GlossaryLogProvider({
  onView,
  children,
}: {
  onView: (term: string, surface: GlossarySurface) => void;
  children: ReactNode;
}) {
  return <GlossaryLog.Provider value={onView}>{children}</GlossaryLog.Provider>;
}

export function GlossaryText({ text, surface }: { text: string; surface: GlossarySurface }) {
  const spans = glossarySpans(text);
  return (
    <TooltipProvider delayDuration={150}>
      {spans.map((span, index) => (
        <Span key={index} span={span} surface={surface} />
      ))}
    </TooltipProvider>
  );
}

function Span({ span, surface }: { span: GlossarySpan; surface: GlossarySurface }) {
  if (span.type === "code") {
    return <code className="rounded bg-black/5 px-1 py-0.5 font-mono text-[0.92em]">{span.text}</code>;
  }
  if (span.type === "sql" || span.type === "text") {
    if (span.text === "\n") return <br />;
    return <span>{span.text}</span>;
  }
  return <Term id={span.id} text={span.text} surface={surface} />;
}

function Term({ id, text, surface }: { id: string; text: string; surface: GlossarySurface }) {
  const entry = glossaryEntry(id);
  const log = useContext(GlossaryLog);
  const logged = useRef(false);
  const [open, setOpen] = useState(false);
  if (!entry) return <span>{text}</span>;
  const note = () => {
    if (logged.current) return;
    logged.current = true;
    log(entry.id, surface);
  };
  return (
    <Tooltip
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) note();
      }}
    >
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="cursor-help underline decoration-dotted decoration-1 underline-offset-[3px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#464EB8]"
          aria-label={`${entry.term}: ${entry.definition}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setOpen(true);
            note();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            setOpen((current) => {
              const next = !current;
              if (next) note();
              return next;
            });
          }}
        >
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent className="z-[100] max-w-xs space-y-1 px-3 py-2 text-left leading-relaxed">
        <p className="font-semibold">{entry.term}</p>
        <p>{entry.definition}</p>
        {entry.example ? <p className="text-white/80">Example: {entry.example}</p> : null}
        {entry.table ? <p className="font-mono text-[11px] text-white/80">Table: {entry.table}</p> : null}
      </TooltipContent>
    </Tooltip>
  );
}

export function glossNodes(node: ReactNode, surface: GlossarySurface): ReactNode {
  if (typeof node === "string") return <GlossaryText text={node} surface={surface} />;
  if (typeof node === "number") return node;
  if (Array.isArray(node)) return node.map((child, index) => <span key={index}>{glossNodes(child, surface)}</span>);
  if (!isValidElement(node) || typeof node.type !== "string") return node;
  if (node.type === "button" || node.type === "a" || node.type === "input" || node.type === "textarea") return node;
  const props = node.props as { children?: ReactNode };
  if (props.children == null) return node;
  return cloneElement(node as ReactElement<{ children?: ReactNode }>, {}, glossNodes(props.children, surface));
}
