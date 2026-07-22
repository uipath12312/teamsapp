import {
  Copy,
  DoorOpen,
  Expand,
  Hand,
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  Radio,
  Square,
  Users,
  Video,
  VideoOff
} from "lucide-react";
import { getAppUrl } from "@/utils/meeting";

type Props = {
  meetingId: string;
  isHost: boolean;
  micOn: boolean;
  cameraOn: boolean;
  isSharingScreen: boolean;
  isRecording: boolean;
  isRecordingPaused: boolean;
  handRaised: boolean;
  onToggleMic: () => void;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onToggleChat: () => void;
  onToggleParticipants: () => void;
  onStartRecording: () => void;
  onPauseRecording: () => void;
  onResumeRecording: () => void;
  onStopRecording: () => void;
  onToggleFullScreen: () => void;
  onToggleHand: () => void;
  onLeave: () => void;
  onEnd: () => void;
};

function buttonClass(active = false, danger = false) {
  if (danger) return "grid h-11 w-11 place-items-center rounded-md bg-danger text-white hover:bg-red-500";
  return `grid h-11 w-11 place-items-center rounded-md ${active ? "bg-call text-white" : "bg-white/8 text-slate-100 hover:bg-white/12"}`;
}

export function ControlBar(props: Props) {
  const inviteLink = `${getAppUrl()}/meeting/${props.meetingId}`;

  function copyLink() {
    navigator.clipboard?.writeText(inviteLink).catch(() => undefined);
  }

  function shareLink() {
    if (navigator.share) {
      navigator.share({ title: "Join my meeting", url: inviteLink }).catch(() => undefined);
    } else {
      copyLink();
    }
  }

  return (
    <footer className="flex shrink-0 flex-wrap items-center justify-center gap-2 border-t border-white/10 bg-[#11141d] p-3">
      <button className={buttonClass(props.micOn)} onClick={props.onToggleMic} title={props.micOn ? "Mute microphone" : "Unmute microphone"}>
        {props.micOn ? <Mic size={20} /> : <MicOff size={20} />}
      </button>
      <button className={buttonClass(props.cameraOn)} onClick={props.onToggleCamera} title={props.cameraOn ? "Turn camera off" : "Turn camera on"}>
        {props.cameraOn ? <Video size={20} /> : <VideoOff size={20} />}
      </button>
      <button className={buttonClass(props.isSharingScreen)} onClick={props.onToggleScreenShare} title="Share screen">
        <MonitorUp size={20} />
      </button>
      <button className={buttonClass()} onClick={props.onToggleChat} title="Chat">
        <MessageSquare size={20} />
      </button>
      <button className={buttonClass()} onClick={props.onToggleParticipants} title="Participants">
        <Users size={20} />
      </button>
      {props.isHost && (
        <>
          {!props.isRecording ? (
            <button className={buttonClass()} onClick={props.onStartRecording} title="Start recording">
              <Radio size={20} />
            </button>
          ) : (
            <>
              <button className={buttonClass(props.isRecordingPaused)} onClick={props.isRecordingPaused ? props.onResumeRecording : props.onPauseRecording} title={props.isRecordingPaused ? "Resume recording" : "Pause recording"}>
                <Radio size={20} />
              </button>
              <button className={buttonClass()} onClick={props.onStopRecording} title="Stop recording">
                <Square size={18} />
              </button>
            </>
          )}
        </>
      )}
      <button className={buttonClass()} onClick={props.onToggleFullScreen} title="Full screen">
        <Expand size={20} />
      </button>
      <button className={buttonClass(props.handRaised)} onClick={props.onToggleHand} title="Raise hand">
        <Hand size={20} />
      </button>
      <button className={buttonClass()} onClick={copyLink} onDoubleClick={shareLink} title="Copy meeting link">
        <Copy size={20} />
      </button>
      <button className={buttonClass(false, true)} onClick={props.onLeave} title="Leave meeting">
        <DoorOpen size={20} />
      </button>
      {props.isHost && (
        <button className={buttonClass(false, true)} onClick={props.onEnd} title="End meeting">
          <PhoneOff size={20} />
        </button>
      )}
    </footer>
  );
}
