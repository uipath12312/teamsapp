import { Meeting, Participant } from "../types.js";
import { canCreateNewMeeting } from "./adminState.js";

const meetings = new Map<string, Meeting>();

// Read at call time — not at module load — so Render env vars are always present
function getMaxParticipants(): number {
  return Number(process.env.MAX_PARTICIPANTS || 10);
}

function getTtlMs(): number {
  return Number(process.env.MEETING_TTL_MINUTES || 360) * 60 * 1000;
}

export function getMeeting(meetingId: string) {
  const meeting = meetings.get(meetingId);
  if (!meeting) return null;
  if (meeting.ended || Date.now() - meeting.createdAt > getTtlMs()) {
    meetings.delete(meetingId);
    return null;
  }
  return meeting;
}

export function getOrCreateMeeting(meetingId: string, hostId: string) {
  const existing = getMeeting(meetingId);
  if (existing) return existing;

  const meeting: Meeting = {
    id: meetingId,
    hostId,
    participants: new Map(),
    createdAt: Date.now(),
    ended: false,
    screenShareParticipantId: null
  };
  meetings.set(meetingId, meeting);
  return meeting;
}

export function canJoin(meeting: Meeting) {
  return !meeting.ended && meeting.participants.size < getMaxParticipants();
}

/** Check both participant limit and admin-level meeting creation controls. */
export function canCreateMeeting(): boolean {
  const active = [...meetings.values()].filter((m) => !m.ended).length;
  return canCreateNewMeeting(active);
}

/** Returns total number of active (non-ended) meetings. */
export function activeMeetingCount(): number {
  return [...meetings.values()].filter((m) => !m.ended).length;
}

export function addParticipant(meeting: Meeting, participant: Participant) {
  meeting.participants.set(participant.id, participant);
}

export function removeParticipant(meeting: Meeting, participantId: string) {
  meeting.participants.delete(participantId);
  if (meeting.screenShareParticipantId === participantId) {
    meeting.screenShareParticipantId = null;
  }

  if (meeting.participants.size === 0) {
    meetings.delete(meeting.id);
    return null;
  }

  if (meeting.hostId === participantId) {
    const nextHost = [...meeting.participants.values()][0];
    nextHost.isHost = true;
    meeting.hostId = nextHost.id;
  }

  return meeting;
}

export function serializeParticipants(meeting: Meeting) {
  return [...meeting.participants.values()].sort((a, b) => a.joinedAt - b.joinedAt);
}

export function endMeeting(meeting: Meeting) {
  meeting.ended = true;
  meetings.delete(meeting.id);
}

export function listMeetings() {
  return [...meetings.values()].map((meeting) => ({
    id: meeting.id,
    participants: meeting.participants.size,
    participantNames: [...meeting.participants.values()].map((p) => p.name),
    createdAt: meeting.createdAt,
    durationSeconds: Math.floor((Date.now() - meeting.createdAt) / 1000),
    screenSharing: meeting.screenShareParticipantId !== null,
  }));
}

/** End every active meeting — called by admin "End All". */
export function endAllMeetings(): string[] {
  const ids: string[] = [];
  for (const [id, meeting] of meetings.entries()) {
    if (!meeting.ended) {
      meeting.ended = true;
      ids.push(id);
    }
  }
  meetings.clear();
  return ids;
}

/** Remove meetings that have no participants and are not active. */
export function clearInactiveMeetings(): number {
  let count = 0;
  for (const [id, meeting] of meetings.entries()) {
    if (meeting.ended || meeting.participants.size === 0) {
      meetings.delete(id);
      count++;
    }
  }
  return count;
}

/** Get a single meeting by ID for admin view. */
export function getMeetingById(meetingId: string): Meeting | null {
  return meetings.get(meetingId) ?? null;
}

// Exported so the health endpoint can report the current configured limit
export function getMaxParticipantsConfig(): number {
  return getMaxParticipants();
}
