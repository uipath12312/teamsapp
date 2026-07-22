import { Mic, MicOff, MonitorUp, VideoOff } from "lucide-react";
import { useEffect, useRef } from "react";
import { Participant } from "@/types/meeting";

type Props = {
  participant?: Participant;
  stream?: MediaStream | null;
  isLocal?: boolean;
  isScreenShare?: boolean;
};

export function VideoTile({ participant, stream, isLocal, isScreenShare }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    if (stream) {
      // Only reassign if the stream has changed
      if (el.srcObject !== stream) {
        console.log(
          "[VideoTile] Attaching stream to video element for",
          participant?.name ?? "unknown",
          "tracks:", stream.getTracks().map((t) => `${t.kind}(${t.readyState})`)
        );
        el.srcObject = stream;
      }
      // Always try to play — handles cases where autoplay was blocked
      el.play().catch((err) => {
        // NotAllowedError = autoplay blocked — user interaction will unblock
        if (err.name !== "AbortError") {
          console.warn("[VideoTile] play() failed:", err.name, err.message);
        }
      });
    } else {
      el.srcObject = null;
    }
  }, [stream, participant?.name]);

  const cameraOn = participant?.cameraOn ?? true;
  const micOn = participant?.micOn ?? true;
  // Show video element if we have a stream, regardless of cameraOn state
  // (cameraOn=false just disables the track but the element stays)
  const hasStream = Boolean(stream);
  const showVideo = hasStream && cameraOn;

  return (
    <article className="relative min-h-[180px] overflow-hidden rounded-lg border border-white/10 bg-[#11141d]">
      {/* Video element always rendered — srcObject attached via useEffect */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={isLocal}
        className={`h-full w-full object-cover ${showVideo ? "block" : "hidden"}`}
      />

      {/* Avatar when camera is off or no stream yet */}
      {!showVideo && (
        <div className="grid h-full min-h-[180px] place-items-center">
          <div className="grid h-20 w-20 place-items-center rounded-full bg-call text-2xl font-semibold text-white select-none">
            {(participant?.name || "?").slice(0, 1).toUpperCase()}
          </div>
        </div>
      )}

      {/* Top badges */}
      <div className="absolute left-3 top-3 flex items-center gap-2 z-10">
        {isScreenShare && (
          <span className="inline-flex items-center gap-1 rounded-full bg-cyan-500/20 px-2 py-1 text-xs text-cyan-100">
            <MonitorUp size={13} /> Sharing
          </span>
        )}
        {participant?.handRaised && (
          <span className="rounded-full bg-amber-500/20 px-2 py-1 text-xs text-amber-100">
            ✋ Hand raised
          </span>
        )}
      </div>

      {/* Bottom name bar */}
      <div className="absolute inset-x-0 bottom-0 z-10 flex items-center justify-between bg-gradient-to-t from-black/70 to-transparent p-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-white">
            {participant?.name || "Guest"}
            {isLocal ? " (You)" : ""}
          </p>
          {participant?.isHost && <p className="text-xs text-cyan-100">Host</p>}
        </div>
        <div className="flex items-center gap-2 text-white">
          {micOn ? <Mic size={16} /> : <MicOff size={16} className="text-red-400" />}
          {!cameraOn && <VideoOff size={16} className="text-red-400" />}
        </div>
      </div>
    </article>
  );
}
