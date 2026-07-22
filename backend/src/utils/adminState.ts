/**
 * In-memory admin configuration.
 * All values are read from env at startup but can be changed at runtime via admin API.
 * No database required.
 */

export interface AdminState {
  maxActiveMeetings: number;   // 0 = unlimited
  maintenanceMode: boolean;
}

const state: AdminState = {
  maxActiveMeetings: Number(process.env.MAX_ACTIVE_MEETINGS || 0),
  maintenanceMode: false,
};

export function getAdminState(): Readonly<AdminState> {
  return { ...state };
}

export function setMaxActiveMeetings(limit: number): void {
  state.maxActiveMeetings = Math.max(0, limit);
}

export function setMaintenanceMode(on: boolean): void {
  state.maintenanceMode = on;
}

/** Returns true when a new meeting can be created. */
export function canCreateNewMeeting(activeMeetingCount: number): boolean {
  if (state.maintenanceMode) return false;
  if (state.maxActiveMeetings === 0) return true;          // unlimited
  return activeMeetingCount < state.maxActiveMeetings;
}
