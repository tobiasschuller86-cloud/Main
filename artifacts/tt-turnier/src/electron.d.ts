export {};

declare global {
  interface Window {
    ttTurnierDesktop?: {
      isWindows: boolean;
      loadTournamentStorage: () => { ok: boolean; raw?: string | null; message?: string };
      saveTournamentStorage: (snapshot: string) => { ok: boolean; message?: string };
      checkForUpdate: (releaseNotesUrl: string) => Promise<{
        status: 'available' | 'current' | 'unavailable' | 'unsupported';
        currentVersion?: string;
        latestVersion?: string;
        downloadUrl?: string;
      }>;
      openExternal: (url: string) => Promise<{ success: boolean; message?: string }>;
      installPortableUpdate: () => Promise<{
        status: 'started' | 'launch-failed' | 'failed' | 'cancelled' | 'unsupported';
        version?: string;
        folder?: string;
        message?: string;
      }>;
    };
  }
}
