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
    // Google STUN — fast, always available
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    // Free TURN via Metered (more reliable than openrelay, 50 GB/month free)
    // These credentials are public/shared — fine for small meetings
    { urls: "turn:a.relay.metered.ca:80",     username: "free",    credential: "free" },
    { urls: "turn:a.relay.metered.ca:80?transport=tcp", username: "free", credential: "free" },
    { urls: "turn:a.relay.metered.ca:443",    username: "free",    credential: "free" },
    { urls: "turns:a.relay.metered.ca:443",   username: "free",    credential: "free" },
    // Fallback: Open Relay (kept as secondary)
    { urls: "turn:openrelay.metered.ca:443",  username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
  ],
  iceCandidatePoolSize: 10,
  bundlePolicy: "max-bundle",  // bundle all media onto one transport — reduces ICE complexity
  rtcpMuxPolicy: "require",    // require RTCP mux — modern browsers all support this
};

/**
 * Acquire local media with graceful fallbacks.
 * Priority: audio > video > nothing. Meeting is NEVER blocked.
 * Tries audio first (fastest, most important), then adds video.
 */
async function acquireMedia(): Promise<{ stream: MediaStream; hasVideo: boolean; hasAudio: boolean }> {
  let audioTrack: MediaStreamTrack | null = null;
  let videoTrack: MediaStreamTrack | null = null;

  // Step 1: Always try audio first — it's the highest priority
  try {
    const audioStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    audioTrack = audioStream.getAudioTracks()[0] ?? null;
    console.log("[Media] Audio track acquired:", audioTrack?.label);
  } catch (e) {
    console.warn("[Media] Audio unavailable:", (e as Error).name);
  }

  // Step 2: Try video separately — don't let video failure block audio
  try {
    const videoStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
    });
    videoTrack = videoStream.getVideoTracks()[0] ?? null;
    console.log("[Media] Video track acquired:", videoTrack?.label);
  } catch (e) {
    console.warn("[Media] Video unavailable:", (e as Error).name);
  }

  // Build a combined stream from whatever we got
  const stream = new MediaStream();
  if (audioTrack) stream.addTrack(audioTrack);
  if (videoTrack) stream.addTrack(videoTrack);

  const hasAudio = audioTrack !== null;
  const hasVideo = videoTrack !== null;

  if (!hasAudio && !hasVideo) {
    console.warn("[Media] No media available — joining without camera or microphone.");
  } else {
    console.log("[Media] Ready. audio:", hasAudio, "video:", hasVideo);
  }

  return { stream, hasVideo, hasAudio };
}

