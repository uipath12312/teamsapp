export type Participant = {
  id: string;
  name: string;
  isHost: boolean;
  micOn: boolean;
  cameraOn: boolean;
  handRaised: boolean;
  joinedAt: number;
};

export type ChatMessage = {
  id: string;
  senderId: string;
  senderName: string;
  message: string;
  timestamp: number;
};

export type RemoteStream = {
  participantId: string;
  stream: MediaStream;
};

export type JoinResult = {
  ok: boolean;
  reason?: "ROOM_FULL" | "ENDED" | "INVALID_NAME";
  participant?: Participant;
  participants?: Participant[];
};
