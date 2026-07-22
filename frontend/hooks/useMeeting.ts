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

const rtcConfig: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:global.stun.twilio.com:3478" },
  ],
};

export function useMeeting({ meetingId, displayName, isHostIntent }: Options) {
  const router = useRouter();
  const socketRef = useRef<Socket | null>(null);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const startTimeRef = useRef(Date.now());
  // track whether we have already initialised to avoid double-init in strict mode
  const initialisedRef = useRef(false);

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

  const createPeer = useCallback(
    (participantId: string): RTCPeerConnection => {
      const existing = peersRef.current.get(participantId);
      if (existing) return existing;

      console.log("[WebRTC] Creating peer connection to:", participantId);
      const socket = socketRef.current;
      const peer = new RTCPeerConnection(rtcConfig);
      peersRef.current.set(participantId, peer);

      // Add all local tracks to the peer
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => {
          console.log("[WebRTC] Adding local track to peer:", track.kind);
          peer.addTrack(track, localStreamRef.current as MediaStream);
        });
      } else {
        console.warn("[WebRTC] No local stream when creating peer for", participantId);
      }

      peer.onicecandidate = (event) => {
        if (event.candidate && socket) {
          console.log("[WebRTC] Sending ICE candidate to:", participantId);
          socket.emit("signal:ice-candidate", {
            to: participantId,
            candidate: event.candidate,
          });
        }
      };

      peer.oniceconnectionstatechange = () => {
        console.log("[WebRTC] ICE state for", participantId, ":", peer.iceConnectionState);
      };

      peer.onconnectionstatechange = () => {
        console.log("[WebRTC] Connection state for", participantId, ":", peer.connectionState);
        if (["failed", "disconnected", "closed"].includes(peer.connectionState)) {
          cleanupPeer(participantId);
        }
      };

      peer.ontrack = (event) => {
        console.log("[WebRTC] Received remote track from:", participantId, event.track.kind);
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        setRemoteStreams((prev) => {
          const next = prev.filter((r) => r.participantId !== participantId);
          return [...next, { participantId, stream }];
        });
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
      console.log("[WebRTC] Calling participant:", participantId);
      const peer = createPeer(participantId);
      try {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        socket.emit("signal:offer", { to: participantId, description: offer });
        console.log("[WebRTC] Offer sent to:", participantId);
      } catch (e) {
        console.error("[WebRTC] createOffer failed:", e);
      }
    },
    [createPeer]
  );

  // ── main init effect ──────────────────────────────────────────────────────

  useEffect(() => {
    // Guard: both values must be non-empty strings
    if (!meetingId || !displayName) return;

    // Prevent double-init (React StrictMode double-invokes effects in dev)
    if (initialisedRef.current) return;
    initialisedRef.current = true;

    let cancelled = false;
    console.log("[Meeting] Initialising. meetingId:", meetingId, "displayName:", displayName);

    async function init() {
      // ── 1. Acquire local media ──────────────────────────────────────────
      let media: MediaStream;
      try {
        console.log("[Media] Requesting camera + microphone…");
        media = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        });
        console.log(
          "[Media] Granted. Tracks:",
          media.getTracks().map((t) => `${t.kind}:${t.label}`)
        );
      } catch (err: unknown) {
        console.error("[Media] getUserMedia failed:", err);
        const name = err instanceof Error ? err.name : String(err);
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          setError("Camera or microphone permission was denied. Please allow access in your browser settings and refresh the page.");
        } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
          setError("No camera or microphone found. Please connect a device and refresh.");
        } else if (name === "NotReadableError" || name === "TrackStartError") {
          setError("Camera or microphone is already in use by another application.");
        } else {
          setError(`Could not access camera/microphone: ${name}`);
        }
        return;
      }

      if (cancelled) {
        media.getTracks().forEach((t) => t.stop());
        return;
      }

      localStreamRef.current = media;
      setLocalStream(media);
      console.log("[Media] Local stream stored and state updated.");

      // ── 2. Connect Socket.IO ────────────────────────────────────────────
      console.log("[Socket] Connecting to:", signalingUrl);
      const socket = io(signalingUrl, {
        transports: ["websocket", "polling"],
        reconnectionAttempts: 5,
        timeout: 10000,
      });
      socketRef.current = socket;

      socket.on("connect", () => {
        console.log("[Socket] Connected. Socket ID:", socket.id);
        setConnectionStatus("connected");
        setError(""); // clear any previous connection error

        // ── 3. Join the meeting room ──────────────────────────────────────
        console.log("[Socket] Emitting meeting:join…");
        socket.emit(
          "meeting:join",
          { meetingId, name: displayName, createAsHost: isHostIntent },
          (result: JoinResult) => {
            console.log("[Socket] meeting:join ack:", result);
            if (!result.ok) {
              if (result.reason === "ROOM_FULL") {
                setError("This meeting is full (maximum participants reached).");
              } else if (result.reason === "ENDED") {
                setError("This meeting has already ended.");
              } else {
                setError("Unable to join this meeting. Please try again.");
              }
              return;
            }
            setLocalParticipant(result.participant ?? null);
            setParticipants(result.participants ?? []);
            startTimeRef.current = Date.now();
            console.log(
              "[Meeting] Joined successfully. Participants:",
              result.participants?.map((p) => p.name)
            );
          }
        );
      });

      socket.on("connect_error", (err) => {
        console.error("[Socket] Connection error:", err.message);
        setConnectionStatus("failed");
        setError(`Cannot connect to the signaling server (${signalingUrl}). Make sure the backend is running.`);
      });

      socket.on("disconnect", (reason) => {
        console.warn("[Socket] Disconnected:", reason);
        if (reason !== "io client disconnect") {
          setError("Disconnected from the server. Attempting to reconnect…");
        }
      });

      socket.on("reconnect", () => {
        console.log("[Socket] Reconnected.");
        setError("");
      });

      // ── 4. Meeting / participant events ───────────────────────────────

      socket.on("meeting:participants", (items: Participant[]) => {
        console.log("[Meeting] participants update:", items.map((p) => p.name));
        setParticipants(items);
      });

      socket.on("meeting:ended", () => {
        console.log("[Meeting] Host ended the meeting.");
        setError("The host ended this meeting.");
        setTimeout(() => router.replace("/"), 1500);
      });

      socket.on("participant:joined", (participant: Participant) => {
        console.log("[Meeting] Participant joined:", participant.name, participant.id);
        setParticipants((prev) => upsertParticipant(prev, participant));
        // Existing participant calls the new one
        callParticipant(participant.id).catch((e) =>
          console.error("[WebRTC] callParticipant failed:", e)
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

      // ── 5. WebRTC signaling ───────────────────────────────────────────

      socket.on("signal:offer", async ({ from, description }: SignalPayload) => {
        if (!description) return;
        console.log("[WebRTC] Received offer from:", from);
        const peer = createPeer(from);
        try {
          await peer.setRemoteDescription(description);
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          socket.emit("signal:answer", { to: from, description: answer });
          console.log("[WebRTC] Sent answer to:", from);
        } catch (e) {
          console.error("[WebRTC] Failed to handle offer from", from, e);
        }
      });

      socket.on("signal:answer", async ({ from, description }: SignalPayload) => {
        if (!description) return;
        console.log("[WebRTC] Received answer from:", from);
        const peer = peersRef.current.get(from);
        if (peer && peer.signalingState !== "stable") {
          try {
            await peer.setRemoteDescription(description);
          } catch (e) {
            console.error("[WebRTC] Failed to set remote description from", from, e);
          }
        }
      });

      socket.on("signal:ice-candidate", async ({ from, candidate }: SignalPayload) => {
        if (!candidate) return;
        const peer = createPeer(from);
        try {
          await peer.addIceCandidate(candidate);
        } catch (e) {
          console.error("[WebRTC] Failed to add ICE candidate from", from, e);
        }
      });
    }

    init();

    return () => {
      cancelled = true;
      initialisedRef.current = false;
      console.log("[Meeting] Cleanup.");
      socketRef.current?.disconnect();
      socketRef.current = null;
      peersRef.current.forEach((peer) => peer.close());
      peersRef.current.clear();
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId, displayName]);
  // NOTE: intentionally minimal deps — callParticipant/createPeer/cleanupPeer are
  // stable callbacks but including them causes the effect to re-run and double-init.
  // The refs they read (localStreamRef, socketRef, peersRef) are always current.

  // ── timer ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    const interval = window.setInterval(() => {
      const seconds = Math.floor((Date.now() - startTimeRef.current) / 1000);
      const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
      const secs = (seconds % 60).toString().padStart(2, "0");
      setTimer(`${mins}:${secs}`);
    }, 1000);
    return () => window.clearInterval(interval);
  }, []);

  // ── actions ────────────────────────────────────────────────────────────────

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
    if (isSharingScreen) {
      stopScreenShare();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      screenStreamRef.current = stream;
      const [screenTrack] = stream.getVideoTracks();
      replaceVideoTrack(screenTrack);
      setIsSharingScreen(true);
      setScreenShareParticipantId(localParticipant?.id ?? null);
      socketRef.current?.emit("screen:start");
      screenTrack.onended = stopScreenShare;
    } catch {
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
    const videoTracks =
      screenStreamRef.current?.getVideoTracks() ??
      localStreamRef.current?.getVideoTracks() ??
      [];
    const audioTracks = localStreamRef.current?.getAudioTracks() ?? [];
    const stream = new MediaStream([...videoTracks, ...audioTracks]);
    const mimeType = pickRecordingMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => downloadRecording(mimeType || "video/webm");
    recorder.start(1000);
    recorderRef.current = recorder;
    setIsRecording(true);
    setIsRecordingPaused(false);
  }

  function pauseRecording() {
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.pause();
      setIsRecordingPaused(true);
    }
  }

  function resumeRecording() {
    if (recorderRef.current?.state === "paused") {
      recorderRef.current.resume();
      setIsRecordingPaused(false);
    }
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
    remoteStreams.length >= 8
      ? "Mesh load high"
      : connectionStatus === "failed"
      ? "Disconnected"
      : "Network stable";

  return {
    localStream,
    remoteStreams,
    participants,
    localParticipant,
    chatMessages,
    micOn,
    cameraOn,
    isSharingScreen,
    screenShareParticipantId,
    isRecording,
    isRecordingPaused,
    handRaised,
    timer,
    error,
    networkQuality,
    connectionStatus,
    toggleMic,
    toggleCamera,
    toggleScreenShare,
    sendChat,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    toggleFullScreen,
    toggleHand,
    leaveMeeting,
    endMeeting,
    removeParticipant,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

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
