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

  // ── stable refs (never cause re-renders) ──────────────────────────────────
  const socketRef = useRef<Socket | null>(null);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const startTimeRef = useRef(0);
  // Queue ICE candidates that arrive before the peer's remote description is set
  const iceCandidateQueueRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  // True while init() is running — prevents StrictMode double-invoke
  const initRunningRef = useRef(false);

  // ── react state ────────────────────────────────────────────────────────────
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

  // ── peer helpers ───────────────────────────────────────────────────────────

  const cleanupPeer = useCallback((participantId: string) => {
    console.log("[WebRTC] Cleaning up peer:", participantId);
    peersRef.current.get(participantId)?.close();
    peersRef.current.delete(participantId);
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

  /**
   * Flush any ICE candidates that were queued before the remote description
   * was set on this peer.
   */
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

  /**
   * Create a peer connection for a remote participant, adding local tracks.
   * Safe to call multiple times — returns existing connection if already created.
   */
  const createPeer = useCallback(
    (participantId: string): RTCPeerConnection => {
      const existing = peersRef.current.get(participantId);
      if (existing) return existing;

      console.log("[WebRTC] Creating peer connection to:", participantId);
      const socket = socketRef.current;
      const peer = new RTCPeerConnection(rtcConfig);
      peersRef.current.set(participantId, peer);

      // Add all local tracks
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => {
          console.log("[WebRTC] Adding local track to peer:", track.kind);
          peer.addTrack(track, localStreamRef.current!);
        });
      } else {
        console.warn("[WebRTC] No local stream when creating peer for", participantId);
      }

      peer.onicecandidate = (event) => {
        if (event.candidate && socket) {
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
        // Always use the first MediaStream from the event if available.
        // If not, we build one and add the track — then add subsequent tracks to it.
        let stream: MediaStream;
        if (event.streams && event.streams[0]) {
          stream = event.streams[0];
        } else {
          // Fallback: find existing remote stream for this participant and add the track,
          // or create a new MediaStream.
          const existing = peersRef.current.get(participantId);
          const existingRemote = (() => {
            // access the latest remote streams via setRemoteStreams callback trick
            let found: MediaStream | null = null;
            setRemoteStreams((prev) => {
              const match = prev.find((r) => r.participantId === participantId);
              if (match) {
                match.stream.addTrack(event.track);
                found = match.stream;
              }
              return prev; // no state change needed
            });
            return found;
          })();
          if (existingRemote) {
            console.log("[WebRTC] Added track to existing stream for", participantId);
            return; // stream already in state, no need to update
          }
          stream = new MediaStream();
          stream.addTrack(event.track);
          void existing; // suppress unused warning
        }

        setRemoteStreams((prev) => {
          const next = prev.filter((r) => r.participantId !== participantId);
          return [...next, { participantId, stream }];
        });
      };

      return peer;
    },
    [cleanupPeer]
  );

  /**
   * Create an offer and send it to a remote participant.
   * Called by existing participants when a new one joins.
   */
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

  // ── main init effect ───────────────────────────────────────────────────────

  useEffect(() => {
    if (!meetingId || !displayName) return;

    // Prevent StrictMode double-invoke: if init is already running, skip.
    // We use a running flag rather than a "completed" flag so that the cleanup
    // from the first StrictMode invocation correctly aborts the async work via
    // the `cancelled` variable, and the second invocation runs cleanly.
    if (initRunningRef.current) return;
    initRunningRef.current = true;

    let cancelled = false;

    async function init() {
      // ── 1. Acquire local media ────────────────────────────────────────────
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
        initRunningRef.current = false;
        const name = err instanceof Error ? err.name : String(err);
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          setError(
            "Camera or microphone permission was denied. Please allow access in your browser settings and refresh the page."
          );
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
      console.log("[Media] Local stream ready.");

      // ── 2. Connect Socket.IO ──────────────────────────────────────────────
      console.log("[Socket] Connecting to:", signalingUrl);
      const socket = io(signalingUrl, {
        transports: ["websocket", "polling"],
        reconnectionAttempts: 5,
        timeout: 10000,
      });
      socketRef.current = socket;

      // ── 3. All socket event handlers ──────────────────────────────────────
      // Registered once here so they capture the correct socket + stream refs.

      socket.on("connect", () => {
        if (cancelled) return;
        console.log("[Socket] Connected. Socket ID:", socket.id);
        setConnectionStatus("connected");
        setError("");

        // Join the meeting room immediately on connect
        console.log("[Socket] Emitting meeting:join…");
        socket.emit(
          "meeting:join",
          { meetingId, name: displayName, createAsHost: isHostIntent },
          (result: JoinResult) => {
            if (cancelled) return;
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
              "[Meeting] Joined. Participants:",
              result.participants?.map((p) => p.name)
            );
          }
        );
      });

      socket.on("connect_error", (err) => {
        console.error("[Socket] Connection error:", err.message);
        setConnectionStatus("failed");
        setError(
          `Cannot connect to the signaling server (${signalingUrl}). Make sure the backend is running.`
        );
      });

      socket.on("disconnect", (reason) => {
        console.warn("[Socket] Disconnected:", reason);
        if (reason !== "io client disconnect") {
          setError("Disconnected from server. Attempting to reconnect…");
        }
      });

      socket.on("reconnect", () => {
        console.log("[Socket] Reconnected.");
        setError("");
      });

      // ── Participant / meeting events ─────────────────────────────────────

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
        // Existing participant calls the new one — use the ref-captured version
        // so we always have the latest createPeer/socket available.
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

      // ── WebRTC signaling ─────────────────────────────────────────────────

      socket.on("signal:offer", async ({ from, description }: SignalPayload) => {
        if (!description) return;
        console.log("[WebRTC] Received offer from:", from);

        // Wait for local stream to be ready (it should always be ready by now,
        // but guard against the rare timing edge case)
        if (!localStreamRef.current) {
          console.warn("[WebRTC] Offer arrived before local stream. Waiting…");
          await new Promise<void>((resolve) => {
            const check = setInterval(() => {
              if (localStreamRef.current) {
                clearInterval(check);
                resolve();
              }
            }, 50);
            // Timeout after 3s to avoid hanging
            setTimeout(() => { clearInterval(check); resolve(); }, 3000);
          });
        }

        const peer = createPeer(from);
        try {
          await peer.setRemoteDescription(description);
          // Flush any ICE candidates that arrived before this remote description
          await flushIceQueue(from, peer);
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
        if (!peer) {
          console.warn("[WebRTC] Received answer but no peer found for", from);
          return;
        }
        if (peer.signalingState === "stable") {
          console.warn("[WebRTC] Received answer but peer is already stable for", from);
          return;
        }
        try {
          await peer.setRemoteDescription(description);
          // Flush queued ICE candidates
          await flushIceQueue(from, peer);
        } catch (e) {
          console.error("[WebRTC] Failed to set remote description from", from, e);
        }
      });

      socket.on("signal:ice-candidate", async ({ from, candidate }: SignalPayload) => {
        if (!candidate) return;
        const peer = peersRef.current.get(from);

        if (!peer || !peer.remoteDescription) {
          // Peer doesn't exist yet or has no remote description — queue the candidate
          const queue = iceCandidateQueueRef.current.get(from) ?? [];
          queue.push(candidate);
          iceCandidateQueueRef.current.set(from, queue);
          console.log(`[WebRTC] Queued ICE candidate from ${from} (peer not ready)`);
          return;
        }

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
      initRunningRef.current = false;
      console.log("[Meeting] Cleanup.");
      socketRef.current?.disconnect();
      socketRef.current = null;
      peersRef.current.forEach((peer) => peer.close());
      peersRef.current.clear();
      iceCandidateQueueRef.current.clear();
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId, displayName]);
  // Intentionally minimal deps: meetingId + displayName are the triggers.
  // callParticipant, createPeer, cleanupPeer, flushIceQueue are stable useCallback refs.
  // signalingUrl, isHostIntent are read at call time from closure — stable after init.

  // ── timer ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!startTimeRef.current) return; // don't start until meeting:join ack
    const interval = window.setInterval(() => {
      const seconds = Math.floor((Date.now() - startTimeRef.current) / 1000);
      const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
      const secs = (seconds % 60).toString().padStart(2, "0");
      setTimer(`${mins}:${secs}`);
    }, 1000);
    return () => window.clearInterval(interval);
  }, []);

  // Start the timer once the meeting is joined (localParticipant set)
  useEffect(() => {
    if (!localParticipant) return;
    startTimeRef.current = Date.now();
  }, [localParticipant]);

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
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
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

// ── module-level helpers ───────────────────────────────────────────────────────

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
