import "dotenv/config";
import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { registerMeetingSocket } from "./socket/meetingSocket.js";
import {
  listMeetings,
  getMaxParticipantsConfig,
  endAllMeetings,
  clearInactiveMeetings,
  endMeeting,
  getMeetingById,
  activeMeetingCount,
} from "./utils/meetings.js";
import {
  getAdminState,
  setMaxActiveMeetings,
  setMaintenanceMode,
} from "./utils/adminState.js";

const port = Number(process.env.PORT || 4000);

const rawOrigin = process.env.CLIENT_ORIGIN || "http://localhost:3000";
const allowedOrigins: string[] | string =
  rawOrigin === "*" ? "*" : rawOrigin.split(",").map((o) => o.trim());

function originAllowed(origin: string | undefined): boolean {
  if (allowedOrigins === "*") return true;
  if (!origin) return true;
  return (allowedOrigins as string[]).includes(origin);
}

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (originAllowed(origin)) callback(null, true);
    else { console.warn("[CORS] Blocked:", origin); callback(new Error(`Origin ${origin} not allowed`)); }
  },
  methods: ["GET", "POST", "DELETE", "PATCH", "OPTIONS"],
  credentials: true,
};

const app = express();
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());

// ── Admin auth middleware ──────────────────────────────────────────────────
// Credentials are read from env ONLY — never exposed to frontend.
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const adminUser = process.env.ADMIN_USERNAME || "admin";
  const adminPass = process.env.ADMIN_PASSWORD || "";

  if (!adminPass) {
    res.status(503).json({ error: "Admin not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD env vars." });
    return;
  }

  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="TeamsApp Admin"');
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  const user = decoded.slice(0, colon);
  const pass = decoded.slice(colon + 1);

  if (user !== adminUser || pass !== adminPass) {
    res.setHeader("WWW-Authenticate", 'Basic realm="TeamsApp Admin"');
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  next();
}

// ── Public endpoints ──────────────────────────────────────────────────────
app.get("/health", (_req: Request, res: Response) => {
  const adminState = getAdminState();
  res.json({
    ok: true,
    uptime: Math.floor(process.uptime()),
    maxParticipants: getMaxParticipantsConfig(),
    maxActiveMeetings: adminState.maxActiveMeetings,
    maintenanceMode: adminState.maintenanceMode,
    activeMeetings: activeMeetingCount(),
    allowedOrigins,
  });
});

// ── Admin API endpoints ───────────────────────────────────────────────────
// GET /api/admin/status — full dashboard data
app.get("/api/admin/status", requireAdmin, (_req: Request, res: Response) => {
  const adminState = getAdminState();
  const meetingList = listMeetings();
  const totalParticipants = meetingList.reduce((sum, m) => sum + m.participants, 0);
  res.json({
    uptime: Math.floor(process.uptime()),
    activeMeetings: meetingList.length,
    totalParticipants,
    maxParticipantsPerMeeting: getMaxParticipantsConfig(),
    maxActiveMeetings: adminState.maxActiveMeetings,
    maintenanceMode: adminState.maintenanceMode,
    meetings: meetingList,
  });
});

// DELETE /api/admin/meetings/:id — end a specific meeting
app.delete("/api/admin/meetings/:id", requireAdmin, (req: Request, res: Response) => {
  const meeting = getMeetingById(req.params.id);
  if (!meeting) { res.status(404).json({ error: "Meeting not found" }); return; }
  endMeeting(meeting);
  // Notify participants via Socket.IO — ioRef is set after server starts
  ioRef?.to(req.params.id).emit("meeting:ended");
  ioRef?.in(req.params.id).socketsLeave(req.params.id);
  console.log("[Admin] Ended meeting:", req.params.id);
  res.json({ ok: true, message: `Meeting ${req.params.id} ended.` });
});

// DELETE /api/admin/meetings — end ALL meetings
app.delete("/api/admin/meetings", requireAdmin, (_req: Request, res: Response) => {
  const ended = endAllMeetings();
  ended.forEach((id) => {
    ioRef?.to(id).emit("meeting:ended");
    ioRef?.in(id).socketsLeave(id);
  });
  console.log("[Admin] Ended all meetings:", ended.length);
  res.json({ ok: true, message: `Ended ${ended.length} meeting(s).`, ended });
});

// POST /api/admin/clear — remove empty / inactive meetings
app.post("/api/admin/clear", requireAdmin, (_req: Request, res: Response) => {
  const count = clearInactiveMeetings();
  console.log("[Admin] Cleared", count, "inactive meetings.");
  res.json({ ok: true, message: `Cleared ${count} inactive meeting(s).` });
});

// PATCH /api/admin/config — update max meetings limit or maintenance mode
app.patch("/api/admin/config", requireAdmin, (req: Request, res: Response) => {
  const { maxActiveMeetings, maintenanceMode } = req.body as {
    maxActiveMeetings?: number;
    maintenanceMode?: boolean;
  };

  if (typeof maxActiveMeetings === "number") {
    setMaxActiveMeetings(maxActiveMeetings);
    console.log("[Admin] maxActiveMeetings set to:", maxActiveMeetings);
  }

  if (typeof maintenanceMode === "boolean") {
    setMaintenanceMode(maintenanceMode);
    console.log("[Admin] maintenanceMode set to:", maintenanceMode);
  }

  res.json({ ok: true, config: getAdminState() });
});

// ── Socket.IO setup ───────────────────────────────────────────────────────
const httpServer = createServer(app);
let ioRef: Server | null = null;

const io = new Server(httpServer, {
  cors: { origin: allowedOrigins, methods: ["GET", "POST"], credentials: true },
  pingTimeout: 30000,
  pingInterval: 10000,
});
ioRef = io;

registerMeetingSocket(io);

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`[Server] Listening on 0.0.0.0:${port}`);
  console.log(`[Server] Allowed origins:`, allowedOrigins);
  console.log(`[Server] Max participants/meeting: ${process.env.MAX_PARTICIPANTS || 10}`);
  console.log(`[Server] Max active meetings: ${process.env.MAX_ACTIVE_MEETINGS || "unlimited"}`);
  console.log(`[Server] Admin: ${process.env.ADMIN_USERNAME ? "configured" : "NOT CONFIGURED"}`);
});
