# Architecture Documentation

Guest Video Meet is split into two deployable applications:

- `frontend`: Next.js, TypeScript, Tailwind CSS, WebRTC, MediaRecorder
- `backend`: Node.js, Express, Socket.IO

## Media Path

Media is peer-to-peer. The backend never receives camera, microphone, recording, or screen-share media.

Each browser creates one `RTCPeerConnection` per remote participant. With five participants, each browser can have up to four peer connections.

## Signaling Path

Socket.IO events are used for:

- Joining and leaving meetings
- Participant state
- Chat messages
- Host end meeting
- Screen-share state
- WebRTC offers
- WebRTC answers
- ICE candidates

## Room State

Room state is held in process memory:

- Meeting ID
- Host socket ID
- Participants
- Screen-share participant
- Created timestamp

This keeps deployment free and simple. A backend restart clears active meetings.

## Security Model

The app uses guest access only. Meeting IDs are generated with browser cryptographic randomness and are not listed publicly by the frontend. CORS restricts Socket.IO access to the configured frontend origin.

No identity claims are persisted. Host permissions are scoped to the socket that created the room or the first socket present in the room.