export function useMeeting({ meetingId, displayName, isHostIntent }: Options) {
  const router = useRouter();

  const socketRef = useRef<Socket | null>(null);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const remoteStreamsRef = useRef<Map<string, MediaStream>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const iceCandidateQueueRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const initRunningRef = useRef(false);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [localParticipant, setLocalParticipant] = useState<Participant | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<RemoteStream[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [micOn, setMicOn] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [isSharingScreen, setIsSharingScreen] = useState(false);
  const [screenShareParticipantId, setScreenShareParticipantId] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isRecordingPaused, setIsRecordingPaused] = useState(false);
  const [handRaised, setHandRaised] = useState(false);
  const [timer, setTimer] = useState("00:00");
  const [error, setError] = useState("");
  const [mediaInfo, setMediaInfo] = useState("");
  const [connectionStatus, setConnectionStatus] = useState<"connecting" | "connected" | "failed">("connecting");

  const signalingUrl = useMemo(
    () => process.env.NEXT_PUBLIC_SIGNALING_URL || "http://localhost:4000",
    []
  );

  const cleanupPeer = useCallback((participantId: string) => {
    console.log("[WebRTC] Cleaning up peer:", participantId);
    peersRef.current.get(participantId)?.close();
    peersRef.current.delete(participantId);
    remoteStreamsRef.current.delete(participantId);
    iceCandidateQueueRef.current.delete(participantId);
    setRemoteStreams((s) => s.filter((r) => r.participantId !== participantId));
  }, []);

  /**
   * Replace a track kind (video or audio) in ALL active peer connections.
   * Pass null to clear the sender track (mute without stopping hardware).
   * Pass a track to replace (used for camera on/off and screen share).
   */
  const replaceTrackInPeers = useCallback(async (kind: "video" | "audio", track: MediaStreamTrack | null) => {
    const promises = Array.from(peersRef.current.entries()).map(async ([id, peer]) => {
      // Find an existing sender for this track kind (including null/stopped tracks)
      const sender = peer.getSenders().find((s) => {
        if (s.track?.kind === kind) return true;
        if (s.track === null) {
          // A null-track sender exists — check if it was originally for this kind
          // by checking if we can match via the track kind we're replacing
          return kind === "video"; // null senders are almost always video after stop()
        }
        return false;
      });

      if (sender) {
        try {
          await sender.replaceTrack(track);
          console.log(`[WebRTC] replaceTrack(${kind}) in peer ${id}: ${track?.kind ?? "null"}`);
        } catch (e) {
          console.error(`[WebRTC] replaceTrack(${kind}) failed for ${id}:`, e);
        }
      } else if (track && localStreamRef.current) {
        // No sender at all for this kind — add a brand new track
        try {
          peer.addTrack(track, localStreamRef.current);
          console.log(`[WebRTC] addTrack(${kind}) to peer ${id} (no prior sender)`);
        } catch (e) {
          console.error(`[WebRTC] addTrack(${kind}) failed for ${id}:`, e);
        }
      }
    });
    await Promise.all(promises);
  }, []);

  const flushIceQueue = useCallback(async (participantId: string, peer: RTCPeerConnection) => {
    const queue = iceCandidateQueueRef.current.get(participantId);
    if (!queue?.length) return;
    console.log(`[WebRTC] Flushing ${queue.length} queued ICE candidates for`, participantId);
    for (const candidate of queue) {
      try { await peer.addIceCandidate(candidate); } catch (e) { console.error("[WebRTC] queued ICE failed:", e); }
    }
    iceCandidateQueueRef.current.delete(participantId);
  }, []);

  const createPeer = useCallback((participantId: string): RTCPeerConnection => {
    const existing = peersRef.current.get(participantId);
    if (existing) return existing;

    console.log("[WebRTC] Creating peer:", participantId);
    const socket = socketRef.current;
    const peer = new RTCPeerConnection(rtcConfig);
    peersRef.current.set(participantId, peer);

    const remoteStream = new MediaStream();
    remoteStreamsRef.current.set(participantId, remoteStream);

    // Add local tracks (may be empty if user has no media)
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        console.log("[WebRTC] Adding local track:", track.kind, "to peer:", participantId);
        peer.addTrack(track, localStreamRef.current!);
      });
    }

    peer.onicecandidate = (event) => {
      if (event.candidate && socket) {
        socket.emit("signal:ice-candidate", { to: participantId, candidate: event.candidate });
      }
    };

    peer.onicegatheringstatechange = () => {
      console.log("[WebRTC] ICE gathering:", participantId, peer.iceGatheringState);
    };

    peer.oniceconnectionstatechange = () => {
      console.log("[WebRTC] ICE connection:", participantId, peer.iceConnectionState);
      if (peer.iceConnectionState === "failed") {
        console.warn("[WebRTC] ICE failed — attempting ICE restart for:", participantId);
        // restartIce() alone isn't enough — we need to re-offer with iceRestart:true
        const socket = socketRef.current;
        if (socket && peer.signalingState === "stable") {
          peer.createOffer({ iceRestart: true })
            .then((offer) => peer.setLocalDescription(offer))
            .then(() => {
              socket.emit("signal:offer", { to: participantId, description: peer.localDescription });
              console.log("[WebRTC] ICE restart offer sent to:", participantId);
            })
            .catch((e) => console.error("[WebRTC] ICE restart failed:", e));
        }
      }
    };

    peer.onconnectionstatechange = () => {
      console.log("[WebRTC] Connection state:", participantId, peer.connectionState);
      // Only clean up on truly terminal states.
      // "closed" can fire after we already called peer.close() — guard against double cleanup.
      if (peer.connectionState === "failed") {
        console.warn("[WebRTC] Connection permanently failed for:", participantId);
        // Don't clean up immediately on failed — ICE restart may recover it.
        // Only clean up if already closed.
      }
      if (peer.connectionState === "closed") {
        // Only clean up if this peer is still tracked (avoid double cleanup)
        if (peersRef.current.get(participantId) === peer) {
          cleanupPeer(participantId);
        }
      }
    };

    peer.onsignalingstatechange = () => {
      console.log("[WebRTC] Signaling state:", participantId, peer.signalingState);
    };

    peer.ontrack = (event) => {
      console.log("[WebRTC] ontrack from:", participantId, "kind:", event.track.kind);
      const stream = remoteStreamsRef.current.get(participantId)!;
      const existing = stream.getTracks().find((t) => t.kind === event.track.kind);
      if (existing) stream.removeTrack(existing);
      stream.addTrack(event.track);
      console.log("[WebRTC] Remote stream tracks:", stream.getTracks().map((t) => t.kind));
      setRemoteStreams((prev) => {
        const next = prev.filter((r) => r.participantId !== participantId);
        return [...next, { participantId, stream }];
      });
      event.track.onunmute = () => {
        setRemoteStreams((prev) => {
          const next = prev.filter((r) => r.participantId !== participantId);
          return [...next, { participantId, stream }];
        });
      };
    };

    return peer;
  }, [cleanupPeer]);

  const callParticipant = useCallback(async (participantId: string) => {
    const socket = socketRef.current;
    if (!socket) return;
    console.log("[WebRTC] Calling:", participantId);
    const peer = createPeer(participantId);
    try {
      const offer = await peer.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
      });
      await peer.setLocalDescription(offer);
      socket.emit("signal:offer", { to: participantId, description: peer.localDescription });
      console.log("[WebRTC] Offer sent to:", participantId);
    } catch (e) {
      console.error("[WebRTC] createOffer failed:", participantId, e);
    }
  }, [createPeer]);

  // ── main init effect ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!meetingId || !displayName) return;
    if (initRunningRef.current) return;
    initRunningRef.current = true;
    let cancelled = false;

    async function init() {
      // TASK 15: Never block the meeting — always join even with no media
      const { stream, hasVideo, hasAudio } = await acquireMedia();
      if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }

      localStreamRef.current = stream;
      setLocalStream(stream);
      setMicOn(hasAudio);
      setCameraOn(hasVideo);

      if (!hasVideo && !hasAudio) {
        setMediaInfo("Joined without camera or microphone. You can still chat and share your screen.");
      } else if (!hasVideo) {
        setMediaInfo("Camera unavailable. Joined with microphone only.");
      } else if (!hasAudio) {
        setMediaInfo("Microphone unavailable. Joined with camera only.");
      }

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
              setError(
                result.reason === "ROOM_FULL" ? "This meeting is full." :
                result.reason === "ENDED" ? "This meeting has ended." :
                result.reason === "MAX_MEETINGS_REACHED" ? "Maximum number of active meetings has been reached. Please try again later." :
                result.reason === "MAINTENANCE" ? "The application is currently under maintenance. Please try again later." :
                "Unable to join. Please try again."
              );
              return;
            }
            setLocalParticipant(result.participant ?? null);
            setParticipants(result.participants ?? []);
            console.log("[Meeting] Joined. Participants:", result.participants?.map((p) => p.name));
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
        if (reason !== "io client disconnect") setError("Disconnected. Attempting to reconnect…");
      });

      socket.on("reconnect", (attempt) => { console.log("[Socket] Reconnected after", attempt, "attempts."); setError(""); });
      socket.on("meeting:participants", (items: Participant[]) => { setParticipants(items); });
      socket.on("meeting:ended", () => { setError("The host ended this meeting."); setTimeout(() => router.replace("/"), 1500); });

      socket.on("participant:joined", (participant: Participant) => {
        console.log("[Meeting] Participant joined:", participant.name);
        setParticipants((prev) => upsertParticipant(prev, participant));
        callParticipant(participant.id).catch((e) => console.error("[WebRTC] callParticipant error:", e));
      });

      socket.on("participant:left", ({ participantId }: { participantId: string }) => {
        setParticipants((prev) => prev.filter((p) => p.id !== participantId));
        cleanupPeer(participantId);
        setScreenShareParticipantId((id) => (id === participantId ? null : id));
      });

      socket.on("participant:removed", () => { setError("You were removed."); setTimeout(() => router.replace("/"), 1200); });
      socket.on("participant:state", (participant: Participant) => {
        setParticipants((prev) => upsertParticipant(prev, participant));
        if (participant.id === socket.id) { setLocalParticipant(participant); setHandRaised(participant.handRaised); }
      });
      socket.on("screen:state", ({ participantId }: { participantId: string | null }) => setScreenShareParticipantId(participantId));
      socket.on("chat:message", (message: ChatMessage) => setChatMessages((prev) => [...prev, message]));

      socket.on("signal:offer", async ({ from, description }: SignalPayload) => {
        if (!description) return;
        console.log("[WebRTC] Offer from:", from);
        const peer = createPeer(from);
        try {
          await peer.setRemoteDescription(new RTCSessionDescription(description));
          await flushIceQueue(from, peer);
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          socket.emit("signal:answer", { to: from, description: peer.localDescription });
          console.log("[WebRTC] Answer sent to:", from);
        } catch (e) { console.error("[WebRTC] offer handling failed:", from, e); }
      });

      socket.on("signal:answer", async ({ from, description }: SignalPayload) => {
        if (!description) return;
        const peer = peersRef.current.get(from);
        if (!peer) {
          console.warn("[WebRTC] No peer for answer from:", from);
          return;
        }
        // Accept answer in have-local-offer state OR when doing ICE restart (stable→have-local-offer)
        if (peer.signalingState !== "have-local-offer") {
          console.warn("[WebRTC] Unexpected signaling state for answer from", from, ":", peer.signalingState);
          return;
        }
        try {
          await peer.setRemoteDescription(new RTCSessionDescription(description));
          await flushIceQueue(from, peer);
          console.log("[WebRTC] Answer applied from:", from);
        } catch (e) { console.error("[WebRTC] answer handling failed:", from, e); }
      });

      socket.on("signal:ice-candidate", async ({ from, candidate }: SignalPayload) => {
        if (!candidate) return;
        const peer = peersRef.current.get(from);
        if (!peer || !peer.remoteDescription) {
          const queue = iceCandidateQueueRef.current.get(from) ?? [];
          queue.push(candidate);
          iceCandidateQueueRef.current.set(from, queue);
          return;
        }
        try { await peer.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) { console.error("[WebRTC] addIceCandidate failed:", from, e); }
      });
    }

    init();

    return () => {
      cancelled = true;
      initRunningRef.current = false;
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
    const start = Date.now();
    const interval = window.setInterval(() => {
      const seconds = Math.floor((Date.now() - start) / 1000);
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

  // TASK 16: Camera off = stop() the track to release hardware light.
  // Camera on = getUserMedia again then replaceTrack in all peers.
  async function toggleCamera() {
    if (cameraOn) {
      // Turn OFF — stop the track so the OS indicator light goes off
      const tracks = localStreamRef.current?.getVideoTracks() ?? [];
      tracks.forEach((t) => { t.stop(); localStreamRef.current?.removeTrack(t); });
      await replaceTrackInPeers("video", null);
      setCameraOn(false);
      emitState({ cameraOn: false });
      // Update localStream state so VideoTile shows avatar
      setLocalStream(localStreamRef.current ? new MediaStream(localStreamRef.current.getTracks()) : null);
      console.log("[Camera] Turned OFF — hardware released.");
    } else {
      // Turn ON — request camera again
      try {
        const newStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
          audio: false,
        });
        const [videoTrack] = newStream.getVideoTracks();
        // Add to local stream
        if (!localStreamRef.current) localStreamRef.current = new MediaStream();
        // Remove any old video tracks first
        localStreamRef.current.getVideoTracks().forEach((t) => { t.stop(); localStreamRef.current!.removeTrack(t); });
        localStreamRef.current.addTrack(videoTrack);
        await replaceTrackInPeers("video", videoTrack);
        setCameraOn(true);
        emitState({ cameraOn: true });
        // Refresh localStream reference so VideoTile re-renders
        setLocalStream(new MediaStream(localStreamRef.current.getTracks()));
        console.log("[Camera] Turned ON — new stream acquired.");
      } catch (e) {
        console.error("[Camera] Failed to re-acquire camera:", e);
        setError("Could not access camera. Please check permissions.");
      }
    }
  }

  async function toggleScreenShare() {
    if (isSharingScreen) { stopScreenShare(); return; }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      screenStreamRef.current = stream;
      const [screenTrack] = stream.getVideoTracks();
      // Replace video track in all peers with screen track
      await replaceTrackInPeers("video", screenTrack);
      setIsSharingScreen(true);
      setScreenShareParticipantId(localParticipant?.id ?? null);
      socketRef.current?.emit("screen:start");
      screenTrack.onended = stopScreenShare;
    } catch (e) {
      console.error("[Screen] getDisplayMedia failed:", e);
      setError("Screen sharing was cancelled or is not supported.");
    }
  }

  async function stopScreenShare() {
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    // Restore camera track (if camera is on)
    const cameraTrack = localStreamRef.current?.getVideoTracks()[0] ?? null;
    await replaceTrackInPeers("video", cameraTrack);
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
    isRecording, isRecordingPaused, handRaised, timer, error, mediaInfo, networkQuality, connectionStatus,
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
  const options = ["video/mp4;codecs=h264,aac", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  return options.find((t) => MediaRecorder.isTypeSupported(t));
}
