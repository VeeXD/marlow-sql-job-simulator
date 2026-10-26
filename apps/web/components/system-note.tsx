import type { ReactNode } from "react";

/** Sim and product notices. Kept visually apart from anything a coworker said. */
export function SystemNote({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-md border border-[#8A6D00] bg-[#FFF4CE] px-3 py-2 text-sm text-[#8A6D00] ${className}`}>
      <span className="mr-2 text-[10px] font-semibold uppercase tracking-wide">System</span>
      {children}
    </div>
  );
}
