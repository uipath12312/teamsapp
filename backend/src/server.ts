import "dotenv/config";
import cors from "cors";
import express, { Request, Response } from "express";
import helmet from "helmet";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { registerMeetingSocket } from "./socket/meetingSocket.js";
import { listMeetings, getMaxParticipantsConfig } from "./utils/meetings.js";

const port = Number(process.env.PORT || 4000);

// Accept multiple origins separated by comma, or a wildcard "*"
const rawOrigin = process.env.CLIENT_ORIGIN || "http://localhost:3000";
const allowedOrigins: string[] | string =
  rawOrigin === "*"
    ? "*"
    : rawOrigin.split(",").map((o) => o.trim());

function originAllowed(origin: string | undefined): boolean {
  if (allowedOrigins === "*") return true;
  if (!origin) return true; // same-origin / non-browser requests
  return (allowedOrigins as string[]).includes(origin);
}

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (originAllowed(origin)) {
      callback(null, true);
    } else {
      console.warn("[CORS] Blocked origin:", origin);
      callback(new Error(`Origin ${origin} not allowed`));
    }
  },
  methods: ["GET", "POST", "OPTIONS"],
  credentials: true,
};

const app = express();
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    maxParticipants: getMaxParticipantsConfig(),
    allowedOrigins,
  });
});

app.get("/meetings", (_req: Request, res: Response) => {
  res.json({ meetings: listMeetings() });
});

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
  // longer ping timeout for slower networks
  pingTimeout: 30000,
  pingInterval: 10000,
});

registerMeetingSocket(io);

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`[Server] Signaling server listening on 0.0.0.0:${port}`);
  console.log(`[Server] Allowed origins:`, allowedOrigins);
  console.log(`[Server] Max participants: ${process.env.MAX_PARTICIPANTS || 10}`);
});
