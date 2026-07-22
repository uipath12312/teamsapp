import Head from "next/head";
import { useRouter } from "next/router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChatPanel } from "@/components/ChatPanel";
import { ControlBar } from "@/components/ControlBar";
import { ParticipantPanel } from "@/components/ParticipantPanel";
import { VideoGrid } from "@/components/VideoGrid";
import { useMeeting } from "@/hooks/useMeeting";

export default function MeetingPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [panels, setPanels] = useState({ chat: false, people: false });
  const resolvedRef = useRef(false);

  // Wait until router.isReady so query params are populated, then read sessionStorage.
  // Use router.isReady (a primitive boolean) as the dep — not the unstable `router` object.
  useEffect(() => {
    if (!router.isReady) return;
    if (resolvedRef.current) return;
    resolvedRef.current = true;

    const stored = sessionStorage.getItem("displayName") || "";
    if (!stored.trim()) {
      router.replace("/");
      return;
    }
    setDisplayName(stored);
    setReady(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady]); // Only re-run when isReady flips — avoids unstable router object dep

  const meetingId = ready ? String(router.query.id ?? "") : "";
  // isHostIntent is safe to read here: router.isReady is true before ready becomes true
  const isHostIntent = router.query.host === "1";

  const meeting = useMeeting({
    meetingId,
    displayName,
    isHostIntent,
  });

  const activeSidePanel = panels.chat || panels.people;
  const title = useMemo(
    () => (meetingId ? `Meeting ${meetingId}` : "Meeting"),
    [meetingId]
  );
  const maxParticipants = Number(process.env.NEXT_PUBLIC_MAX_PARTICIPANTS || 10);

  if (!ready || !meetingId || !displayName) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#0b0d12] text-slate-300">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-call border-t-transparent" />
          <span>Preparing meeting…</span>
        </div>
      </main>
    );
  }

  return (
    <>
      <Head>
        <title>{title}</title>
      </Head>
      <main className="flex h-screen flex-col overflow-hidden bg-[#0b0d12] text-white">
        {/* Header */}
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-white/10 px-4">
          <div>
            <h1 className="text-base font-semibold">{title}</h1>
            <p className="text-xs text-slate-400">
              {meeting.timer} •{" "}
              <span className="font-medium text-slate-200">
                {meeting.participants.length}
              </span>
              /{maxParticipants} participants
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-300">
            <span className="rounded-full bg-emerald-500/15 px-2 py-1 text-emerald-200">
              {meeting.networkQuality}
            </span>
            {meeting.localParticipant?.isHost && (
              <span className="rounded-full bg-call/20 px-2 py-1 text-cyan-100">Host</span>
            )}
          </div>
        </header>

        {/* Error banner */}
        {meeting.error && (
          <div className="border-b border-red-400/30 bg-red-500/10 px-4 py-2 text-sm text-red-200">
            ⚠ {meeting.error}
          </div>
        )}

        {/* Main content */}
        <div className="flex min-h-0 flex-1">
          <section className="min-w-0 flex-1 p-3">
            <VideoGrid
              localStream={meeting.localStream}
              remoteStreams={meeting.remoteStreams}
              participants={meeting.participants}
              localParticipantId={meeting.localParticipant?.id}
              screenShareParticipantId={meeting.screenShareParticipantId}
            />
          </section>

          {activeSidePanel && (
            <aside className="hidden w-80 shrink-0 border-l border-white/10 bg-[#11141d] md:block">
              {panels.chat ? (
                <ChatPanel
                  messages={meeting.chatMessages}
                  onSend={meeting.sendChat}
                />
              ) : (
                <ParticipantPanel
                  participants={meeting.participants}
                  localParticipantId={meeting.localParticipant?.id}
                  onRemove={meeting.removeParticipant}
                  canRemove={Boolean(meeting.localParticipant?.isHost)}
                />
              )}
            </aside>
          )}
        </div>

        {/* Controls */}
        <ControlBar
          meetingId={meetingId}
          isHost={Boolean(meeting.localParticipant?.isHost)}
          micOn={meeting.micOn}
          cameraOn={meeting.cameraOn}
          isSharingScreen={meeting.isSharingScreen}
          isRecording={meeting.isRecording}
          isRecordingPaused={meeting.isRecordingPaused}
          handRaised={meeting.handRaised}
          onToggleMic={meeting.toggleMic}
          onToggleCamera={meeting.toggleCamera}
          onToggleScreenShare={meeting.toggleScreenShare}
          onToggleChat={() => setPanels((v) => ({ chat: !v.chat, people: false }))}
          onToggleParticipants={() =>
            setPanels((v) => ({ chat: false, people: !v.people }))
          }
          onStartRecording={meeting.startRecording}
          onPauseRecording={meeting.pauseRecording}
          onResumeRecording={meeting.resumeRecording}
          onStopRecording={meeting.stopRecording}
          onToggleFullScreen={meeting.toggleFullScreen}
          onToggleHand={meeting.toggleHand}
          onLeave={meeting.leaveMeeting}
          onEnd={meeting.endMeeting}
        />
      </main>
    </>
  );
}
