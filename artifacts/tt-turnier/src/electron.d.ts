export {};

declare global {
  interface Window {
    ttTurnierDesktop?: {
      isWindows: boolean;
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
