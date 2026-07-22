import Head from "next/head";
import { useRouter } from "next/router";
import { FormEvent, useState } from "react";
import { ArrowRight, Copy, Video } from "lucide-react";
import { createMeetingId, getAppUrl, normalizeMeetingId } from "@/utils/meeting";

export default function Home() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [meeting, setMeeting] = useState("");
  const [createdLink, setCreatedLink] = useState("");

  function persistName() {
    sessionStorage.setItem("displayName", name.trim());
  }

  function createMeeting() {
    if (!name.trim()) return;
    const id = createMeetingId();
    persistName();
    router.push(`/meeting/${id}?host=1`);
  }

  function joinMeeting(event: FormEvent) {
    event.preventDefault();
    const id = normalizeMeetingId(meeting);
    if (!name.trim() || !id) return;
    persistName();
    router.push(`/meeting/${id}`);
  }

  function previewMeetingLink() {
    const id = createMeetingId();
    const link = `${getAppUrl()}/meeting/${id}`;
    setCreatedLink(link);
    navigator.clipboard?.writeText(link).catch(() => undefined);
  }

  return (
    <>
      <Head>
        <title>Guest Video Meet</title>
        <meta name="description" content="Free guest-only WebRTC meetings for up to five people." />
      </Head>
      <main className="min-h-screen bg-[#0b0d12]">
        <section className="mx-auto flex min-h-screen max-w-6xl flex-col justify-center px-5 py-10">
          <div className="grid items-center gap-10 lg:grid-cols-[1.08fr_0.92fr]">
            <div className="space-y-7">
              <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/6 px-3 py-1 text-sm text-slate-300">
                <Video size={16} />
                Browser-based meetings, no accounts
              </div>
              <div className="space-y-4">
                <h1 className="max-w-3xl text-5xl font-semibold leading-tight tracking-normal text-white md:text-7xl">
                  Start a clean, private video room in seconds.
                </h1>
                <p className="max-w-2xl text-lg leading-8 text-slate-300">
                  Guest access, peer-to-peer WebRTC, screen sharing, local recording, chat, and host controls for small teams.
                </p>
              </div>
            </div>

            <div className="rounded-lg border border-white/10 bg-[#151821] p-5 shadow-soft">
              <label className="mb-2 block text-sm font-medium text-slate-200" htmlFor="displayName">
                Display name
              </label>
              <input
                id="displayName"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Ravi Kumar"
                className="mb-4 w-full rounded-md border border-white/10 bg-[#0d1018] px-4 py-3 text-white outline-none ring-call/40 placeholder:text-slate-500 focus:ring-2"
              />

              <button
                type="button"
                onClick={createMeeting}
                disabled={!name.trim()}
                className="mb-3 flex w-full items-center justify-center gap-2 rounded-md bg-call px-4 py-3 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Video size={18} />
                Create meeting
              </button>

              <form onSubmit={joinMeeting} className="space-y-3">
                <label className="block text-sm font-medium text-slate-200" htmlFor="meetingId">
                  Meeting link or ID
                </label>
                <input
                  id="meetingId"
                  value={meeting}
                  onChange={(event) => setMeeting(event.target.value)}
                  placeholder="ABC123"
                  className="w-full rounded-md border border-white/10 bg-[#0d1018] px-4 py-3 text-white outline-none ring-call/40 placeholder:text-slate-500 focus:ring-2"
                />
                <button
                  type="submit"
                  disabled={!name.trim() || !meeting.trim()}
                  className="flex w-full items-center justify-center gap-2 rounded-md border border-white/10 px-4 py-3 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Join meeting
                  <ArrowRight size={18} />
                </button>
              </form>

              <button
                type="button"
                onClick={previewMeetingLink}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-md bg-white/7 px-4 py-3 text-sm font-medium text-slate-200 hover:bg-white/10"
              >
                <Copy size={16} />
                Generate and copy invite link
              </button>
              {createdLink && <p className="mt-3 break-all text-sm text-slate-400">{createdLink}</p>}
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
