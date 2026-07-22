export type Participant = {
  id: string;
  name: string;
  isHost: boolean;
  micOn: boolean;
  cameraOn: boolean;
  handRaised: boolean;
  joinedAt: number;
};

export type Meeting = {
  id: string;
  hostId: string;
  participants: Map<string, Participant>;
  createdAt: number;
  ended: boolean;
  screenShareParticipantId: string | null;
};

export type JoinPayload = {
  meetingId: string;
  name: string;
  createAsHost?: boolean;
};

export type ChatPayload = {
  message: string;
};
