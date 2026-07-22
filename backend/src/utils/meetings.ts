import { Meeting, Participant } from "../types.js";

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
    createdAt: meeting.createdAt
  }));
}

// Exported so the health endpoint can report the current configured limit
export function getMaxParticipantsConfig(): number {
  return getMaxParticipants();
}
