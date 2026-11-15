import { type ReactNode, useState } from 'react';
import { installDesktopStorage } from '@/lib/desktop-storage';

export function DesktopStorageGate({ children }: { children: ReactNode }) {
  const [writeError, setWriteError] = useState<string | null>(null);
  const [startupError] = useState<string | null>(() => {
    const bridge = window.ttTurnierDesktop;
    if (!bridge) return null;
    try {
      if (typeof bridge.loadTournamentStorage !== 'function' || typeof bridge.saveTournamentStorage !== 'function') {
        throw new Error('Die Desktop-Speicherschnittstelle fehlt. Bitte installiere die vollständige Programmversion.');
      }
      installDesktopStorage(window.localStorage, bridge, setWriteError);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : 'Die lokalen Turnierdaten konnten nicht geöffnet werden.';
    }
  });
  const error = startupError || writeError;
  if (!error) return children;
  return <main style={{ maxWidth: 680, margin: '80px auto', padding: 28, color: '#272727', background: '#fff', border: '1px solid #990000', borderRadius: 12 }} role="alert" data-testid="desktop-storage-error">
    <h1 style={{ color: '#990000' }}>Turnierdaten nicht sicher gespeichert</h1>
    <p>{error}</p>
    <p>Bitte beende die Bearbeitung, bis der Speicherfehler behoben ist. Vorhandene Datendateien wurden nicht durch ein leeres Turnier ersetzt.</p>
    <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Erneut versuchen</button>
  </main>;
}
