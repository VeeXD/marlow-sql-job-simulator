"use client";

import { GlossaryText, type GlossarySurface } from "@/components/glossary-text";

export function Prose({
  text,
  className,
  surface = "chat",
}: {
  text: string;
  className?: string;
  surface?: GlossarySurface;
}) {
  return (
    <p className={className}>
      {text.split("\n").map((line, index) => (
        <span key={index} className="block">
          {line === "" ? "\u00a0" : <GlossaryText text={line} surface={surface} />}
        </span>
      ))}
    </p>
  );
}
