import { Participant, RemoteStream } from "@/types/meeting";
import { VideoTile } from "./VideoTile";

type Props = {
  localStream: MediaStream | null;
  remoteStreams: RemoteStream[];
  participants: Participant[];
  localParticipantId?: string;
  screenShareParticipantId?: string | null;
};

export function VideoGrid({ localStream, remoteStreams, participants, localParticipantId, screenShareParticipantId }: Props) {
  const tiles = participants.map((participant) => {
    const isLocal = participant.id === localParticipantId;
    const remote = remoteStreams.find((item) => item.participantId === participant.id);
    return {
      participant,
      isLocal,
      stream: isLocal ? localStream : remote?.stream ?? null
    };
  });

  const gridClass =
    tiles.length <= 1
      ? "grid-cols-1"
      : tiles.length === 2
        ? "grid-cols-1 md:grid-cols-2"
        : tiles.length <= 4
          ? "grid-cols-1 sm:grid-cols-2"
          : "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3";

  return (
    <div className={`grid h-full gap-3 ${gridClass} auto-rows-fr`}>
      {tiles.map((tile) => (
        <VideoTile
          key={tile.participant.id}
          participant={tile.participant}
          stream={tile.stream}
          isLocal={tile.isLocal}
          isScreenShare={screenShareParticipantId === tile.participant.id}
        />
      ))}
    </div>
  );
}
