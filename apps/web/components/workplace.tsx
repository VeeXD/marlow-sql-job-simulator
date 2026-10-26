"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { io } from "socket.io-client";
import {
  Bell,
  CalendarDays,
  Cable,
  Database,
  KanbanSquare,
  MessageSquare,
  Play,
  Plus,
  Search,
  Trash2,
  Users,
} from "lucide-react";
import { ApiError, api, clearStoredSession, formatSim, readStoredSession, simParts } from "@/lib/api";
import {
  CHANNELS_DM,
  STAGE_LABELS,
  type ChatMessage,
  type PersonaId,
  type QueryResult,
  type SchemaPayload,
  type Session,
  type Ticket,
} from "@/lib/types";
import { SystemNote } from "@/components/system-note";
import { Prose } from "@/components/prose";
import { SqlEditor } from "@/components/sql-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const DEFAULT_SQL = "SELECT COUNT(*) AS rows FROM raw_orders;\n";

type Pane = "activity" | "chat" | "teams" | "calendar" | "board" | "workbench" | "meeting";

export function Workplace() {
  const stored = useRef(readStoredSession());
  const gen = useRef(0);
  const sessionRef = useRef<Session | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [booting, setBooting] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  sessionRef.current = session;
  const [pane, setPane] = useState<Pane>("chat");
  const [bench, setBench] = useState<"sql" | "pipeline">("sql");
  const [channel, setChannel] = useState("dm:priya");
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [erdOpen, setErdOpen] = useState(false);
  const [connOpen, setConnOpen] = useState(false);
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const keyTimes = useRef<number[]>([]);

  const postSignal = useCallback((body: Record<string, unknown>) => {
    const current = stored.current;
    if (!current) return;
    void api(`/api/sessions/${current.id}/signals`, current.token, {
      method: "POST",
      body: JSON.stringify(body),
    }).catch(() => undefined);
  }, []);

  const flushCadence = useCallback(() => {
    const stamps = keyTimes.current;
    keyTimes.current = [];
    if (!sessionRef.current?.consent.integritySignals || stamps.length < 2) return;
    const intervals: number[] = [];
    for (let i = 1; i < stamps.length; i++) intervals.push(stamps[i] - stamps[i - 1]);
    intervals.sort((a, b) => a - b);
    const medianIntervalMs = intervals[Math.floor(intervals.length / 2)] ?? 0;
    postSignal({ kind: "typing_cadence", keyCount: stamps.length, medianIntervalMs });
  }, [postSignal]);

  const noteKey = useCallback(() => {
    if (!sessionRef.current?.consent.integritySignals) return;
    keyTimes.current.push(Date.now());
    if (keyTimes.current.length >= 24) flushCadence();
  }, [flushCadence]);

  const notePaste = useCallback(
    (chars: number) => {
      if (!sessionRef.current?.consent.integritySignals) return;
      postSignal({ kind: "paste", pasteChars: chars });
    },
    [postSignal],
  );

  useEffect(() => {
    if (!session?.consent.integritySignals) return;
    const onHide = () => {
      if (document.visibilityState !== "hidden") return;
      flushCadence();
      postSignal({ kind: "focus_loss" });
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [session?.consent.integritySignals, flushCadence, postSignal]);

  useEffect(() => {
    if (!erdOpen) return;
    postSignal({ kind: "erd_opened" });
  }, [erdOpen, postSignal]);

  const commit = useCallback((mine: number, next: Session) => {
    if (mine === gen.current) setSession(next);
  }, []);

  const refresh = useCallback(async () => {
    const current = stored.current;
    if (!current) return;
    const mine = ++gen.current;
    try {
      const next = await api<Session>(`/api/sessions/${current.id}`, current.token);
      commit(mine, next);
      if (mine === gen.current) setBanner(null);
    } catch (err) {
      if (mine !== gen.current) return;
      if (err instanceof ApiError && err.status === 401) {
        clearStoredSession();
        setFatal("This desk session is no longer valid.");
        setSession(null);
      } else if (!sessionRef.current) {
        setFatal(err instanceof Error ? err.message : "Could not open the desk.");
      } else {
        setBanner(err instanceof Error ? err.message : "Refresh failed.");
      }
    } finally {
      if (mine === gen.current) setBooting(false);
    }
  }, [commit]);

  useEffect(() => {
    if (!stored.current) {
      setBooting(false);
      return;
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4000);
    const socket = io({ path: "/socket.io", transports: ["websocket", "polling"] });
    socket.emit("join", { sessionId: stored.current.id, token: stored.current.token });
    socket.on("refresh", () => void refresh());
    return () => {
      window.clearInterval(timer);
      socket.close();
    };
  }, [refresh]);


  async function mutate<T>(path: string, init?: RequestInit): Promise<{ mine: number; value: T }> {
    const current = stored.current;
    if (!current) throw new ApiError(401, "No desk session.");
    const mine = ++gen.current;
    const value = await api<T>(path, current.token, init);
    if (mine === gen.current) setBanner(null);
    return { mine, value };
  }

  if (!stored.current || fatal) {
    return (
      <main className="mx-auto max-w-lg px-4 py-16">
        <h1 className="font-serif text-3xl">No desk open</h1>
        <p className="mt-2 text-sm text-muted">{fatal ?? "Start from the Marlow brief. Your database is created when you sit down."}</p>
        <Link href="/" className="mt-6 inline-block text-sm font-medium text-pine underline-offset-4 hover:underline">
          Back to setup
        </Link>
      </main>
    );
  }

  if (booting || !session) {
    return (
      <main className="mx-auto max-w-lg px-4 py-16">
        <p className="text-sm text-muted">Pulling your Marlow desk…</p>
      </main>
    );
  }

  const joinMeeting = async () => {
    try {
      const { mine, value } = await mutate<Session>(`/api/sessions/${session.id}/kt/join`, { method: "POST" });
      commit(mine, value);
      setPane("meeting");
    } catch (err) {
      setBanner(err instanceof Error ? err.message : "Could not join the knowledge transfer.");
      setPane("meeting");
    }
  }

  const wrapMeeting = async () => {
    try {
      const { mine, value } = await mutate<Session>(`/api/sessions/${session.id}/kt/complete`, { method: "POST" });
      commit(mine, value);
    } catch (err) {
      setBanner(err instanceof Error ? err.message : "Could not wrap the knowledge transfer.");
    }
  }

  const activeChannel = pane === "teams" ? "team" : pane === "meeting" ? "meeting:kt" : channel;
  const messages = session.messages.filter((message) => message.channel === activeChannel);
  const stageLabel = STAGE_LABELS.find((stage) => stage.id === session.stage)?.label ?? session.stage;
  const query = search.trim().toLowerCase();
  const searchHits = query
    ? [
        ...session.tickets
          .filter((item) => `${item.key} ${item.title}`.toLowerCase().includes(query))
          .map((item) => ({ kind: "ticket" as const, id: item.id, label: `${item.key} ${item.title}` })),
        ...session.cast
          .filter((person) => person.name.toLowerCase().includes(query))
          .map((person) => ({ kind: "person" as const, id: person.id, label: person.name })),
        ...session.messages
          .filter((message) => message.body.toLowerCase().includes(query))
          .slice(-6)
          .map((message) => ({ kind: "message" as const, id: message.id, label: `${message.authorName}: ${message.body.slice(0, 72)}`, channel: message.channel })),
      ]
    : [];

  const sendChat = async (target: string) => {
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    try {
      const { mine, value } = await mutate<Session>(`/api/sessions/${session.id}/chat`, {
        method: "POST",
        body: JSON.stringify({ channel: target, body }),
      });
      commit(mine, value);
      setDraft("");
    } catch (err) {
      setBanner(err instanceof Error ? err.message : "Message didn't send.");
    } finally {
      setSending(false);
    }
  }

  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex h-dvh flex-col bg-[#f5f5f5] text-[#242424]">
        <Tabs value={pane} onValueChange={(value) => setPane(value as Pane)} className="flex min-h-0 min-w-0 flex-1 flex-row">
          <TabsList className="h-full w-[4.5rem] shrink-0 flex-col items-stretch gap-1 border-r border-[#d1d1d1] bg-[#ebebeb] px-1 py-2">
            <p className="px-1 pb-2 text-center text-[10px] font-semibold text-[#464EB8]">Marlow</p>
            <RailButton value="activity" icon={<Bell className="h-5 w-5" />} label="Activity" />
            <RailButton value="chat" icon={<MessageSquare className="h-5 w-5" />} label="Chat" />
            <RailButton value="teams" icon={<Users className="h-5 w-5" />} label="Teams" />
            <RailButton value="calendar" icon={<CalendarDays className="h-5 w-5" />} label="Calendar" />
            <RailButton value="board" icon={<KanbanSquare className="h-5 w-5" />} label="Board" />
            <RailButton value="workbench" icon={<Database className="h-5 w-5" />} label="Workbench" />
            <button
              type="button"
              onClick={() => setConnOpen(true)}
              className="mt-auto flex flex-col items-center gap-1 rounded-md px-1 py-2 text-[10px] text-[#616161] hover:bg-white"
            >
              <Cable className="h-5 w-5" />
              Connections
            </button>
          </TabsList>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <header className="flex items-center gap-3 border-b border-[#e1e1e1] bg-white px-3 py-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#616161]" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search"
                  className="h-8 border-[#e1e1e1] bg-[#f5f5f5] pl-8"
                  aria-label="Search"
                />
                {searchHits.length > 0 ? (
                  <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border border-[#e1e1e1] bg-white py-1 text-sm shadow-lg">
                    {searchHits.map((hit) => (
                      <li key={`${hit.kind}-${hit.id}`}>
                        <button
                          type="button"
                          className="block w-full truncate px-3 py-1.5 text-left hover:bg-[#f5f5f5]"
                          onClick={() => {
                            setSearch("");
                            if (hit.kind === "ticket") {
                              setPane("board");
                              const item = session.tickets.find((ticket) => ticket.id === hit.id);
                              if (item) setTicket(item);
                            } else if (hit.kind === "person") {
                              setPane("chat");
                              setChannel(`dm:${hit.id}`);
                            } else {
                              setPane(hit.channel === "team" ? "teams" : hit.channel === "meeting:kt" ? "meeting" : "chat");
                              if (hit.channel.startsWith("dm:")) setChannel(hit.channel);
                            }
                          }}
                        >
                          {hit.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <StandingStrip session={session} />
              <Button variant="outline" size="sm" onClick={() => setErdOpen(true)}>
                ERD
              </Button>
              <SystemNote className="hidden max-w-xs truncate py-1 text-xs lg:block">
                {stageLabel} · {formatSim(session.simNow)}
                {session.clockPaused ? " · clock paused" : ""}
              </SystemNote>
            </header>

            {session.breakStatus === "active" ? (
              <SystemNote className="rounded-none border-x-0">
                A late file landed after a run. Riley&apos;s chart and Sam&apos;s features can drift until you rebuild from the landing zone.
              </SystemNote>
            ) : null}
            {session.breakFixed && !session.projectCompleted ? (
              <SystemNote className="rounded-none border-x-0">The tables caught the late file. The project still needs the handoff note.</SystemNote>
            ) : null}
            {banner ? (
              <SystemNote className="flex items-center justify-between gap-3 rounded-none border-x-0">
                <span>{banner}</span>
                <button className="underline" onClick={() => setBanner(null)}>
                  Dismiss
                </button>
              </SystemNote>
            ) : null}

          <TabsContent value="board" className="min-h-0 flex-1 overflow-auto p-3 sm:p-4">
            <Board
              session={session}
              onOpen={async (item) => {
                setTicket(item);
                if (item.status !== "ready") return;
                try {
                  const { mine, value } = await mutate<Session>(`/api/sessions/${session.id}/tickets/${item.id}/open`, { method: "POST" });
                  commit(mine, value);
                  setTicket(value.tickets.find((ticket) => ticket.id === item.id) ?? item);
                } catch (err) {
                  setBanner(err instanceof Error ? err.message : "Could not open the ticket.");
                }
              }}
            />
          </TabsContent>

          <TabsContent value="activity" className="min-h-0 flex-1 overflow-auto p-4">
            <Activity session={session} onOpenChannel={(next) => { setChannel(next); setPane(next === "team" ? "teams" : "chat"); }} onOpenMeeting={() => setPane("meeting")} />
          </TabsContent>

          <TabsContent value="chat" className="flex min-h-0 flex-1 flex-col md:flex-row">
            <ChannelList
              items={CHANNELS_DM}
              active={channel}
              session={session}
              onPick={(id) => { setChannel(id); }}
            />
            <Conversation
              sessionId={session.id}
              title={CHANNELS_DM.find((item) => item.id === channel)?.label ?? "Chat"}
              messages={messages}
              draft={draft}
              setDraft={setDraft}
              sending={sending}
              placeholder={channel === "dm:priya" ? "Message Priya" : "Message"}
              provider={session.llmProvider}
              onSubmit={() => void sendChat(channel)}
            />
          </TabsContent>

          <TabsContent value="teams" className="flex min-h-0 flex-1 flex-col md:flex-row">
            <aside className="border-b border-[#e1e1e1] bg-white p-3 md:w-60 md:border-b-0 md:border-r">
              <p className="text-xs font-semibold uppercase tracking-wide text-[#616161]">Commerce</p>
              <button type="button" className="mt-2 w-full rounded-md bg-[#e8ebfa] px-3 py-2 text-left text-sm font-medium text-[#464EB8]">
                General
              </button>
              <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-[#616161]">People</p>
              <ul className="mt-2 space-y-2">
                {session.cast.map((person) => (
                  <li key={person.id} className="flex items-center gap-2 text-sm">
                    <Avatar id={person.id} name={person.name} presence={presenceFor(session.standing[person.id])} />
                    <span>
                      <span className="block leading-tight">{person.name}</span>
                      <span className="block text-[11px] text-[#616161]">{person.role}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </aside>
            <Conversation
              sessionId={session.id}
              title="General"
              messages={session.messages.filter((message) => message.channel === "team")}
              draft={draft}
              setDraft={setDraft}
              sending={sending}
              placeholder="Message Commerce"
              provider={session.llmProvider}
              onSubmit={() => void sendChat("team")}
            />
          </TabsContent>

          <TabsContent value="meeting" className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center justify-between border-b border-[#e1e1e1] bg-white px-4 py-2">
              <div>
                <p className="text-sm font-semibold">Knowledge transfer</p>
                <p className="text-xs text-[#616161]">Priya Shah · Commerce · transcript</p>
              </div>
              <div className="flex gap-2">
                {session.kt?.status !== "live" && session.kt?.status !== "done" ? (
                  <Button size="sm" onClick={() => void joinMeeting()}>Join</Button>
                ) : null}
                {session.kt?.status === "live" ? (
                  <Button size="sm" variant="outline" onClick={() => void wrapMeeting()}>Wrap the meeting</Button>
                ) : null}
              </div>
            </div>
            <SystemNote className="m-3">
              Meeting transcript. Questions you ask here are logged for the signals page. This is not a score.
            </SystemNote>
            <Conversation
              sessionId={session.id}
              title="Knowledge transfer"
              messages={session.messages.filter((message) => message.channel === "meeting:kt")}
              draft={draft}
              setDraft={setDraft}
              sending={sending}
              placeholder="Ask Priya during the KT"
              provider={session.llmProvider}
              onSubmit={() => void sendChat("meeting:kt")}
              hideHeader
              layout="transcript"
            />
          </TabsContent>

          <TabsContent value="workbench" className="min-h-0 flex-1 overflow-auto p-3 sm:p-4">
            <div className="mb-3 flex gap-2">
              <Button size="sm" variant={bench === "sql" ? "default" : "outline"} onClick={() => setBench("sql")}>SQL</Button>
              <Button size="sm" variant={bench === "pipeline" ? "default" : "outline"} onClick={() => setBench("pipeline")}>Pipeline</Button>
            </div>
            {bench === "sql" ? (
              <Workbench
                sql={sql}
                setSql={setSql}
                running={running}
                result={result}
                notice={session.consent.integritySignals ? session.consent.notice : null}
                onPasteChars={notePaste}
                onType={noteKey}
                onRun={async () => {
                  setRunning(true);
                  try {
                    const { mine, value } = await mutate<{ session: Session; result: QueryResult }>(`/api/sessions/${session.id}/query`, {
                      method: "POST",
                      body: JSON.stringify({ sql }),
                    });
                    commit(mine, value.session);
                    setResult(value.result);
                  } catch (err) {
                    setBanner(err instanceof Error ? err.message : "Query failed to send.");
                  } finally {
                    setRunning(false);
                  }
                }}
              />
            ) : (
              <PipelinePane
                session={session}
                onError={setBanner}
                onPasteChars={notePaste}
                onType={noteKey}
                onSession={(mine, next) => commit(mine, next)}
                save={(steps, schedule) =>
                  mutate<Session>(`/api/sessions/${session.id}/pipeline`, {
                    method: "PUT",
                    body: JSON.stringify({ steps, schedule }),
                  })
                }
                run={() => mutate<Session>(`/api/sessions/${session.id}/pipeline/run`, { method: "POST" })}
              />
            )}
          </TabsContent>

          <TabsContent value="calendar" className="min-h-0 flex-1 overflow-auto p-3 sm:p-4">
            <Week session={session} onJoin={() => void joinMeeting()} onOpen={() => setPane("meeting")} />
          </TabsContent>
            </div>
        </Tabs>

        <footer className="flex items-center justify-end gap-3 border-t border-[#e1e1e1] bg-white py-1.5 pl-16 pr-3">
          <SystemNote className="mr-auto py-1 text-xs">Standing can fall and recover. It never locks a person or a table.</SystemNote>
          <span className="flex items-center gap-3 text-xs">
            {session.signalsPage ? (
              <Link href="/signals" className="text-[#464EB8] underline">
                Signals
              </Link>
            ) : null}
            <button className="text-[#464EB8] underline" onClick={() => setLeaveOpen(true)}>
              Leave the project
            </button>
          </span>
        </footer>
      </div>

      <ErdDialog
        open={erdOpen}
        onOpenChange={setErdOpen}
        session={session}
        onPreview={(table) => postSignal({ kind: "table_previewed", table })}
      />
      <ConnectionDialog open={connOpen} onOpenChange={setConnOpen} session={session} />
      <TicketDialog
        ticket={ticket}
        session={session}
        onClose={() => setTicket(null)}
        onError={setBanner}
        onSession={(mine, next) => {
          commit(mine, next);
          if (ticket) setTicket(next.tickets.find((item) => item.id === ticket.id) ?? null);
        }}
        submit={(id) => mutate<Session>(`/api/sessions/${session.id}/tickets/${id}/submit`, { method: "POST" })}
        handoff={(body) =>
          mutate<Session>(`/api/sessions/${session.id}/handoff`, { method: "POST", body: JSON.stringify({ body }) })
        }
        chooseNext={(projectId) =>
          mutate<Session>(`/api/sessions/${session.id}/next-project`, {
            method: "POST",
            body: JSON.stringify({ projectId }),
          })
        }
      />
      <Dialog open={leaveOpen} onOpenChange={setLeaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Leave Marlow?</DialogTitle>
            <DialogDescription>This marks the project abandoned. Your sandbox database stays until it is reaped.</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setLeaveOpen(false)}>
              Stay
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                try {
                  await mutate(`/api/sessions/${session.id}/abandon`, { method: "POST" });
                } catch {
                  /* still leave the browser desk */
                }
                clearStoredSession();
                window.location.href = "/";
              }}
            >
              Leave
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

function presenceFor(standing: number): "online" | "away" | "busy" {
  if (standing >= 70) return "online";
  if (standing >= 50) return "away";
  return "busy";
}

function Avatar({ id, name, presence = "online" }: { id: string; name: string; presence?: "online" | "away" | "busy" }) {
  const initials = name
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const color = id === "sam" ? "#4F6BED" : id === "riley" ? "#C4314B" : id === "jonah" ? "#6264A7" : id === "player" ? "#242424" : "#464EB8";
  const dot = presence === "busy" ? "#C4314B" : presence === "away" ? "#F8D22A" : "#6BB700";
  return (
    <span className="relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white" style={{ background: color }}>
      {initials}
      <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white" style={{ background: dot }} />
    </span>
  );
}

function RailButton({ value, icon, label }: { value: string; icon: ReactNode; label: string }) {
  return (
    <TabsTrigger value={value} className="flex h-auto flex-col gap-1 px-1 py-2 text-[10px] data-[state=active]:bg-white data-[state=active]:text-[#464EB8]">
      {icon}
      {label}
    </TabsTrigger>
  );
}

function StandingStrip({ session }: { session: Session }) {
  return (
    <div className="hidden items-center gap-1 lg:flex">
      {session.cast.map((person) => (
        <Tooltip key={person.id}>
          <TooltipTrigger asChild>
            <span className="inline-flex items-center gap-1 rounded-full bg-[#f5f5f5] px-1.5 py-0.5 text-[11px]">
              <Avatar id={person.id} name={person.name} presence={presenceFor(session.standing[person.id])} />
              <span className="pr-1">
                {person.name.split(" ")[0]} {session.standing[person.id]}
              </span>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {person.name} · {person.role}. Latest:{" "}
            {session.standingLog.filter((entry) => entry.persona === person.id).at(-1)?.reason ?? "no change yet"}.
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

function MessageBubble({ message }: { message: Session["messages"][number] }) {
  const mine = message.author === "player";
  return (
    <article className={`flex gap-2 ${mine ? "flex-row-reverse" : ""}`}>
      <Avatar id={mine ? "player" : message.author} name={message.authorName} presence={mine ? "online" : "online"} />
      <div className={`max-w-[36rem] ${mine ? "text-right" : ""}`}>
        <header className={`mb-1 flex items-baseline gap-2 text-[11px] text-[#616161] ${mine ? "justify-end" : ""}`}>
          <span className="font-semibold text-[#242424]">{message.authorName}</span>
          <time>{formatSim(message.atSim)}</time>
        </header>
        <div className={`rounded-md px-3 py-2 text-left text-sm leading-relaxed ${mine ? "bg-[#e8ebfa]" : "border border-[#e1e1e1] bg-white"}`}>
          <Prose text={message.body} />
        </div>
        {message.reaction ? (
          <span className="mt-1 inline-flex rounded-full border border-[#e1e1e1] bg-white px-1.5 text-xs">{message.reaction}</span>
        ) : null}
      </div>
    </article>
  );
}

const seenMemory = new Map<string, Set<string>>();

function rememberSeen(sessionId: string): Set<string> {
  const existing = seenMemory.get(sessionId);
  if (existing) return existing;
  const seen = new Set<string>();
  if (typeof window !== "undefined") {
    try {
      const raw = sessionStorage.getItem(`marlow.seen.${sessionId}`);
      if (raw) {
        for (const id of JSON.parse(raw) as string[]) seen.add(id);
      }
    } catch {
      // A bad cache just means the thread types the history once.
    }
  }
  seenMemory.set(sessionId, seen);
  return seen;
}

function persistSeen(sessionId: string, seen: Set<string>) {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(`marlow.seen.${sessionId}`, JSON.stringify([...seen]));
}

function topicOf(message: ChatMessage): string | null {
  const match = /^kt_([a-z0-9]+)(?:_more)?$/.exec(message.intent);
  return match ? match[1] : null;
}

function groupTurns(messages: ChatMessage[]) {
  const turns: {
    id: string;
    authorName: string;
    atSim: string;
    topic: string | null;
    bodies: string[];
    reaction?: string;
    mine: boolean;
  }[] = [];
  for (const message of messages) {
    const topic = topicOf(message);
    const mine = message.author === "player";
    const last = turns.at(-1);
    if (last && !mine && !last.mine && last.authorName === message.authorName && topic && topic === last.topic) {
      last.bodies.push(message.body);
      if (!last.reaction && message.reaction) last.reaction = message.reaction;
      continue;
    }
    turns.push({
      id: message.id,
      authorName: message.authorName,
      atSim: message.atSim,
      topic,
      bodies: [message.body],
      reaction: message.reaction,
      mine,
    });
  }
  return turns;
}

function Transcript({ messages }: { messages: ChatMessage[] }) {
  const turns = groupTurns(messages);
  return (
    <div className="divide-y divide-[#e1e1e1] bg-white">
      {turns.map((turn) => (
        <article key={turn.id} className="grid grid-cols-1 gap-1 px-4 py-3 sm:grid-cols-[7.5rem_1fr] sm:gap-4">
          <time className="text-xs text-[#616161] sm:pt-0.5">{formatSim(turn.atSim)}</time>
          <div>
            <p className={`text-sm font-semibold ${turn.mine ? "text-[#242424]" : "text-[#464EB8]"}`}>{turn.authorName}</p>
            <Prose text={turn.bodies.join(" ")} className="mt-1 text-sm leading-7 text-[#242424]" />
            {turn.reaction ? (
              <span className="mt-2 inline-flex rounded-full border border-[#e1e1e1] bg-[#f5f5f5] px-1.5 text-xs">{turn.reaction}</span>
            ) : null}
          </div>
        </article>
      ))}
    </div>
  );
}

function Thread({ sessionId, messages, layout = "bubbles" }: { sessionId: string; messages: ChatMessage[]; layout?: "bubbles" | "transcript" }) {
  const queue = useRef<ChatMessage[]>([]);
  const playing = useRef(false);
  const alive = useRef(true);
  const [hidden, setHidden] = useState<Set<string>>(() => {
    const seen = rememberSeen(sessionId);
    return new Set(messages.filter((message) => message.author !== "player" && !seen.has(message.id)).map((message) => message.id));
  });
  const [typingName, setTypingName] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const signature = messages.map((message) => message.id).join("|");

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    const seen = rememberSeen(sessionId);
    let added = false;
    for (const message of messages) {
      if (message.author === "player") {
        seen.add(message.id);
        continue;
      }
      if (seen.has(message.id) || queue.current.some((item) => item.id === message.id)) continue;
      queue.current.push(message);
      added = true;
    }
    if (added) {
      setHidden((current) => {
        const next = new Set(current);
        for (const item of queue.current) next.add(item.id);
        return next;
      });
      setTypingName((current) => current ?? queue.current[0]?.authorName ?? null);
    }
    const run = async () => {
      if (playing.current) return;
      playing.current = true;
      while (alive.current && queue.current.length > 0) {
        const message = queue.current[0];
        setTypingName(message.authorName);
        await new Promise((resolve) => setTimeout(resolve, 680));
        if (!alive.current) break;
        if (queue.current[0]?.id !== message.id) continue;
        queue.current.shift();
        seen.add(message.id);
        persistSeen(sessionId, seen);
        setHidden((current) => {
          const next = new Set(current);
          next.delete(message.id);
          return next;
        });
        setTypingName(null);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      playing.current = false;
      if (!alive.current) return;
      setTypingName(null);
      if (queue.current.length > 0) void run();
    };
    void run();
  }, [signature, sessionId, messages]);

  useEffect(() => {
    const node = box.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [signature, hidden, typingName]);

  const seen = rememberSeen(sessionId);
  const visible = messages.filter((message) => message.author === "player" || (seen.has(message.id) && !hidden.has(message.id)));
  return (
    <div ref={box} className={`min-h-0 flex-1 overflow-y-auto ${layout === "transcript" ? "bg-white" : ""}`}>
      <div className={layout === "transcript" ? "" : "space-y-3 p-3 sm:p-4"}>
        {visible.length === 0 && !typingName ? (
          <SystemNote>Nothing in this thread yet. The clock moves while you work, then pauses if you go quiet.</SystemNote>
        ) : null}
        {layout === "transcript" ? (
          <Transcript messages={visible} />
        ) : (
          visible.map((message) => <MessageBubble key={message.id} message={message} />)
        )}
        {typingName ? (
          <p className="flex items-center gap-2 text-xs text-[#616161]">
            <span className="flex gap-1">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#6264A7]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#6264A7] [animation-delay:120ms]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#6264A7] [animation-delay:240ms]" />
            </span>
            {typingName} is typing
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Conversation({
  sessionId,
  title,
  messages,
  draft,
  setDraft,
  sending,
  placeholder,
  provider,
  onSubmit,
  hideHeader = false,
  layout = "bubbles",
}: {
  sessionId: string;
  title: string;
  messages: ChatMessage[];
  draft: string;
  setDraft: (value: string) => void;
  sending: boolean;
  placeholder: string;
  provider: string;
  onSubmit: () => void;
  hideHeader?: boolean;
  layout?: "bubbles" | "transcript";
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[#f5f5f5]">
      {hideHeader ? null : (
        <div className="border-b border-[#e1e1e1] bg-white px-4 py-2">
          <p className="text-sm font-semibold">{title}</p>
        </div>
      )}
      <Thread sessionId={sessionId} messages={messages} layout={layout} />
      <form
        className="border-t border-[#e1e1e1] bg-white p-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={placeholder} maxLength={4000} className="min-h-16" />
        <div className="mt-2 flex items-center justify-between gap-3">
          <SystemNote className="py-1 text-xs">Replies are worded by {provider}. The director decides when someone speaks.</SystemNote>
          <Button type="submit" disabled={sending || draft.trim().length === 0}>
            {sending ? "Sending…" : "Send"}
          </Button>
        </div>
      </form>
    </div>
  );
}

function ChannelList({
  items,
  active,
  session,
  onPick,
}: {
  items: { id: string; label: string; hint: string }[];
  active: string;
  session: Session;
  onPick: (id: string) => void;
}) {
  return (
    <aside className="flex gap-1 overflow-x-auto border-b border-[#e1e1e1] bg-white p-2 md:w-64 md:flex-col md:overflow-y-auto md:border-b-0 md:border-r">
      {items.map((item) => {
        const persona = item.id.slice(3) as PersonaId;
        const count = session.messages.filter((message) => message.channel === item.id).length;
        return (
          <button
            key={item.id}
            onClick={() => onPick(item.id)}
            className={`flex items-center gap-2 rounded-md px-2 py-2 text-left text-sm ${active === item.id ? "bg-[#e8ebfa]" : "hover:bg-[#f5f5f5]"}`}
          >
            <Avatar id={persona} name={item.label} presence={presenceFor(session.standing[persona] ?? 72)} />
            <span>
              <span className="block font-medium">{item.label}</span>
              <span className="block text-xs text-[#616161]">
                {item.hint}
                {count ? ` · ${count}` : ""}
              </span>
            </span>
          </button>
        );
      })}
    </aside>
  );
}

function Activity({
  session,
  onOpenChannel,
  onOpenMeeting,
}: {
  session: Session;
  onOpenChannel: (channel: string) => void;
  onOpenMeeting: () => void;
}) {
  const recent = [...session.messages].slice(-8).reverse();
  return (
    <div className="mx-auto max-w-2xl space-y-3">
      <h2 className="text-lg font-semibold">Activity</h2>
      <SystemNote>
        Practice mode is on. The desk records queries, messages, and timings. Experimental. Not a hiring score.
        {session.clockPaused ? " The clock is paused." : " The clock is moving."}
      </SystemNote>
      {session.kt?.status !== "done" ? (
        <button type="button" onClick={onOpenMeeting} className="block w-full rounded-md border border-[#e1e1e1] bg-white p-3 text-left hover:border-[#464EB8]">
          <span className="text-xs font-semibold uppercase tracking-wide text-[#464EB8]">Meeting</span>
          <span className="mt-1 block text-sm font-medium">Knowledge transfer with Priya</span>
          <span className="mt-1 block text-xs text-[#616161]">
            {session.kt?.status === "live" ? "In progress. You can still ask questions." : "On your calendar this morning."}
          </span>
        </button>
      ) : null}
      <ul className="space-y-2">
        {recent.map((message) => (
          <li key={message.id}>
            <button
              type="button"
              onClick={() => onOpenChannel(message.channel)}
              className="flex w-full items-start gap-2 rounded-md border border-[#e1e1e1] bg-white p-3 text-left hover:border-[#6264A7]"
            >
              <Avatar id={message.author === "player" ? "player" : message.author} name={message.authorName} />
              <span>
                <span className="block text-sm font-medium">{message.authorName}</span>
                <span className="mt-0.5 block text-sm text-[#616161]">{message.body.slice(0, 140)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Board({ session, onOpen }: { session: Session; onOpen: (ticket: Ticket) => void }) {
  const columns: { id: Ticket["status"]; label: string }[] = [
    { id: "ready", label: "Ready" },
    { id: "in_progress", label: "In progress" },
    { id: "done", label: "Done" },
  ];
  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-line bg-card p-4">
        <p className="text-xs uppercase tracking-wide text-muted">Epic {session.project.epicKey}</p>
        <h2 className="font-serif text-2xl">{session.project.title}</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted">{session.project.summary}</p>
      </section>
      {session.cohort?.active ? (
        <section className="rounded-lg border border-pine/40 bg-[#eef4f1] p-4">
          <p className="text-xs uppercase tracking-wide text-pine">Repeat purchase cohorts</p>
          <p className="mt-1 text-sm">
            {session.cohort.completed
              ? "RC-1 is done. The rest of that brief is not staffed."
              : "RC-1 is on this board. Build repeat_cohorts from clean_orders, then submit it."}
          </p>
        </section>
      ) : null}
      {session.review ? <ReviewCard session={session} /> : null}
      {session.tickets.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line bg-card p-6 text-sm text-muted">
          The board is empty. Priya puts the epic up after the welcome and Jonah&apos;s schema walkthrough. Stay on the thread — the clock is moving.
        </p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-3">
          {columns.map((column) => (
            <section key={column.id} className="rounded-lg bg-black/[0.03] p-2">
              <h3 className="px-1 py-1 text-xs font-medium uppercase tracking-wide text-muted">{column.label}</h3>
              <div className="space-y-2">
                {session.tickets.filter((item) => item.status === column.id).length === 0 ? (
                  <p className="px-1 py-3 text-xs text-muted">Nothing here.</p>
                ) : null}
                {session.tickets
                  .filter((item) => item.status === column.id)
                  .map((item) => (
                    <button
                      key={item.id}
                      onClick={() => onOpen(item)}
                      className={`w-full rounded-md border bg-card p-3 text-left shadow-sm hover:border-pine/40 ${
                        item.id === "break" && session.breakStatus === "active" ? "border-clay" : "border-line"
                      }`}
                    >
                      <span className="text-[11px] text-muted">{item.key}</span>
                      <span className="mt-0.5 block text-sm font-medium">{item.title}</span>
                      <span className="mt-2 block text-[11px] text-muted">Due {formatSim(item.dueAt)}</span>
                    </button>
                  ))}
              </div>
            </section>
          ))}
        </div>
      )}
      <div className="grid gap-2 sm:hidden">
        <p className="text-xs uppercase tracking-wide text-muted">Standing</p>
        {session.cast.map((person) => (
          <p key={person.id} className="text-sm">
            {person.name} <span className="text-muted">{session.standing[person.id]}</span>
          </p>
        ))}
      </div>
    </div>
  );
}

function ReviewCard({ session }: { session: Session }) {
  const review = session.review;
  if (!review) return null;
  return (
    <section className="rounded-lg border border-pine/30 bg-[#eef4f1] p-4">
      <p className="text-xs uppercase tracking-wide text-pine">Project review</p>
      <Prose text={review.summary} className="mt-2 text-sm leading-relaxed" />
      <p className="mt-2 text-xs text-muted">
        Handoff checklist {review.handoffScore}/{review.handoffTotal}.
        {session.cohort?.completed
          ? " RC-1 is done. The wider brief stays unstaffed."
          : session.cohort?.active
            ? " RC-1 is on the board."
            : session.nextProjectChosen
              ? " Next brief recorded."
              : " The next brief can be accepted from MO-5."}
      </p>
    </section>
  );
}

function Workbench({
  sql,
  setSql,
  running,
  result,
  onRun,
  notice,
  onPasteChars,
  onType,
}: {
  sql: string;
  setSql: (value: string) => void;
  running: boolean;
  result: QueryResult | null;
  onRun: () => void;
  notice: string | null;
  onPasteChars: (chars: number) => void;
  onType: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-serif text-2xl">Workbench</h2>
          <p className="text-sm text-muted">Your writable database. Landing tables are read-only. Engine errors are unchanged.</p>
          {notice ? <SystemNote className="mt-2 max-w-xl text-xs">{notice}</SystemNote> : null}
        </div>
        <Button onClick={onRun} disabled={running || sql.trim().length === 0}>
          <Play className="h-3.5 w-3.5" />
          {running ? "Running…" : "Run"}
        </Button>
      </div>
      <SqlEditor value={sql} onChange={setSql} height="260px" onPasteChars={onPasteChars} onType={onType} />
      {!result ? (
        <p className="rounded-lg border border-dashed border-line bg-card p-4 text-sm text-muted">
          Run a statement to see rows. A missing table comes back as Postgres wrote it, including the error code.
        </p>
      ) : null}
      {result?.error ? (
        <div className="rounded-lg border border-clay/40 bg-[#f8e8e4] p-3 text-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-clay">
            {result.error.code ? `Postgres ${result.error.code}` : "Rejected before Postgres"}
          </p>
          <pre className="mt-1 whitespace-pre-wrap font-mono text-xs text-ink">{result.error.message}</pre>
          {result.error.detail ? <p className="mt-1 text-xs">Detail: {result.error.detail}</p> : null}
          {result.error.hint ? <p className="text-xs">Hint: {result.error.hint}</p> : null}
          {result.error.position ? <p className="text-xs">Position: {result.error.position}</p> : null}
        </div>
      ) : null}
      {result?.statements.map((statement, index) => (
        <div key={index} className="overflow-hidden rounded-lg border border-line bg-card">
          <div className="flex items-center justify-between border-b border-line px-3 py-1.5 text-xs text-muted">
            <span>
              {statement.command ?? "result"} · {statement.rowCount ?? statement.rows.length} rows · {result.durationMs} ms
            </span>
            {statement.truncated ? <span>Showing the first 500 rows.</span> : null}
          </div>
          {statement.rows.length === 0 ? (
            <p className="p-3 text-sm text-muted">No rows.</p>
          ) : (
            <div className="max-h-72 overflow-auto">
              <table className="min-w-full text-left text-xs">
                <thead className="sticky top-0 bg-paper">
                  <tr>
                    {statement.fields.map((field) => (
                      <th key={field} className="px-2 py-1 font-medium">
                        {field}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {statement.rows.map((row, rowIndex) => (
                    <tr key={rowIndex} className="border-t border-line/70 font-mono">
                      {statement.fields.map((field) => (
                        <td key={field} className="max-w-xs truncate px-2 py-1">
                          {formatCell(row[field])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function PipelinePane({
  session,
  save,
  run,
  onSession,
  onError,
  onPasteChars,
  onType,
}: {
  session: Session;
  onPasteChars: (chars: number) => void;
  onType: () => void;
  save: (
    steps: { id?: string; name: string; sql: string }[],
    schedule: Session["pipeline"]["schedule"],
  ) => Promise<{ mine: number; value: Session }>;
  run: () => Promise<{ mine: number; value: Session }>;
  onSession: (mine: number, session: Session) => void;
  onError: (message: string) => void;
}) {
  const [steps, setSteps] = useState(session.pipeline.steps);
  const [hour, setHour] = useState(session.pipeline.schedule.hour);
  const [minute, setMinute] = useState(session.pipeline.schedule.minute);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState<"save" | "run" | null>(null);
  const signature = JSON.stringify(session.pipeline);
  const appliedSignature = useRef(signature);

  useEffect(() => {
    if (busy !== null || appliedSignature.current === signature) return;
    appliedSignature.current = signature;
    setSteps(session.pipeline.steps);
    setHour(session.pipeline.schedule.hour);
    setMinute(session.pipeline.schedule.minute);
  }, [signature, busy, session.pipeline]);

  const current = steps[selected] ?? null;
  const schedule = {
    cadence: "daily" as const,
    hour: Math.min(23, Math.max(0, Math.floor(hour) || 0)),
    minute: Math.min(59, Math.max(0, Math.floor(minute) || 0)),
    timezone: "America/Los_Angeles" as const,
  };

  async function persist() {
    setBusy("save");
    try {
      const saved = await save(steps, schedule);
      onSession(saved.mine, saved.value);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not save the pipeline.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-serif text-2xl">Pipeline</h2>
          <p className="text-sm text-muted">Ordered SQL steps on the simulated clock. A saved daily schedule runs at that Pacific time.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void persist()} disabled={busy !== null || steps.length === 0}>
            {busy === "save" ? "Saving…" : "Save"}
          </Button>
          <Button
            onClick={async () => {
              setBusy("run");
              try {
                const saved = await save(steps, schedule);
                onSession(saved.mine, saved.value);
                const next = await run();
                onSession(next.mine, next.value);
              } catch (err) {
                onError(err instanceof Error ? err.message : "The run didn't start.");
              } finally {
                setBusy(null);
              }
            }}
            disabled={busy !== null || steps.length === 0}
          >
            <Play className="h-3.5 w-3.5" />
            {busy === "run" ? "Running…" : "Run now"}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-card p-3 text-sm">
        <label>
          Daily hour (PT)
          <Input className="mt-1 w-24" type="number" min={0} max={23} value={hour} onChange={(event) => setHour(Number(event.target.value))} />
        </label>
        <label>
          Minute
          <Input className="mt-1 w-24" type="number" min={0} max={59} value={minute} onChange={(event) => setMinute(Number(event.target.value))} />
        </label>
        <p className="text-xs text-muted">
          {session.pipeline.enabled ? "Schedule is on." : "Save steps with SQL to turn the schedule on."} Timezone is America/Los_Angeles.
        </p>
      </div>

      {steps.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line bg-card p-4 text-sm text-muted">
          No steps yet. Add the rebuild of the tables Sam and Riley read. The runner stops at the first failing statement.
        </p>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-[220px_1fr]">
        <div className="space-y-2">
          {steps.map((step, index) => (
            <button
              key={step.id}
              onClick={() => setSelected(index)}
              className={`w-full rounded-md border px-3 py-2 text-left text-sm ${index === selected ? "border-pine bg-[#eef4f1]" : "border-line bg-card"}`}
            >
              {index + 1}. {step.name || "Untitled step"}
            </button>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const id = `step${Date.now()}`;
              setSteps((prev) => [...prev, { id, name: `Step ${prev.length + 1}`, sql: "" }]);
              setSelected(steps.length);
            }}
          >
            <Plus className="h-3.5 w-3.5" /> Add step
          </Button>
        </div>
        {current ? (
          <div className="space-y-2">
            <div className="flex gap-2">
              <Input
                value={current.name}
                onChange={(event) =>
                  setSteps((prev) => prev.map((step, index) => (index === selected ? { ...step, name: event.target.value } : step)))
                }
                aria-label="Step name"
              />
              <Button
                variant="outline"
                size="icon"
                aria-label="Remove step"
                onClick={() => {
                  setSteps((prev) => prev.filter((_, index) => index !== selected));
                  setSelected(Math.max(0, selected - 1));
                }}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            <SqlEditor
              value={current.sql}
              onChange={(value) =>
                setSteps((prev) => prev.map((step, index) => (index === selected ? { ...step, sql: value } : step)))
              }
              height="220px"
              onPasteChars={onPasteChars}
              onType={onType}
            />
          </div>
        ) : null}
      </div>

      <section>
        <h3 className="text-sm font-medium">Runs</h3>
        {session.runs.length === 0 ? <p className="mt-1 text-sm text-muted">No runs yet.</p> : null}
        <ul className="mt-2 space-y-2">
          {session.runs.map((run) => (
            <li key={run.id} className="rounded-md border border-line bg-card p-3 text-sm">
              <p>
                {formatSim(run.atSim)} · {run.trigger} · {run.ok ? "passed" : "failed"}
              </p>
              <ul className="mt-1 space-y-1 text-xs text-muted">
                {run.logs.map((log, index) => (
                  <li key={index}>
                    {log.name}: {log.ok ? `${log.durationMs} ms` : log.error}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Week({ session, onJoin, onOpen }: { session: Session; onJoin: () => void; onOpen: () => void }) {
  const now = simParts(session.simNow);
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  const events = useMemo(
    () =>
      session.tickets.map((ticket) => ({
        id: ticket.id,
        label: `${ticket.key} due`,
        at: ticket.dueAt,
      })),
    [session.tickets],
  );
  const scheduleLabel = `${String(session.pipeline.schedule.hour).padStart(2, "0")}:${String(session.pipeline.schedule.minute).padStart(2, "0")} PT`;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold">Week of June 3</h2>
        <SystemNote className="mt-2">
          Marlow runs on Pacific time. Opening this week doesn&apos;t spend a meeting. The clock advances while you work and pauses after a quiet stretch.
          {session.clockPaused ? " It is paused now." : ""}{" "}
          {session.pipeline.enabled ? `The daily pipeline is set for ${scheduleLabel}.` : "The daily pipeline is off until steps are saved."}
        </SystemNote>
      </div>
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[#e1e1e1] bg-white p-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-[#464EB8]">Monday 9:00 AM</p>
          <h3 className="text-lg font-semibold">Knowledge transfer</h3>
          <p className="text-sm text-[#616161]">Priya Shah · company, project, data, your role, and the first week.</p>
        </div>
        {session.kt?.status === "done" ? (
          <Button variant="outline" onClick={onOpen}>Open transcript</Button>
        ) : session.kt?.status === "live" ? (
          <Button onClick={onOpen}>Back to the meeting</Button>
        ) : (
          <Button onClick={onJoin}>Join knowledge transfer</Button>
        )}
      </section>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {days.map((day, index) => {
          const active = now?.weekday.startsWith(day);
          return (
            <section key={day} className={`rounded-lg border p-3 ${active ? "border-pine bg-[#eef4f1]" : "border-line bg-card"}`}>
              <h3 className="text-sm font-medium">
                {day} {3 + index}
              </h3>
              {active ? <p className="mt-2 text-xs text-pine">You are here · {formatSim(session.simNow)}</p> : null}
              <ul className="mt-2 space-y-1 text-xs text-muted">
                {events
                  .filter((event) => simParts(event.at)?.weekday.startsWith(day))
                  .map((event) => (
                    <li key={event.id}>{event.label}</li>
                  ))}
              </ul>
            </section>
          );
        })}
      </div>
      <ul className="space-y-1 text-sm">
        {session.tickets.map((ticket) => (
          <li key={ticket.id}>
            {ticket.key} due {formatSim(ticket.dueAt)}
          </li>
        ))}
        {session.tickets.length === 0 ? <li className="text-muted">Due dates show up with the tickets.</li> : null}
      </ul>
    </div>
  );
}

function ErdDialog({
  open,
  onOpenChange,
  session,
  onPreview,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: Session;
  onPreview: (table: string) => void;
}) {
  const [schema, setSchema] = useState<SchemaPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<SchemaPayload>(`/api/sessions/${session.id}/schema`, session.token)
      .then((payload) => {
        if (!cancelled) setSchema(payload);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not read the schema.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, session.id, session.token]);

  const live = new Set(schema?.tables.map((table) => table.table) ?? []);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(100%-1.5rem,880px)]">
        <DialogHeader>
          <DialogTitle>Marlow ERD</DialogTitle>
          <DialogDescription>Landing tables are loaded for you. The rest exist after you build them. Relationships are logical, not foreign keys.</DialogDescription>
        </DialogHeader>
        {loading ? <p className="text-sm text-muted">Reading your database…</p> : null}
        {error ? <p className="text-sm text-clay">{error}</p> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          {(schema?.catalog ?? []).map((table) => (
            <section key={table.table} className="rounded-md border border-line p-3">
              <h3 className="flex items-center justify-between font-mono text-sm">
                <button type="button" className="underline-offset-2 hover:underline" onClick={() => onPreview(table.table)}>
                  {table.table}
                </button>
                <Badge variant={live.has(table.table) ? "done" : "outline"}>{live.has(table.table) ? "in database" : "not created"}</Badge>
              </h3>
              <ul className="mt-2 space-y-0.5 font-mono text-xs text-muted">
                {(schema?.tables.find((item) => item.table === table.table)?.columns ?? table.columns.map((name) => ({ name, dataType: "", nullable: true }))).map(
                  (column) => (
                    <li key={column.name}>
                      {column.name}
                      {column.dataType ? ` ${column.dataType}` : ""}
                    </li>
                  ),
                )}
              </ul>
            </section>
          ))}
        </div>
        <Separator />
        <ul className="space-y-2 text-sm">
          {session.relationships.map((link) => (
            <li key={`${link.from}-${link.to}`}>
              <span className="font-mono text-xs">
                {link.from} → {link.to}
              </span>
              <span className="block text-muted">{link.note}</span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function ConnectionDialog({
  open,
  onOpenChange,
  session,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: Session;
}) {
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const conn = session.connection;
  const url = `postgres://${encodeURIComponent(conn.user)}:${encodeURIComponent(conn.password)}@${conn.host}:${conn.port}/${conn.database}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connections</DialogTitle>
          <DialogDescription>This role can read the landing zone and create objects in public. It is not a superuser.</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
          <dt className="text-muted">Engine</dt>
          <dd>Postgres</dd>
          <dt className="text-muted">Host</dt>
          <dd className="font-mono text-xs">{conn.host}:{conn.port}</dd>
          <dt className="text-muted">Database</dt>
          <dd className="break-all font-mono text-xs">{conn.database}</dd>
          <dt className="text-muted">User</dt>
          <dd className="break-all font-mono text-xs">{conn.user}</dd>
          <dt className="text-muted">Password</dt>
          <dd className="break-all font-mono text-xs">{conn.password}</dd>
          <dt className="text-muted">Timezone</dt>
          <dd>{conn.timezone}</dd>
          <dt className="text-muted">Limits</dt>
          <dd>
            {conn.statementTimeoutMs / 1000}s statement timeout, {conn.rowCap} rows returned
          </dd>
        </dl>
        <pre className="overflow-x-auto rounded-md bg-navy p-3 text-xs text-white">{url}</pre>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={async () => {
              await navigator.clipboard.writeText(url);
              setMessage("Copied the connection URL.");
            }}
          >
            Copy URL
          </Button>
          <Button
            onClick={async () => {
              setTesting(true);
              setMessage(null);
              try {
                const result = await api<{ ok: boolean; error: { message: string } | null }>(
                  `/api/sessions/${session.id}/connection/test`,
                  session.token,
                  { method: "POST" },
                );
                setMessage(result.ok ? "Connected as your player role." : result.error?.message ?? "Connection failed.");
              } catch (err) {
                setMessage(err instanceof Error ? err.message : "Connection failed.");
              } finally {
                setTesting(false);
              }
            }}
            disabled={testing}
          >
            {testing ? "Testing…" : "Test connection"}
          </Button>
        </div>
        {message ? <p className="text-sm">{message}</p> : null}
      </DialogContent>
    </Dialog>
  );
}

function TicketDialog({
  ticket,
  session,
  onClose,
  onSession,
  onError,
  submit,
  handoff,
  chooseNext,
}: {
  ticket: Ticket | null;
  session: Session;
  onClose: () => void;
  onSession: (mine: number, session: Session) => void;
  onError: (message: string) => void;
  submit: (id: string) => Promise<{ mine: number; value: Session }>;
  handoff: (body: string) => Promise<{ mine: number; value: Session }>;
  chooseNext: (projectId: string) => Promise<{ mine: number; value: Session }>;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(session.handoff?.body ?? "");
  useEffect(() => {
    setNote(session.handoff?.body ?? "");
  }, [session.handoff?.body]);

  return (
    <Dialog open={Boolean(ticket)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {ticket ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {ticket.key} · {ticket.title}
              </DialogTitle>
              <DialogDescription>Due {formatSim(ticket.dueAt)}</DialogDescription>
            </DialogHeader>
            <Badge variant={ticket.status === "done" ? "done" : ticket.status === "in_progress" ? "progress" : "ready"}>
              {ticket.status.replace("_", " ")}
            </Badge>
            <Prose text={ticket.body} className="text-sm leading-relaxed" />
            <section className="rounded-md bg-paper p-3 text-sm">
              <p className="text-xs uppercase tracking-wide text-muted">What done means</p>
              <Prose text={ticket.evaluationRule} className="mt-1" />
            </section>
            {ticket.coachNotes ? (
              <section className="rounded-md border border-pine/20 bg-[#eef4f1] p-3 text-sm">
                <p className="text-xs uppercase tracking-wide text-pine">Guided note</p>
                <Prose text={ticket.coachNotes} className="mt-1" />
              </section>
            ) : null}
            {ticket.lastVerdict ? (
              <section className={`rounded-md p-3 text-sm ${ticket.lastVerdict.passed ? "bg-[#e5f0e6]" : "bg-[#f8e8e4]"}`}>
                <p className="text-xs uppercase tracking-wide">{ticket.lastVerdict.passed ? "Verdict" : "Sent back"}</p>
                <Prose text={ticket.lastVerdict.summary} className="mt-1" />
              </section>
            ) : null}
            <SystemNote>Submit for verdict asks the person who owns the ticket. It is not a model review, and it does not lock the database.</SystemNote>
            {ticket.id !== "definition" ? (
              <Button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const submitted = await submit(ticket.id);
                    onSession(submitted.mine, submitted.value);
                  } catch (err) {
                    onError(err instanceof Error ? err.message : "Submit failed.");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Checking…" : "Submit for verdict"}
              </Button>
            ) : (
              <p className="text-sm text-muted">This one closes in chat, when you and Priya agree what counts as an order.</p>
            )}
            {ticket.id === "break" && session.breakStatus !== "pending" ? (
              <form
                className="space-y-2 border-t border-line pt-3"
                onSubmit={async (event) => {
                  event.preventDefault();
                  setBusy(true);
                  try {
                    const filed = await handoff(note);
                    onSession(filed.mine, filed.value);
                  } catch (err) {
                    onError(err instanceof Error ? err.message : "Handoff wasn't accepted.");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <label htmlFor="handoff" className="text-sm font-medium">
                  Handoff note
                </label>
                <Textarea id="handoff" value={note} onChange={(event) => setNote(event.target.value)} />
                {session.handoff ? (
                  <p className="text-xs text-muted">
                    Checklist {session.handoff.score}/{session.handoff.total}.
                    {session.handoff.passed ? " Enough to close." : ` Still missing: ${session.handoff.missing.join("; ")}.`}
                  </p>
                ) : (
                  <p className="text-xs text-muted">Write what the next analyst needs. A checklist grades the note; it is not a model review.</p>
                )}
                <Button type="submit" variant="outline" disabled={busy || note.trim().length === 0}>
                  Submit handoff
                </Button>
              </form>
            ) : null}
            {session.review && ticket.id === "break" ? (
              <section className="space-y-2 border-t border-line pt-3">
                <h3 className="font-serif text-lg">{session.review.nextProject.title}</h3>
                <p className="text-sm text-muted">{session.review.nextProject.summary}</p>
                <Button
                  disabled={Boolean(session.nextProjectChosen) || busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const chosen = await chooseNext(session.review!.nextProject.id);
                      onSession(chosen.mine, chosen.value);
                    } catch (err) {
                      onError(err instanceof Error ? err.message : "Could not take the next brief.");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {session.nextProjectChosen ? "RC-1 is on the board" : "Put RC-1 on the board"}
                </Button>
              </section>
            ) : null}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
