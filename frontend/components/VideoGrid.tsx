"use client";
import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, Pin, PinOff, Monitor } from "lucide-react";
import { Participant, RemoteStream } from "@/types/meeting";
import { VideoTile } from "./VideoTile";

type Props = {
  localStream: MediaStream | null;
  remoteStreams: RemoteStream[];
  participants: Participant[];
  localParticipantId?: string;
  screenShareParticipantId?: string | null;
};

type TileData = {
  participant: Participant;
  isLocal: boolean;
  stream: MediaStream | null;
};

// ── Screen share large tile ────────────────────────────────────────────────
function ScreenShareTile({
  stream,
  presenterName,
  onFullScreen,
}: {
  stream: MediaStream | null;
  presenterName: string;
  onFullScreen: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !stream) return;
    if (el.srcObject !== stream) {
      el.srcObject = stream;
      el.play().catch(() => undefined);
    }
  }, [stream]);

  return (
    <div className="relative flex-1 min-h-0 overflow-hidden rounded-xl bg-black border border-white/10">
      {stream ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="h-full w-full object-contain"
        />
      ) : (
        <div className="grid h-full place-items-center text-slate-400">
          <div className="flex flex-col items-center gap-3">
            <Monitor size={48} className="text-cyan-400" />
            <p className="text-sm">Waiting for screen share…</p>
          </div>
        </div>
      )}

      {/* Overlay — presenter name + fullscreen button */}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/80 to-transparent px-4 py-3">
        <div className="flex items-center gap-2">
          <Monitor size={16} className="text-cyan-300" />
          <span className="text-sm font-medium text-white">
            {presenterName} is sharing their screen
          </span>
        </div>
        <button
          onClick={onFullScreen}
          className="grid h-8 w-8 place-items-center rounded-md bg-white/10 text-white hover:bg-white/20"
          title="Full screen"
        >
          <Maximize2 size={16} />
        </button>
      </div>
    </div>
  );
}

