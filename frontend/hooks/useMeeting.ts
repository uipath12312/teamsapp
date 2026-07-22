import { useRouter } from "next/router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { ChatMessage, JoinResult, Participant, RemoteStream } from "@/types/meeting";

type Options = {
  meetingId: string;
  displayName: string;
  isHostIntent: boolean;
};

type SignalPayload = {
  from: string;
  to: string;
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

// ICE servers: Google STUN + free Metered TURN servers
// Free TURN via Open Relay Project (no signup needed, rate-limited but works for small meetings)
const rtcConfig: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
    { urls: "stun:stun4.l.google.com:19302" },
    // Free TURN — Open Relay Project (openrelay.metered.ca)
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
  iceCandidatePoolSize: 10,
};

export function useMeeting({ meetingId, displayName, isHostIntent }: Options) {
  const router = useRouter();

  // ── stable refs ───────────────────────────────────────────────────────────
  const socketRef = useRef<Socket | null>(null);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  // Per-peer MediaStream accumulator — we build the remote stream here and push to state
  const remoteStreamsRef = useRef<Map<string, MediaStream>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const startTimeRef = useRef(0);
  const iceCandidateQueueRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const initRunningRef = useRef(false);

  // ── react state ───────────────────────────────────────────────────────────
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [localParticipant, setLocalParticipant] = useState<Participant | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<RemoteStream[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);
  const [isSharingScreen, setIsSharingScreen] = useState(false);
  const [screenShareParticipantId, setScreenShareParticipantId] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isRecordingPaused, setIsRecordingPaused] = useState(false);
  const [handRaised, setHandRaised] = useState(false);
  const [timer, setTimer] = useState("00:00");
  const [error, setError] = useState("");
  const [connectionStatus, setConnectionStatus] = useState<"connecting" | "connected" | "failed">("connecting");

  const signalingUrl = useMemo(
    () => process.env.NEXT_PUBLIC_SIGNALING_URL || "http://localhost:4000",
    []
  );

  // ── peer helpers ──────────────────────────────────────────────────────────

  const cleanupPeer = useCallback((participantId: string) => {
    console.log("[WebRTC] Cleaning up peer:", participantId);
    peersRef.current.get(participantId)?.close();
    peersRef.current.delete(participantId);
    remoteStreamsRef.current.delete(participantId);
    iceCandidateQueueRef.current.delete(participantId);
    setRemoteStreams((s) => s.filter((r) => r.participantId !== participantId));
  }, []);

  const replaceVideoTrack = useCallback((track: MediaStreamTrack | null) => {
    peersRef.current.forEach((peer, id) => {
      const sender = peer.getSenders().find((s) => s.track?.kind === "video");
      if (sender && track) {
        sender.replaceTrack(track).catch((e) =>
          console.error("[WebRTC] replaceTrack failed for", id, e)
        );
      }
    });
  }, []);

  const flushIceQueue = useCallback(async (participantId: string, peer: RTCPeerConnection) => {
    const queue = iceCandidateQueueRef.current.get(participantId);
    if (!queue?.length) return;
    console.log(`[WebRTC] Flushing ${queue.length} queued ICE candidates for`, participantId);
    for (const candidate of queue) {
      try {
        await peer.addIceCandidate(candidate);
      } catch (e) {
        console.error("[WebRTC] Failed to add queued ICE candidate:", e);
      }
    }
    iceCandidateQueueRef.current.delete(participantId);
  }, []);

  const createPeer = useCallback(
    (participantId: string): RTCPeerConnection => {
      const existing = peersRef.current.get(participantId);
      if (existing) return existing;

      console.log("[WebRTC] Creating peer connection to:", participantId);
      const socket = socketRef.current;
      const peer = new RTCPeerConnection(rtcConfig);
      peersRef.current.set(participantId, peer);

      // Create a MediaStream for this participant upfront
      // All incoming tracks will be added to this same stream object
      const remoteStream = new MediaStream();
      remoteStreamsRef.current.set(participantId, remoteStream);

      // Add local tracks to the peer
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => {
          console.log("[WebRTC] Adding local track:", track.kind, "to peer:", participantId);
          peer.addTrack(track, localStreamRef.current!);
        });
      } else {
        console.warn("[WebRTC] No local stream when creating peer for", participantId);
      }

      peer.onicecandidate = (event) => {
        if (event.candidate && socket) {
          console.log("[WebRTC] ICE candidate generated for:", participantId, event.candidate.type);
          socket.emit("signal:ice-candidate", {
            to: participantId,
            candidate: event.candidate,
          });
        } else if (!event.candidate) {
          console.log("[WebRTC] ICE gathering complete for:", participantId);
        }
      };

      peer.onicegatheringstatechange = () => {
        console.log("[WebRTC] ICE gathering state for", participantId, ":", peer.iceGatheringState);
      };

      peer.oniceconnectionstatechange = () => {
        console.log("[WebRTC] ICE connection state for", participantId, ":", peer.iceConnectionState);
        if (peer.iceConnectionState === "failed") {
          console.error("[WebRTC] ICE failed for", participantId, "— attempting restart");
          peer.restartIce();
        }
      };

      peer.onconnectionstatechange = () => {
        console.log("[WebRTC] Connection state for", participantId, ":", peer.connectionState);
        // Only clean up on truly terminal states — NOT on "disconnected" which is transient
        if (peer.connectionState === "failed" || peer.connectionState === "closed") {
          console.error("[WebRTC] Peer connection permanently failed for:", participantId);
          cleanupPeer(participantId);
        }
      };

      peer.onsignalingstatechange = () => {
        console.log("[WebRTC] Signaling state for", participantId, ":", peer.signalingState);
      };

      // BUG FIX: Use a single pre-created MediaStream and add all tracks to it.
      // This correctly handles audio + video arriving in separate ontrack events.
      peer.ontrack = (event) => {
        console.log(
          "[WebRTC] ontrack from:", participantId,
          "kind:", event.track.kind,
          "streams:", event.streams.length,
          "track.id:", event.track.id
        );

        // Always add the track to our per-participant MediaStream accumulator
        const stream = remoteStreamsRef.current.get(participantId)!;

        // Check if this track kind is already in the stream — replace if so
        const existingTrack = stream.getTracks().find((t) => t.kind === event.track.kind);
        if (existingTrack) {
          stream.removeTrack(existingTrack);
          console.log("[WebRTC] Replaced existing", event.track.kind, "track for:", participantId);
        }
        stream.addTrack(event.track);
        console.log(
          "[WebRTC] Stream for", participantId,
          "now has tracks:", stream.getTracks().map((t) => t.kind)
        );

        // Update React state — always replace the entry so VideoTile re-renders
        setRemoteStreams((prev) => {
          const next = prev.filter((r) => r.participantId !== participantId);
          return [...next, { participantId, stream }];
        });

        // Handle track ending (e.g. participant mutes camera)
        event.track.onended = () => {
          console.log("[WebRTC] Remote track ended:", event.track.kind, "from:", participantId);
        };
        event.track.onmute = () => {
          console.log("[WebRTC] Remote track muted:", event.track.kind, "from:", participantId);
        };
        event.track.onunmute = () => {
          console.log("[WebRTC] Remote track unmuted:", event.track.kind, "from:", participantId);
          // Force a state update so VideoTile picks up the unmuted track
          setRemoteStreams((prev) => {
            const next = prev.filter((r) => r.participantId !== participantId);
            return [...next, { participantId, stream }];
          });
        };
      };

      return peer;
    },
    [cleanupPeer]
  );

  const callParticipant = useCallback(
    async (participantId: string) => {
      const socket = socketRef.current;
      if (!socket) {
        console.warn("[WebRTC] Cannot call: no socket");
        return;
      }
      console.log("[WebRTC] Calling (making offer to):", participantId);
      const peer = createPeer(participantId);
      try {
        const offer = await peer.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true,
        });
        await peer.setLocalDescription(offer);
        socket.emit("signal:offer", { to: participantId, description: offer });
        console.log("[WebRTC] Offer sent to:", participantId);
      } catch (e) {
        console.error("[WebRTC] createOffer failed for:", participantId, e);
      }
    },
    [createPeer]
  );

  // ── main init effect ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!meetingId || !displayName) return;
    if (initRunningRef.current) return;
    initRunningRef.current = true;

    let cancelled = false;

    async function init() {
      // 1. Get local media
      let media: MediaStream;
      try {
        console.log("[Media] Requesting camera + microphone…");
        media = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            facingMode: "user",
          },
        });
        console.log("[Media] Granted:", media.getTracks().map((t) => `${t.kind}:${t.label}`));
      } catch (err: unknown) {
        initRunningRef.current = false;
        const name = err instanceof Error ? err.name : String(err);
        console.error("[Media] getUserMedia failed:", name, err);
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          setError("Camera or microphone permission was denied. Please allow access in your browser settings and refresh.");
        } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
          setError("No camera or microphone found. Please connect a device and refresh.");
        } else if (name === "NotReadableError" || name === "TrackStartError") {
          setError("Camera or microphone is already in use by another application.");
        } else {
          setError(`Could not access camera/microphone: ${name}`);
        }
        return;
      }

      if (cancelled) { media.getTracks().forEach((t) => t.stop()); return; }
      localStreamRef.current = media;
      setLocalStream(media);
      console.log("[Media] Local stream ready.");

      // 2. Connect Socket.IO
      console.log("[Socket] Connecting to:", signalingUrl);
      const socket = io(signalingUrl, {
        transports: ["websocket", "polling"],
        reconnectionAttempts: 10,
        reconnectionDelay: 1000,
        timeout: 15000,
      });
      socketRef.current = socket;

      socket.on("connect", () => {
        if (cancelled) return;
        console.log("[Socket] Connected. ID:", socket.id);
        setConnectionStatus("connected");
        setError("");

        socket.emit(
          "meeting:join",
          { meetingId, name: displayName, createAsHost: isHostIntent },
          (result: JoinResult) => {
            if (cancelled) return;
            console.log("[Socket] meeting:join ack:", JSON.stringify(result));
            if (!result.ok) {
              const msg =
                result.reason === "ROOM_FULL"
                  ? "This meeting is full."
                  : result.reason === "ENDED"
                  ? "This meeting has ended."
                  : "Unable to join. Please try again.";
              setError(msg);
              return;
            }
            setLocalParticipant(result.participant ?? null);
            setParticipants(result.participants ?? []);
            startTimeRef.current = Date.now();
            console.log("[Meeting] Joined. Room participants:", result.participants?.map((p) => p.name));
          }
        );
      });

      socket.on("connect_error", (err) => {
        console.error("[Socket] Connection error:", err.message);
        setConnectionStatus("failed");
        setError(`Cannot connect to signaling server. ${err.message}`);
      });

      socket.on("disconnect", (reason) => {
        console.warn("[Socket] Disconnected:", reason);
        if (reason !== "io client disconnect") {
          setError("Disconnected. Attempting to reconnect…");
        }
      });

      socket.on("reconnect", (attempt) => {
        console.log("[Socket] Reconnected after", attempt, "attempts.");
        setError("");
      });

      // Meeting events
      socket.on("meeting:participants", (items: Participant[]) => {
        console.log("[Meeting] Participant list update:", items.map((p) => p.name));
        setParticipants(items);
      });

      socket.on("meeting:ended", () => {
        setError("The host ended this meeting.");
        setTimeout(() => router.replace("/"), 1500);
      });

      socket.on("participant:joined", (participant: Participant) => {
        console.log("[Meeting] New participant joined:", participant.name, participant.id);
        setParticipants((prev) => upsertParticipant(prev, participant));
        // We (existing user) call the new participant
        callParticipant(participant.id).catch((e) =>
          console.error("[WebRTC] callParticipant error:", e)
        );
      });

      socket.on("participant:left", ({ participantId }: { participantId: string }) => {
        console.log("[Meeting] Participant left:", participantId);
        setParticipants((prev) => prev.filter((p) => p.id !== participantId));
        cleanupPeer(participantId);
        setScreenShareParticipantId((id) => (id === participantId ? null : id));
      });

      socket.on("participant:removed", () => {
        setError("You were removed from the meeting.");
        setTimeout(() => router.replace("/"), 1200);
      });

      socket.on("participant:state", (participant: Participant) => {
        setParticipants((prev) => upsertParticipant(prev, participant));
        if (participant.id === socket.id) {
          setLocalParticipant(participant);
          setHandRaised(participant.handRaised);
        }
      });

      socket.on("screen:state", ({ participantId }: { participantId: string | null }) => {
        setScreenShareParticipantId(participantId);
      });

      socket.on("chat:message", (message: ChatMessage) => {
        setChatMessages((prev) => [...prev, message]);
      });

      // WebRTC signaling
      socket.on("signal:offer", async ({ from, description }: SignalPayload) => {
        if (!description) return;
        console.log("[WebRTC] Received offer from:", from);

        // Guard: wait for local stream if needed
        if (!localStreamRef.current) {
          console.warn("[WebRTC] Waiting for local stream before handling offer from:", from);
          await new Promise<void>((resolve) => {
            const t = setInterval(() => { if (localStreamRef.current) { clearInterval(t); resolve(); } }, 50);
            setTimeout(() => { clearInterval(t); resolve(); }, 5000);
          });
        }

        const peer = createPeer(from);
        try {
          await peer.setRemoteDescription(new RTCSessionDescription(description));
          await flushIceQueue(from, peer);
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          socket.emit("signal:answer", { to: from, description: answer });
          console.log("[WebRTC] Answer sent to:", from);
        } catch (e) {
          console.error("[WebRTC] Failed to handle offer from", from, ":", e);
        }
      });

      socket.on("signal:answer", async ({ from, description }: SignalPayload) => {
        if (!description) return;
        console.log("[WebRTC] Received answer from:", from);
        const peer = peersRef.current.get(from);
        if (!peer) {
          console.warn("[WebRTC] No peer found for answer from:", from);
          return;
        }
        if (peer.signalingState === "stable") {
          console.warn("[WebRTC] Peer already stable, ignoring answer from:", from);
          return;
        }
        try {
          await peer.setRemoteDescription(new RTCSessionDescription(description));
          await flushIceQueue(from, peer);
        } catch (e) {
          console.error("[WebRTC] setRemoteDescription failed for answer from", from, ":", e);
        }
      });

      socket.on("signal:ice-candidate", async ({ from, candidate }: SignalPayload) => {
        if (!candidate) return;
        const peer = peersRef.current.get(from);

        if (!peer || !peer.remoteDescription) {
          // Queue it — peer or remote description not ready yet
          const queue = iceCandidateQueueRef.current.get(from) ?? [];
          queue.push(candidate);
          iceCandidateQueueRef.current.set(from, queue);
          console.log(`[WebRTC] Queued ICE candidate from ${from} (queue size: ${queue.length})`);
          return;
        }

        try {
          await peer.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.error("[WebRTC] addIceCandidate failed from", from, ":", e);
        }
      });
    }

    init();

    return () => {
      cancelled = true;
      initRunningRef.current = false;
      console.log("[Meeting] Cleanup triggered.");
      socketRef.current?.disconnect();
      socketRef.current = null;
      peersRef.current.forEach((peer) => peer.close());
      peersRef.current.clear();
      remoteStreamsRef.current.clear();
      iceCandidateQueueRef.current.clear();
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId, displayName]);

  // ── timer ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!localParticipant) return;
    startTimeRef.current = Date.now();
    const interval = window.setInterval(() => {
      const seconds = Math.floor((Date.now() - startTimeRef.current) / 1000);
      const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
      const secs = (seconds % 60).toString().padStart(2, "0");
      setTimer(`${mins}:${secs}`);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [localParticipant]);

  // ── actions ───────────────────────────────────────────────────────────────

  function emitState(partial: Partial<Participant>) {
    socketRef.current?.emit("participant:update-state", partial);
  }

  function toggleMic() {
    const next = !micOn;
    localStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = next));
    setMicOn(next);
    emitState({ micOn: next });
  }

  function toggleCamera() {
    const next = !cameraOn;
    localStreamRef.current?.getVideoTracks().forEach((t) => (t.enabled = next));
    setCameraOn(next);
    emitState({ cameraOn: next });
  }

  async function toggleScreenShare() {
    if (isSharingScreen) { stopScreenShare(); return; }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      screenStreamRef.current = stream;
      const [screenTrack] = stream.getVideoTracks();
      replaceVideoTrack(screenTrack);
      setIsSharingScreen(true);
      setScreenShareParticipantId(localParticipant?.id ?? null);
      socketRef.current?.emit("screen:start");
      screenTrack.onended = stopScreenShare;
    } catch (e) {
      console.error("[Screen] getDisplayMedia failed:", e);
      setError("Screen sharing was cancelled or is not supported.");
    }
  }

  function stopScreenShare() {
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    const cameraTrack = localStreamRef.current?.getVideoTracks()[0] ?? null;
    replaceVideoTrack(cameraTrack);
    setIsSharingScreen(false);
    setScreenShareParticipantId(null);
    socketRef.current?.emit("screen:stop");
  }

  function sendChat(message: string) {
    socketRef.current?.emit("chat:message", { message });
  }

  function startRecording() {
    const videoTracks = screenStreamRef.current?.getVideoTracks() ?? localStreamRef.current?.getVideoTracks() ?? [];
    const audioTracks = localStreamRef.current?.getAudioTracks() ?? [];
    const stream = new MediaStream([...videoTracks, ...audioTracks]);
    const mimeType = pickRecordingMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    chunksRef.current = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    recorder.onstop = () => downloadRecording(mimeType || "video/webm");
    recorder.start(1000);
    recorderRef.current = recorder;
    setIsRecording(true);
    setIsRecordingPaused(false);
  }

  function pauseRecording() {
    if (recorderRef.current?.state === "recording") { recorderRef.current.pause(); setIsRecordingPaused(true); }
  }

  function resumeRecording() {
    if (recorderRef.current?.state === "paused") { recorderRef.current.resume(); setIsRecordingPaused(false); }
  }

  function stopRecording() {
    recorderRef.current?.stop();
    setIsRecording(false);
    setIsRecordingPaused(false);
  }

  function downloadRecording(mimeType: string) {
    const blob = new Blob(chunksRef.current, { type: mimeType });
    const ext = mimeType.includes("mp4") ? "mp4" : "webm";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `meeting-${meetingId}-${Date.now()}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function toggleFullScreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    else document.documentElement.requestFullscreen().catch(() => undefined);
  }

  function toggleHand() {
    const next = !handRaised;
    setHandRaised(next);
    emitState({ handRaised: next });
  }

  function leaveMeeting() {
    socketRef.current?.emit("meeting:leave");
    router.replace("/");
  }

  function endMeeting() {
    socketRef.current?.emit("meeting:end");
  }

  function removeParticipant(participantId: string) {
    socketRef.current?.emit("participant:remove", { participantId });
  }

  const networkQuality =
    connectionStatus === "failed" ? "Disconnected" :
    remoteStreams.length >= 8 ? "Mesh load high" :
    "Network stable";

  return {
    localStream, remoteStreams, participants, localParticipant, chatMessages,
    micOn, cameraOn, isSharingScreen, screenShareParticipantId,
    isRecording, isRecordingPaused, handRaised, timer, error, networkQuality, connectionStatus,
    toggleMic, toggleCamera, toggleScreenShare, sendChat,
    startRecording, pauseRecording, resumeRecording, stopRecording,
    toggleFullScreen, toggleHand, leaveMeeting, endMeeting, removeParticipant,
  };
}

function upsertParticipant(participants: Participant[], participant: Participant) {
  const next = participants.filter((p) => p.id !== participant.id);
  return [...next, participant].sort((a, b) => a.joinedAt - b.joinedAt);
}

function pickRecordingMimeType(): string | undefined {
  const options = [
    "video/mp4;codecs=h264,aac",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return options.find((t) => MediaRecorder.isTypeSupported(t));
}
