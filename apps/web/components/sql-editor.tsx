"use client";

import dynamic from "next/dynamic";

const Monaco = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => (
    <div className="grid h-full place-items-center bg-[#1b2430] text-sm text-[#d9e2dc]">Opening the editor…</div>
  ),
});

export function SqlEditor({
  value,
  onChange,
  height = "240px",
  onPasteChars,
  onType,
}: {
  value: string;
  onChange: (value: string) => void;
  height?: string;
  onPasteChars?: (chars: number) => void;
  onType?: () => void;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-navy/20" style={{ height }}>
      <Monaco
        height="100%"
        language="sql"
        theme="vs-dark"
        value={value}
        onChange={(next) => onChange(next ?? "")}
        onMount={(editor) => {
          editor.onDidPaste((event) => {
            const pasted = editor.getModel()?.getValueInRange(event.range) ?? "";
            onPasteChars?.(pasted.length);
          });
          editor.onKeyDown(() => onType?.());
        }}
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          scrollBeyondLastLine: false,
          wordWrap: "on",
          automaticLayout: true,
          tabSize: 2,
          padding: { top: 10 },
        }}
      />
    </div>
  );
}
