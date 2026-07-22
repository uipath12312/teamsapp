import { Server, Socket } from "socket.io";
import { ChatPayload, JoinPayload, Participant } from "../types.js";
import {
  addParticipant,
  canJoin,
  endMeeting,
  getMeeting,
  getOrCreateMeeting,
  removeParticipant,
  serializeParticipants
} from "../utils/meetings.js";

type ServerSideSocket = Socket & {
  data: {
    meetingId?: string;
    participantId?: string;
  };
};

export function registerMeetingSocket(io: Server) {
  io.on("connection", (socket: ServerSideSocket) => {
    socket.on("meeting:join", (payload: JoinPayload, ack) => {
      const meetingId = sanitizeMeetingId(payload.meetingId);
      const name = payload.name?.trim().slice(0, 60);

      if (!meetingId || !name) {
        ack?.({ ok: false, reason: "INVALID_NAME" });
        return;
      }

      const existing = getMeeting(meetingId);
      const meeting = existing ?? getOrCreateMeeting(meetingId, socket.id);

      if (!canJoin(meeting)) {
        ack?.({ ok: false, reason: "ROOM_FULL" });
        return;
      }

      const participant: Participant = {
        id: socket.id,
        name,
        isHost: meeting.participants.size === 0 || (payload.createAsHost === true && meeting.hostId === socket.id),
        micOn: true,
        cameraOn: true,
        handRaised: false,
        joinedAt: Date.now()
      };

      if (participant.isHost) meeting.hostId = participant.id;
      addParticipant(meeting, participant);
      socket.data.meetingId = meeting.id;
      socket.data.participantId = participant.id;
      socket.join(meeting.id);

      ack?.({
        ok: true,
        participant,
        participants: serializeParticipants(meeting)
      });

      socket.to(meeting.id).emit("participant:joined", participant);
      io.to(meeting.id).emit("meeting:participants", serializeParticipants(meeting));
      io.to(meeting.id).emit("screen:state", { participantId: meeting.screenShareParticipantId });
    });

    socket.on("meeting:leave", () => leaveCurrentMeeting(io, socket));

    socket.on("meeting:end", () => {
      const meeting = getCurrentMeeting(socket);
      if (!meeting || meeting.hostId !== socket.id) return;
      endMeeting(meeting);
      io.to(meeting.id).emit("meeting:ended");
      io.in(meeting.id).socketsLeave(meeting.id);
    });

    socket.on("participant:update-state", (partial: Partial<Participant>) => {
      const meeting = getCurrentMeeting(socket);
      const participant = meeting?.participants.get(socket.id);
      if (!meeting || !participant) return;

      participant.micOn = typeof partial.micOn === "boolean" ? partial.micOn : participant.micOn;
      participant.cameraOn = typeof partial.cameraOn === "boolean" ? partial.cameraOn : participant.cameraOn;
      participant.handRaised = typeof partial.handRaised === "boolean" ? partial.handRaised : participant.handRaised;

      io.to(meeting.id).emit("participant:state", participant);
      io.to(meeting.id).emit("meeting:participants", serializeParticipants(meeting));
    });

    socket.on("participant:remove", ({ participantId }: { participantId: string }) => {
      const meeting = getCurrentMeeting(socket);
      if (!meeting || meeting.hostId !== socket.id || participantId === socket.id) return;
      io.to(participantId).emit("participant:removed");
      io.sockets.sockets.get(participantId)?.disconnect(true);
    });

    socket.on("screen:start", () => {
      const meeting = getCurrentMeeting(socket);
      if (!meeting) return;
      meeting.screenShareParticipantId = socket.id;
      io.to(meeting.id).emit("screen:state", { participantId: socket.id });
    });

    socket.on("screen:stop", () => {
      const meeting = getCurrentMeeting(socket);
      if (!meeting || meeting.screenShareParticipantId !== socket.id) return;
      meeting.screenShareParticipantId = null;
      io.to(meeting.id).emit("screen:state", { participantId: null });
    });

    socket.on("chat:message", (payload: ChatPayload) => {
      const meeting = getCurrentMeeting(socket);
      const participant = meeting?.participants.get(socket.id);
      const message = payload.message?.trim().slice(0, 1000);
      if (!meeting || !participant || !message) return;

      io.to(meeting.id).emit("chat:message", {
        id: crypto.randomUUID(),
        senderId: participant.id,
        senderName: participant.name,
        message,
        timestamp: Date.now()
      });
    });

    socket.on("signal:offer", (payload) => forwardSignal(socket, "signal:offer", payload));
    socket.on("signal:answer", (payload) => forwardSignal(socket, "signal:answer", payload));
    socket.on("signal:ice-candidate", (payload) => forwardSignal(socket, "signal:ice-candidate", payload));

    socket.on("disconnect", () => leaveCurrentMeeting(io, socket));
  });
}

function getCurrentMeeting(socket: ServerSideSocket) {
  return socket.data.meetingId ? getMeeting(socket.data.meetingId) : null;
}

function leaveCurrentMeeting(io: Server, socket: ServerSideSocket) {
  const meetingId = socket.data.meetingId;
  if (!meetingId) return;
  const meeting = getMeeting(meetingId);
  socket.leave(meetingId);
  socket.data.meetingId = undefined;
  socket.data.participantId = undefined;

  if (!meeting) return;
  const updatedMeeting = removeParticipant(meeting, socket.id);
  socket.to(meetingId).emit("participant:left", { participantId: socket.id });

  if (updatedMeeting) {
    io.to(meetingId).emit("meeting:participants", serializeParticipants(updatedMeeting));
    io.to(meetingId).emit("screen:state", { participantId: updatedMeeting.screenShareParticipantId });
  }
}

function forwardSignal(socket: ServerSideSocket, event: string, payload: { to?: string }) {
  if (!payload.to) return;
  socket.to(payload.to).emit(event, { ...payload, from: socket.id });
}

function sanitizeMeetingId(value: string) {
  return String(value ?? "").replace(/[^A-Za-z0-9-]/g, "").toUpperCase().slice(0, 32);
}