// ── Individual tile with pin/maximize controls ─────────────────────────────
function TileWithControls({
  tile,
  isPinned,
  isMaximized,
  onPin,
  onMaximize,
  showControls,
}: {
  tile: TileData;
  isPinned: boolean;
  isMaximized: boolean;
  onPin: () => void;
  onMaximize: () => void;
  showControls: boolean;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className="relative h-full"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <VideoTile
        participant={tile.participant}
        stream={tile.stream}
        isLocal={tile.isLocal}
      />

      {/* Controls overlay — shown on hover when multiple tiles exist */}
      {showControls && hovered && (
        <div className="absolute right-2 top-2 z-20 flex gap-1">
          <button
            onClick={onPin}
            className="grid h-7 w-7 place-items-center rounded-md bg-black/60 text-white hover:bg-black/80"
            title={isPinned ? "Unpin" : "Pin participant"}
          >
            {isPinned ? <PinOff size={13} /> : <Pin size={13} />}
          </button>
          <button
            onClick={onMaximize}
            className="grid h-7 w-7 place-items-center rounded-md bg-black/60 text-white hover:bg-black/80"
            title={isMaximized ? "Restore" : "Maximize"}
          >
            {isMaximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
        </div>
      )}

      {isPinned && (
        <div className="absolute left-2 top-2 z-20">
          <span className="inline-flex items-center gap-1 rounded-full bg-cyan-500/30 px-2 py-0.5 text-xs text-cyan-100">
            <Pin size={10} /> Pinned
          </span>
        </div>
      )}
    </div>
  );
}

// ── Main VideoGrid ─────────────────────────────────────────────────────────
export function VideoGrid({
  localStream,
  remoteStreams,
  participants,
  localParticipantId,
  screenShareParticipantId,
}: Props) {
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [maximizedId, setMaximizedId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Build tile data for every participant
  const tiles: TileData[] = participants.map((participant) => {
    const isLocal = participant.id === localParticipantId;
    const remote = remoteStreams.find((r) => r.participantId === participant.id);
    return {
      participant,
      isLocal,
      stream: isLocal ? localStream : (remote?.stream ?? null),
    };
  });

  // Screen share presenter info
  const screenSharePresenter = participants.find((p) => p.id === screenShareParticipantId);
  const screenShareStream = (() => {
    if (!screenShareParticipantId) return null;
    const isLocalShare = screenShareParticipantId === localParticipantId;
    if (isLocalShare) return localStream;
    return remoteStreams.find((r) => r.participantId === screenShareParticipantId)?.stream ?? null;
  })();

  // Presentation mode = active when someone is sharing screen
  const isPresentationMode = Boolean(screenShareParticipantId);

  // Auto-switch: clear pin/maximize when screen share starts/stops
  useEffect(() => {
    if (isPresentationMode) {
      setMaximizedId(null); // presentation mode takes over full area
    }
  }, [isPresentationMode]);

  // Full screen handler
  const handleFullScreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => undefined);
    } else if (containerRef.current) {
      containerRef.current.requestFullscreen().catch(() => undefined);
    }
  };

  // ── Maximized single tile view ─────────────────────────────────────────
  if (maximizedId && !isPresentationMode) {
    const tile = tiles.find((t) => t.participant.id === maximizedId);
    if (tile) {
      return (
        <div ref={containerRef} className="relative h-full w-full overflow-hidden rounded-lg">
          <VideoTile
            participant={tile.participant}
            stream={tile.stream}
            isLocal={tile.isLocal}
          />
          {/* Exit maximize button */}
          <button
            onClick={() => setMaximizedId(null)}
            className="absolute right-3 top-3 z-30 flex items-center gap-1.5 rounded-md bg-black/60 px-3 py-1.5 text-xs text-white hover:bg-black/80"
          >
            <Minimize2 size={14} /> Exit maximize
          </button>
        </div>
      );
    }
  }

  // ── Presentation mode ─────────────────────────────────────────────────
  if (isPresentationMode) {
    // Pinned tile takes the main area if set; otherwise screen share takes it
    const pinnedTile = pinnedId ? tiles.find((t) => t.participant.id === pinnedId) : null;

    return (
      <div ref={containerRef} className="flex h-full flex-col gap-2 overflow-hidden">
        {/* Main area — screen share (large) */}
        <div className="flex min-h-0 flex-1 gap-2">
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <ScreenShareTile
              stream={screenShareStream}
              presenterName={screenSharePresenter?.name ?? "Participant"}
              onFullScreen={handleFullScreen}
            />
            {/* Pinned participant beside screen share on desktop */}
            {pinnedTile && (
              <div className="hidden h-40 shrink-0 overflow-hidden rounded-lg lg:block">
                <TileWithControls
                  tile={pinnedTile}
                  isPinned
                  isMaximized={false}
                  onPin={() => setPinnedId(null)}
                  onMaximize={() => setMaximizedId(pinnedTile.participant.id)}
                  showControls
                />
              </div>
            )}
          </div>
        </div>

        {/* Participant strip — horizontal scroll on mobile, wrap on desktop */}
        <div className="flex shrink-0 gap-2 overflow-x-auto pb-1 md:flex-wrap md:overflow-x-visible">
          {tiles.map((tile) => (
            <div
              key={tile.participant.id}
              className="h-24 w-36 shrink-0 overflow-hidden rounded-lg md:h-28 md:w-44"
            >
              <TileWithControls
                tile={tile}
                isPinned={pinnedId === tile.participant.id}
                isMaximized={false}
                onPin={() =>
                  setPinnedId((prev) =>
                    prev === tile.participant.id ? null : tile.participant.id
                  )
                }
                onMaximize={() => setMaximizedId(tile.participant.id)}
                showControls={tiles.length > 1}
              />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── Pinned view (no screen share) ────────────────────────────────────
  if (pinnedId) {
    const pinnedTile = tiles.find((t) => t.participant.id === pinnedId);
    const otherTiles = tiles.filter((t) => t.participant.id !== pinnedId);

    if (pinnedTile) {
      return (
        <div ref={containerRef} className="flex h-full flex-col gap-2 overflow-hidden">
          {/* Large pinned view */}
          <div className="min-h-0 flex-1 overflow-hidden rounded-xl">
            <TileWithControls
              tile={pinnedTile}
              isPinned
              isMaximized={false}
              onPin={() => setPinnedId(null)}
              onMaximize={() => setMaximizedId(pinnedTile.participant.id)}
              showControls
            />
          </div>

          {/* Other participants in a strip */}
          {otherTiles.length > 0 && (
            <div className="flex shrink-0 gap-2 overflow-x-auto pb-1">
              {otherTiles.map((tile) => (
                <div
                  key={tile.participant.id}
                  className="h-24 w-36 shrink-0 overflow-hidden rounded-lg"
                >
                  <TileWithControls
                    tile={tile}
                    isPinned={false}
                    isMaximized={false}
                    onPin={() => setPinnedId(tile.participant.id)}
                    onMaximize={() => setMaximizedId(tile.participant.id)}
                    showControls
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }
  }

  // ── Default grid view ─────────────────────────────────────────────────
  const gridClass =
    tiles.length <= 1
      ? "grid-cols-1"
      : tiles.length === 2
      ? "grid-cols-1 md:grid-cols-2"
      : tiles.length <= 4
      ? "grid-cols-1 sm:grid-cols-2"
      : "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3";

  return (
    <div
      ref={containerRef}
      className={`grid h-full gap-3 ${gridClass} auto-rows-fr`}
    >
      {tiles.map((tile) => (
        <div key={tile.participant.id} className="min-h-0 overflow-hidden">
          <TileWithControls
            tile={tile}
            isPinned={pinnedId === tile.participant.id}
            isMaximized={maximizedId === tile.participant.id}
            onPin={() =>
              setPinnedId((prev) =>
                prev === tile.participant.id ? null : tile.participant.id
              )
            }
            onMaximize={() =>
              setMaximizedId((prev) =>
                prev === tile.participant.id ? null : tile.participant.id
              )
            }
            showControls={tiles.length > 1}
          />
        </div>
      ))}
    </div>
  );
}
