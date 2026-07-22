import { Crown, Mic, MicOff, UserMinus, Video, VideoOff } from "lucide-react";
import { Participant } from "@/types/meeting";

type Props = {
  participants: Participant[];
  localParticipantId?: string;
  canRemove: boolean;
  onRemove: (participantId: string) => void;
};

export function ParticipantPanel({ participants, localParticipantId, canRemove, onRemove }: Props) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-white/10 p-4">
        <h2 className="font-semibold">Participants ({participants.length})</h2>
      </div>
      <div className="space-y-2 overflow-y-auto p-3">
        {participants.map((participant) => (
          <div key={participant.id} className="flex items-center justify-between gap-3 rounded-md bg-white/6 p-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="truncate text-sm font-medium">{participant.name}{participant.id === localParticipantId ? " (You)" : ""}</p>
                {participant.isHost && <Crown size={14} className="text-cyan-200" />}
              </div>
              <div className="mt-1 flex items-center gap-2 text-slate-400">
                {participant.micOn ? <Mic size={14} /> : <MicOff size={14} className="text-danger" />}
                {participant.cameraOn ? <Video size={14} /> : <VideoOff size={14} className="text-danger" />}
                {participant.handRaised && <span className="text-xs text-amber-100">Hand raised</span>}
              </div>
            </div>
            {canRemove && participant.id !== localParticipantId && (
              <button
                onClick={() => onRemove(participant.id)}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-white/7 text-slate-200 hover:bg-danger/20 hover:text-red-100"
                aria-label={`Remove ${participant.name}`}
              >
                <UserMinus size={16} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
