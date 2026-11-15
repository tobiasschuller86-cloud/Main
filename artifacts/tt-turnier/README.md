# Tischtennis-Turnier für Windows

## Installer herunterladen und prüfen

Öffne den gewünschten Eintrag auf der GitHub-Releases-Seite und lade beide
zusammengehörenden Dateien herunter:

- `Tischtennis-Turnier-<Version>-x64-<signed-oder-unsigned>.exe` – der Installer
- `Tischtennis-Turnier-<Version>-x64-<signed-oder-unsigned>.exe.sha256` – die Prüfsumme dazu

Der Zusatz ist je nach Veröffentlichung `signed` oder `unsigned`. Speichere
beide Dateien im selben Ordner. Öffne PowerShell dort und berechne den
SHA-256-Hash des Installers:

```powershell
Get-FileHash -Algorithm SHA256 .\Tischtennis-Turnier-<Version>-x64-<signed-oder-unsigned>.exe
```

Ersetze die Platzhalter im Befehl durch die entsprechenden Teile des
heruntergeladenen Dateinamens.

Öffne die passende `.exe.sha256`-Datei, zum Beispiel mit Editor. Vergleiche
ihren 64-stelligen Hash mit dem Wert in der Spalte `Hash`, den PowerShell
ausgegeben hat. Stimmen die Werte nicht exakt überein, führe den Installer
nicht aus und lade beide Dateien erneut von der Releases-Seite herunter.
Starte das Setup erst, wenn die Hashes übereinstimmen.

## Portable ZIP herunterladen und prüfen

Lade aus demselben GitHub-Release die ZIP-Datei und die passende
`Tischtennis-Turnier-<Version>-x64-<signed-oder-unsigned>.zip.sha256` herunter.
Speichere beide Dateien im selben Ordner. Berechne den Hash der ZIP-Datei in
PowerShell:

```powershell
Get-FileHash -Algorithm SHA256 .\Tischtennis-Turnier-<Version>-x64-<signed-oder-unsigned>.zip
```

Vergleiche den angezeigten 64-stelligen SHA-256-Hash exakt mit dem Hash in der
passenden `.zip.sha256`-Datei. Prüfe auch, dass die Prüfsummendatei den Namen
der heruntergeladenen ZIP nennt. Bei einer Abweichung die ZIP nicht entpacken
oder starten; lade beide Dateien erneut aus demselben Release herunter.
Ersetze die Platzhalter im PowerShell-Befehl durch den heruntergeladenen
Dateinamen.

## Portable ZIP aktualisieren und wiederherstellen

Öffne in der laufenden Windows-App **Einstellungen > Portable ZIP-Version
aktualisieren**. Wähle die neue ZIP und danach einen Zielordner außerhalb des
bisherigen App-Ordners. Die App verlangt die gleichnamige `.zip.sha256`-Datei
im selben Ordner, prüft die Prüfsumme und App-Version, entpackt in einen neuen
Versionsordner und startet erst dann die neue Version. Der bisherige Ordner
wird nicht überschrieben. Beide Versionen verwenden weiter dasselbe
Windows-Benutzerprofil für Turnierdaten.

Wenn die Prüfung fehlschlägt, das Entpacken unterbrochen wird oder die neue
Version nicht startet, lösche nur den neu angelegten beziehungsweise
unvollständigen Versionsordner und starte die bisherige App erneut. Lösche
nicht den Datenordner im Windows-Benutzerprofil. Behalte den alten App-Ordner,
bis du die neue Version mit deinen Turnierdaten geprüft hast.
