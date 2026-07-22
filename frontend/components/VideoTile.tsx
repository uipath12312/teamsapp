import { Mic, MicOff, MonitorUp, VideoOff } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { Participant } from "@/types/meeting";

type Props = {
  participant?: Participant;
  stream?: MediaStream | null;
  isLocal?: boolean;
  isScreenShare?: boolean;
};

export function VideoTile({ participant, stream, isLocal, isScreenShare }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Attach stream to video element whenever stream changes OR element mounts
  const attachStream = useCallback(
    (el: HTMLVideoElement | null) => {
      if (!el) return;
      if (stream && el.srcObject !== stream) {
        el.srcObject = stream;
        el.play().catch(() => {
          // autoplay may be blocked — will recover on user interaction
        });
      } else if (!stream) {
        el.srcObject = null;
      }
    },
    [stream]
  );

  // ref callback: fires when element mounts/unmounts
  const videoCallbackRef = useCallback(
    (el: HTMLVideoElement | null) => {
      (videoRef as React.MutableRefObject<HTMLVideoElement | null>).current = el;
      attachStream(el);
    },
    [attachStream]
  );

  // also re-attach whenever stream reference changes on an already-mounted element
  useEffect(() => {
    attachStream(videoRef.current);
  }, [attachStream, stream]);

  const cameraOn = participant?.cameraOn ?? true;
  const micOn = participant?.micOn ?? true;
  const showVideo = Boolean(stream) && cameraOn;

  return (
    <article className="relative min-h-[180px] overflow-hidden rounded-lg border border-white/10 bg-[#11141d]">
      {/* Video element is always in the DOM so srcObject can be set immediately */}
      <video
        ref={videoCallbackRef}
        autoPlay
        playsInline
        muted={isLocal}
        className={`h-full w-full object-cover transition-opacity duration-200 ${showVideo ? "opacity-100" : "opacity-0 absolute inset-0"}`}
      />

      {/* Avatar shown when camera is off or stream not yet available */}
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
