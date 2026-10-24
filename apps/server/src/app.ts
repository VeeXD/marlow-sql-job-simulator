import Fastify from "fastify";
import cors from "@fastify/cors";
import { Server } from "socket.io";
import { z, ZodError } from "zod";
import { config } from "./config.js";
import { HttpError } from "./db.js";
import {
  abandon,
  advanceClock,
  chooseNext,
  createSession,
  getSession,
  openTicket,
  postChat,
  postQuery,
  runPipelineNow,
  savePipeline,
  schemaFor,
  setRefreshHook,
  submitHandoff,
  submitTicket,
  telemetryFor,
  testConnection,
  worldBrief,
} from "./session.js";

const difficulty = z.enum(["guided", "standard"]);
const channel = z.enum(["team", "dm:priya", "dm:jonah", "dm:sam", "dm:riley"]);

function tokenFrom(header?: string): string {
  if (!header?.startsWith("Bearer ")) throw new HttpError(401, "Missing session token.");
  return header.slice("Bearer ".length).trim();
}

export async function buildApp() {
  const app = Fastify({ logger: { level: config.logLevel } });
  await app.register(cors, { origin: true });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({ error: error.issues.map((issue) => issue.message).join(" ") });
      return;
    }
    const status = error instanceof HttpError ? error.statusCode : 500;
    const message = error instanceof Error ? error.message : "Request failed.";
    if (status >= 500) app.log.error(error);
    reply.code(status).send({ error: message });
  });

  app.get("/api/health", async () => ({ ok: true, llm: process.env.LLM_PROVIDER || "mock" }));
  app.get("/api/world", async () => worldBrief());

  app.post("/api/sessions", async (request) => {
    const body = z.object({ playerName: z.string().trim().min(1).max(40), difficulty }).parse(request.body);
    return createSession(body.playerName, body.difficulty);
  });

  app.get("/api/sessions/:id", async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return getSession(id, tokenFrom(request.headers.authorization));
  });

  app.post("/api/sessions/:id/chat", async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ channel, body: z.string().trim().min(1).max(4000) }).parse(request.body);
    return postChat(id, tokenFrom(request.headers.authorization), body.channel, body.body);
  });

  app.post("/api/sessions/:id/query", async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ sql: z.string().min(1).max(100_000) }).parse(request.body);
    return postQuery(id, tokenFrom(request.headers.authorization), body.sql);
  });

  app.post("/api/sessions/:id/tickets/:ticketId/open", async (request) => {
    const params = z.object({ id: z.string().uuid(), ticketId: z.string() }).parse(request.params);
    return openTicket(params.id, tokenFrom(request.headers.authorization), params.ticketId);
  });

  app.post("/api/sessions/:id/tickets/:ticketId/submit", async (request) => {
    const params = z.object({ id: z.string().uuid(), ticketId: z.string() }).parse(request.params);
    return submitTicket(params.id, tokenFrom(request.headers.authorization), params.ticketId);
  });

  app.put("/api/sessions/:id/pipeline", async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        steps: z
          .array(z.object({ id: z.string().optional(), name: z.string().max(80), sql: z.string().max(50_000) }))
          .max(12),
        schedule: z.object({
          cadence: z.literal("daily"),
          hour: z.number().int().min(0).max(23),
          minute: z.number().int().min(0).max(59),
          timezone: z.literal("America/Los_Angeles"),
        }),
      })
      .parse(request.body);
    return savePipeline(id, tokenFrom(request.headers.authorization), body.steps, body.schedule);
  });

  app.post("/api/sessions/:id/pipeline/run", async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return runPipelineNow(id, tokenFrom(request.headers.authorization));
  });

  app.post("/api/sessions/:id/handoff", async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ body: z.string().min(1).max(8000) }).parse(request.body);
    return submitHandoff(id, tokenFrom(request.headers.authorization), body.body);
  });

  app.post("/api/sessions/:id/next-project", async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ projectId: z.string() }).parse(request.body);
    return chooseNext(id, tokenFrom(request.headers.authorization), body.projectId);
  });

  app.post("/api/sessions/:id/abandon", async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return abandon(id, tokenFrom(request.headers.authorization));
  });

  app.post("/api/sessions/:id/clock", async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ advanceMinutes: z.number().int().min(0).max(24 * 60) }).parse(request.body);
    return advanceClock(id, tokenFrom(request.headers.authorization), body.advanceMinutes);
  });

  app.post("/api/sessions/:id/connection/test", async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return testConnection(id, tokenFrom(request.headers.authorization));
  });

  app.get("/api/sessions/:id/schema", async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return schemaFor(id, tokenFrom(request.headers.authorization));
  });

  app.get("/api/sessions/:id/telemetry", async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return telemetryFor(id, tokenFrom(request.headers.authorization));
  });

  return app;
}

export function attachSocket(app: Awaited<ReturnType<typeof buildApp>>) {
  const io = new Server(app.server, { cors: { origin: true } });
  io.on("connection", (socket) => {
    socket.on("join", (payload: { sessionId?: string; token?: string }) => {
      if (!payload?.sessionId || !payload.token) return;
      socket.join(payload.sessionId);
    });
  });
  setRefreshHook((sessionId) => {
    io.to(sessionId).emit("refresh", { sessionId });
  });
  return io;
}
