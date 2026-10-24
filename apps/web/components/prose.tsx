import { renderInline } from "@/lib/api";

export function Prose({ text, className }: { text: string; className?: string }) {
  return (
    <p className={className}>
      {text.split("\n").map((line, index) => (
        <span key={index} className="block">
          {line === ""
            ? "\u00a0"
            : renderInline(line).map((part, partIndex) =>
                part.type === "code" ? (
                  <code key={partIndex} className="rounded bg-paper px-1 py-0.5 font-mono text-[0.92em]">
                    {part.value}
                  </code>
                ) : (
                  <span key={partIndex}>{part.value}</span>
                ),
              )}
        </span>
      ))}
    </p>
  );
}
