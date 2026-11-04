"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export type TourStep = {
  id: string;
  title: string;
  body: string;
  target?: string;
};

export const SETUP_STEPS: TourStep[] = [
  {
    id: "setup-name",
    target: "setup-name",
    title: "Your name",
    body: "This is the name your teammates will use. It shows up in chat and on the offer.",
  },
  {
    id: "setup-difficulty",
    target: "setup-difficulty",
    title: "Guided or Standard",
    body: "Guided adds plain-language notes and turns this tour on. Standard is the same job with quieter check-ins. The contract for done does not change.",
  },
  {
    id: "setup-consent",
    target: "setup-consent",
    title: "Practice-mode notice",
    body: "The desk records queries, messages, and timings so you can look back. It is not a hiring score. Check the box when you're ready to sit down.",
  },
  {
    id: "setup-start",
    target: "setup-start",
    title: "Sit down",
    body: "This creates your own Postgres database. Next you'll land in chat with Priya, and the tour continues there.",
  },
];

export const DESK_STEPS: TourStep[] = [
  {
    id: "chat",
    target: "tour-chat",
    title: "Chat",
    body: "Priya writes like a person, not a memo. Messages arrive one at a time, with a typing indicator. Reply when you're ready. She waits instead of posting a wall.",
  },
  {
    id: "kt",
    target: "tour-kt",
    title: "Priya's knowledge transfer",
    body: "The knowledge transfer is a short meeting on your calendar. Join it, then let Priya take it one point at a time. Say go on for the next point, or ask a question in your own words.",
  },
  {
    id: "calendar",
    target: "tour-calendar",
    title: "Calendar",
    body: "Meetings live here. Ten minutes before, and again one minute before, you get a yellow system note, a toast, and a badge on Calendar. Join is on the note. A missed meeting is noted. Nothing locks.",
  },
  {
    id: "board",
    target: "tour-board",
    title: "The board and MO-1",
    body: "Work arrives as tickets, like a Jira board. MO-1 is Explore the landing zone. Open it and read what done means. It shows up after Priya's kickoff, a few simulated minutes in.",
  },
  {
    id: "connections",
    target: "tour-connections",
    title: "Connection manager",
    body: "Connections holds your Postgres login. You can test it. You can read the landing tables and create new tables. You cannot rewrite the raw files.",
  },
  {
    id: "workbench",
    target: "tour-workbench",
    title: "SQL workbench",
    body: "This is where you write SQL. The editor is a normal query box. Errors come back from Postgres, in Postgres's own words.",
  },
  {
    id: "run-query",
    target: "tour-run",
    title: "Run a query",
    body: "Run the count on raw_orders. Then run one against raw_events. MO-1 is done when both have succeeded. You can click Run while this card stays up.",
  },
  {
    id: "submit",
    target: "tour-mo1",
    title: "Submit the ticket",
    body: "Open MO-1 and choose Submit for verdict. That asks Priya to check the rule on the ticket. It does not lock the database, and you can try again.",
  },
  {
    id: "feedback",
    target: "tour-verdict",
    title: "Grading feedback",
    body: "Priya's verdict shows on the ticket and in her chat. A pass says what held. A miss says what is still wrong, not the query to paste.",
  },
];

export function TourLayer({
  steps,
  stepId,
  onNext,
  onBack,
  onSkip,
  finishLabel = "Done",
}: {
  steps: TourStep[];
  stepId: string;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
  finishLabel?: string;
}) {
  const index = Math.max(0, steps.findIndex((step) => step.id === stepId));
  const step = steps[index] ?? steps[0];
  const [box, setBox] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const [card, setCard] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    const place = () => {
      const node = step?.target ? document.querySelector(`[data-tour="${step.target}"]`) : null;
      if (!node) {
        setBox(null);
        setCard(null);
        return;
      }
      const rect = node.getBoundingClientRect();
      const next = { top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 };
      setBox(next);
      const below = rect.top < window.innerHeight * 0.55;
      const top = below ? Math.min(window.innerHeight - 200, rect.bottom + 14) : Math.max(12, rect.top - 200);
      const left = Math.min(window.innerWidth - 340, Math.max(12, rect.left));
      setCard({ top, left });
    };
    place();
    const timer = window.setInterval(place, 500);
    window.addEventListener("resize", place);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", place);
    };
  }, [step]);

  if (!step) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-[80]">
      {box ? (
        <div
          data-tour-spotlight="true"
          className="absolute rounded-lg ring-2 ring-[#8A6D00]"
          style={{
            top: box.top,
            left: box.left,
            width: box.width,
            height: box.height,
            boxShadow: "0 0 0 9999px rgba(36, 36, 36, 0.45)",
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-[#242424]/45" />
      )}
      <div
        className="pointer-events-auto absolute w-[min(100%-1.5rem,22rem)] rounded-lg border border-[#8A6D00] bg-[#FFF4CE] p-4 text-[#3b2f00] shadow-lg"
        style={card ? { top: card.top, left: card.left } : { top: "18%", left: "50%", transform: "translateX(-50%)" }}
        role="dialog"
        aria-label="Guided tour"
      >
        <p className="text-[10px] font-semibold uppercase tracking-wide">
          Tour · {index + 1} of {steps.length}
        </p>
        <h2 className="mt-1 text-base font-semibold">{step.title}</h2>
        <p className="mt-2 text-sm leading-relaxed">{step.body}</p>
        <div className="mt-3 flex items-center justify-between gap-2">
          <button type="button" className="text-xs underline" onClick={onSkip}>
            Skip tour
          </button>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" onClick={onBack} disabled={index === 0}>
              Back
            </Button>
            <Button type="button" size="sm" onClick={onNext}>
              {index === steps.length - 1 ? finishLabel : "Next"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
