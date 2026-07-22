import Head from "next/head";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  Clock,
  LogOut,
  Monitor,
  RefreshCw,
  Server,
  Settings,
  Shield,
  Trash2,
  Users,
  Video,
  XCircle,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────

interface MeetingInfo {
  id: string;
  participants: number;
  participantNames: string[];
  createdAt: number;
  durationSeconds: number;
  screenSharing: boolean;
}

interface AdminStatus {
  uptime: number;
  activeMeetings: number;
  totalParticipants: number;
  maxParticipantsPerMeeting: number;
  maxActiveMeetings: number;
  maintenanceMode: boolean;
  meetings: MeetingInfo[];
}

// ── Helpers ───────────────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

// ── Admin API client — all requests go to the backend, never exposing password to browser storage ──

function makeBasicAuth(user: string, pass: string): string {
  return "Basic " + btoa(`${user}:${pass}`);
}

const backendUrl =
  process.env.NEXT_PUBLIC_SIGNALING_URL?.replace(/\/$/, "") ||
  "http://localhost:4000";

// ── Main component ────────────────────────────────────────────────────────

export default function AdminPage() {
  const [authed, setAuthed] = useState(false);
  const [loginUser, setLoginUser] = useState("");
  const [loginPass, setLoginPass] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const authRef = useRef("");

  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [limitInput, setLimitInput] = useState("");

  const showMsg = (text: string, ok = true) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), 4000);
  };

  // ── API helper ──────────────────────────────────────────────────────────
  const api = useCallback(
    async (path: string, method = "GET", body?: unknown) => {
      const res = await fetch(`${backendUrl}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: authRef.current,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || res.statusText);
      return json;
    },
    []
  );

  // ── Login ───────────────────────────────────────────────────────────────
  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!loginUser.trim() || !loginPass.trim()) return;
    setLoginLoading(true);
    setLoginError("");
    try {
      authRef.current = makeBasicAuth(loginUser.trim(), loginPass.trim());
      await api("/api/admin/status"); // test credentials
      setAuthed(true);
    } catch {
      authRef.current = "";
      setLoginError("Invalid username or password.");
    } finally {
      setLoginLoading(false);
    }
  }

  function handleLogout() {
    authRef.current = "";
    setAuthed(false);
    setStatus(null);
    setLoginPass("");
  }

  // ── Fetch status ────────────────────────────────────────────────────────
  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api("/api/admin/status");
      setStatus(data);
      setLimitInput(String(data.maxActiveMeetings));
    } catch (e) {
      showMsg((e as Error).message, false);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (authed) fetchStatus();
  }, [authed, fetchStatus]);

  // Auto-refresh every 10 seconds
  useEffect(() => {
    if (!authed) return;
    const t = setInterval(fetchStatus, 10000);
    return () => clearInterval(t);
  }, [authed, fetchStatus]);

  // ── Admin actions ───────────────────────────────────────────────────────
  async function endMeeting(id: string) {
    if (!confirm(`End meeting ${id}?`)) return;
    try {
      await api(`/api/admin/meetings/${id}`, "DELETE");
      showMsg(`Meeting ${id} ended.`);
      fetchStatus();
    } catch (e) {
      showMsg((e as Error).message, false);
    }
  }

  async function endAllMeetings() {
    if (!confirm("End ALL active meetings? All participants will be disconnected.")) return;
    try {
      const res = await api("/api/admin/meetings", "DELETE");
      showMsg(res.message);
      fetchStatus();
    } catch (e) {
      showMsg((e as Error).message, false);
    }
  }

  async function clearInactive() {
    try {
      const res = await api("/api/admin/clear", "POST");
      showMsg(res.message);
      fetchStatus();
    } catch (e) {
      showMsg((e as Error).message, false);
    }
  }

  async function applyLimit() {
    const val = parseInt(limitInput, 10);
    if (isNaN(val) || val < 0) { showMsg("Enter a valid number (0 = unlimited)", false); return; }
    try {
      await api("/api/admin/config", "PATCH", { maxActiveMeetings: val });
      showMsg(`Meeting limit set to ${val === 0 ? "unlimited" : val}.`);
      fetchStatus();
    } catch (e) {
      showMsg((e as Error).message, false);
    }
  }

  async function toggleMaintenance() {
    if (!status) return;
    const next = !status.maintenanceMode;
    if (next && !confirm("Enable maintenance mode? New meetings will be blocked.")) return;
    try {
      await api("/api/admin/config", "PATCH", { maintenanceMode: next });
      showMsg(`Maintenance mode ${next ? "enabled" : "disabled"}.`);
      fetchStatus();
    } catch (e) {
      showMsg((e as Error).message, false);
    }
  }

  // ── Login screen ────────────────────────────────────────────────────────
  if (!authed) {
    return (
      <>
        <Head><title>Admin — TeamsApp</title></Head>
        <main className="grid min-h-screen place-items-center bg-[#0b0d12] px-4">
          <div className="w-full max-w-sm rounded-xl border border-white/10 bg-[#151821] p-8 shadow-xl">
            <div className="mb-6 flex items-center gap-3">
              <Shield size={28} className="text-cyan-400" />
              <div>
                <h1 className="text-lg font-semibold text-white">Admin Panel</h1>
                <p className="text-xs text-slate-400">TeamsApp meeting management</p>
              </div>
            </div>

            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="mb-1 block text-sm text-slate-300">Username</label>
                <input
                  value={loginUser}
                  onChange={(e) => setLoginUser(e.target.value)}
                  placeholder="Admin username"
                  autoComplete="username"
                  className="w-full rounded-md border border-white/10 bg-[#0d1018] px-3 py-2.5 text-sm text-white outline-none focus:ring-2 focus:ring-cyan-500/40 placeholder:text-slate-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm text-slate-300">Password</label>
                <input
                  type="password"
                  value={loginPass}
                  onChange={(e) => setLoginPass(e.target.value)}
                  placeholder="Admin password"
                  autoComplete="current-password"
                  className="w-full rounded-md border border-white/10 bg-[#0d1018] px-3 py-2.5 text-sm text-white outline-none focus:ring-2 focus:ring-cyan-500/40 placeholder:text-slate-500"
                />
              </div>

              {loginError && (
                <p className="flex items-center gap-1.5 text-sm text-red-400">
                  <XCircle size={14} /> {loginError}
                </p>
              )}

              <button
                type="submit"
                disabled={loginLoading || !loginUser.trim() || !loginPass.trim()}
                className="w-full rounded-md bg-cyan-600 py-2.5 text-sm font-semibold text-white hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loginLoading ? "Signing in…" : "Sign in"}
              </button>
            </form>
          </div>
        </main>
      </>
    );
  }

  // ── Dashboard ────────────────────────────────────────────────────────────
  return (
    <>
      <Head><title>Admin Dashboard — TeamsApp</title></Head>
      <main className="min-h-screen bg-[#0b0d12] text-white">

        {/* Header */}
        <header className="flex items-center justify-between border-b border-white/10 bg-[#0f1219] px-6 py-4">
          <div className="flex items-center gap-3">
            <Shield size={22} className="text-cyan-400" />
            <span className="font-semibold text-white">TeamsApp Admin</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={fetchStatus}
              disabled={loading}
              className="flex items-center gap-1.5 rounded-md bg-white/8 px-3 py-1.5 text-sm text-slate-200 hover:bg-white/12 disabled:opacity-50"
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
              Refresh
            </button>
            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 rounded-md bg-white/8 px-3 py-1.5 text-sm text-slate-200 hover:bg-white/12"
            >
              <LogOut size={14} /> Logout
            </button>
          </div>
        </header>

        {/* Toast */}
        {msg && (
          <div className={`flex items-center gap-2 px-6 py-3 text-sm ${msg.ok ? "bg-emerald-500/15 text-emerald-200" : "bg-red-500/15 text-red-200"}`}>
            {msg.ok ? <CheckCircle size={15} /> : <XCircle size={15} />}
            {msg.text}
          </div>
        )}

        <div className="mx-auto max-w-6xl space-y-6 px-4 py-6">

          {/* Stat cards */}
          {status && (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard icon={<Video size={20} className="text-cyan-400" />} label="Active Meetings" value={String(status.activeMeetings)} />
              <StatCard icon={<Users size={20} className="text-emerald-400" />} label="Total Participants" value={String(status.totalParticipants)} />
              <StatCard icon={<Clock size={20} className="text-amber-400" />} label="Server Uptime" value={formatUptime(status.uptime)} />
              <StatCard
                icon={<Server size={20} className={status.maintenanceMode ? "text-red-400" : "text-slate-400"} />}
                label="Status"
                value={status.maintenanceMode ? "Maintenance" : "Online"}
                valueClass={status.maintenanceMode ? "text-red-400" : "text-emerald-400"}
              />
            </div>
          )}

          <div className="grid gap-6 lg:grid-cols-3">

            {/* Meeting list */}
            <div className="lg:col-span-2 rounded-xl border border-white/10 bg-[#151821]">
              <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
                <div className="flex items-center gap-2">
                  <Activity size={16} className="text-cyan-400" />
                  <span className="font-medium text-white">Active Meetings</span>
                  <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-slate-300">
                    {status?.activeMeetings ?? 0}
                  </span>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={endAllMeetings}
                    className="flex items-center gap-1.5 rounded-md bg-red-500/15 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/25"
                  >
                    <XCircle size={13} /> End All
                  </button>
                  <button
                    onClick={clearInactive}
                    className="flex items-center gap-1.5 rounded-md bg-white/8 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/12"
                  >
                    <Trash2 size={13} /> Clear Inactive
                  </button>
                </div>
              </div>

              {/* Table */}
              {!status || status.meetings.length === 0 ? (
                <div className="py-12 text-center text-sm text-slate-500">No active meetings</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/5 text-left text-xs text-slate-400">
                        <th className="px-5 py-3 font-medium">Meeting ID</th>
                        <th className="px-4 py-3 font-medium">Participants</th>
                        <th className="px-4 py-3 font-medium">Duration</th>
                        <th className="px-4 py-3 font-medium">Started</th>
                        <th className="px-4 py-3 font-medium">Screen</th>
                        <th className="px-4 py-3 font-medium"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {status.meetings.map((m) => (
                        <tr key={m.id} className="border-b border-white/5 hover:bg-white/3">
                          <td className="px-5 py-3 font-mono text-cyan-300">{m.id}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1.5">
                              <Users size={13} className="text-slate-400" />
                              <span>{m.participants}</span>
                            </div>
                            <div className="mt-0.5 text-xs text-slate-500 truncate max-w-[140px]" title={m.participantNames.join(", ")}>
                              {m.participantNames.join(", ")}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-slate-300">{formatDuration(m.durationSeconds)}</td>
                          <td className="px-4 py-3 text-slate-400">{formatTime(m.createdAt)}</td>
                          <td className="px-4 py-3">
                            {m.screenSharing ? (
                              <span className="flex items-center gap-1 text-xs text-cyan-300"><Monitor size={12} /> Sharing</span>
                            ) : (
                              <span className="text-xs text-slate-500">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <button
                              onClick={() => endMeeting(m.id)}
                              className="rounded bg-red-500/15 px-2 py-1 text-xs text-red-300 hover:bg-red-500/30"
                              title="End this meeting"
                            >
                              End
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Config panel */}
            <div className="space-y-4">

              {/* Server info */}
              {status && (
                <div className="rounded-xl border border-white/10 bg-[#151821] p-5 space-y-3">
                  <div className="flex items-center gap-2 border-b border-white/10 pb-3">
                    <Server size={15} className="text-slate-400" />
                    <span className="text-sm font-medium text-white">Server Info</span>
                  </div>
                  <InfoRow label="Max participants/meeting" value={String(status.maxParticipantsPerMeeting)} />
                  <InfoRow label="Meeting limit" value={status.maxActiveMeetings === 0 ? "Unlimited" : String(status.maxActiveMeetings)} />
                  <InfoRow label="Maintenance mode" value={status.maintenanceMode ? "ON" : "OFF"} valueClass={status.maintenanceMode ? "text-red-400" : "text-emerald-400"} />
                  <InfoRow label="Uptime" value={formatUptime(status.uptime)} />
                </div>
              )}

              {/* Meeting limit control */}
              <div className="rounded-xl border border-white/10 bg-[#151821] p-5 space-y-3">
                <div className="flex items-center gap-2 border-b border-white/10 pb-3">
                  <Settings size={15} className="text-slate-400" />
                  <span className="text-sm font-medium text-white">Meeting Limit</span>
                </div>
                <p className="text-xs text-slate-400">
                  Set the maximum number of parallel meetings. Enter 0 for unlimited.
                </p>
                <div className="flex gap-2">
                  <input
                    type="number"
                    min={0}
                    value={limitInput}
                    onChange={(e) => setLimitInput(e.target.value)}
                    className="w-24 rounded-md border border-white/10 bg-[#0d1018] px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-cyan-500/40"
                  />
                  <button
                    onClick={applyLimit}
                    className="flex-1 rounded-md bg-cyan-600/20 px-3 py-2 text-sm font-medium text-cyan-300 hover:bg-cyan-600/30"
                  >
                    Apply
                  </button>
                </div>
              </div>

              {/* Maintenance mode */}
              <div className="rounded-xl border border-white/10 bg-[#151821] p-5 space-y-3">
                <div className="flex items-center gap-2 border-b border-white/10 pb-3">
                  <AlertTriangle size={15} className="text-amber-400" />
                  <span className="text-sm font-medium text-white">Maintenance Mode</span>
                </div>
                <p className="text-xs text-slate-400">
                  When enabled, no new meetings can be created. Existing meetings continue unaffected.
                </p>
                <button
                  onClick={toggleMaintenance}
                  className={`w-full rounded-md py-2.5 text-sm font-medium transition-colors ${
                    status?.maintenanceMode
                      ? "bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
                      : "bg-amber-500/15 text-amber-300 hover:bg-amber-500/25"
                  }`}
                >
                  {status?.maintenanceMode ? "Disable Maintenance Mode" : "Enable Maintenance Mode"}
                </button>
              </div>

            </div>
          </div>
        </div>
      </main>
    </>
  );
}

// ── Small reusable components ─────────────────────────────────────────────

function StatCard({ icon, label, value, valueClass = "text-white" }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#151821] p-5">
      <div className="mb-3 flex items-center gap-2 text-xs text-slate-400">
        {icon}
        <span>{label}</span>
      </div>
      <p className={`text-2xl font-semibold ${valueClass}`}>{value}</p>
    </div>
  );
}

function InfoRow({ label, value, valueClass = "text-slate-200" }: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-slate-400">{label}</span>
      <span className={`font-medium ${valueClass}`}>{value}</span>
    </div>
  );
}
