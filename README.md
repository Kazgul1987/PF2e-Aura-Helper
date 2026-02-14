# PF2e Aura Helper

Dieses Foundry VTT Modul erinnert Spieler daran, wenn sie ihren Zug in einer feindlichen Aura beginnen. Es postet automatisch eine Nachricht im Chat mit einem Link zur betreffenden Aura, sodass notwendige Würfe direkt über den Chat durchgeführt werden können.

## Verwendung

1. Installiere das Modul in Foundry VTT (v13) und aktiviere es in deiner Welt.
2. Beim Modulstart schreibt PF2e Aura Helper den aktiven Modus in die Konsole (öffentlich vs. GM-Whisper, nur feindliche vs. auch verbündete Auren, Sichtbarkeitsfilter aktiv/inaktiv).
3. Bei Beginn eines Spielerzuges oder beim Betreten einer Aura prüft das Modul die konfigurierten Aura-Quellen.
4. Wird eine Aura gefunden, erscheint eine Chat-Erinnerung samt Aura-Link (öffentlich oder als GM-Flüstern je nach Einstellung).

## Einstellungen

- **Log level**: Für detaillierte Debug-Ausgaben muss der Wert explizit auf **Debug** gesetzt werden (Legacy-Fallback: **Enable debug logging (Legacy fallback)** nur für bestehende Installationen ohne gesetzten Log-Level).
- **Only trigger visible enemy auras** (Standard: aktiviert): Aura-Trigger werden nur für Gegner ausgelöst, die für die Gruppe sichtbar sind.
- **Post aura reminders in public chat (instead of GM whisper)** (Standard: deaktiviert):
  - **Aktiviert**: Aura-Nachrichten erscheinen im öffentlichen Chat für alle.
  - **Deaktiviert**: Aura-Nachrichten werden **nur an die Spielleitung (GM-Whisper)** gesendet.
- **Also check allied auras** (Standard: deaktiviert): Prüft zusätzlich verbündete Auraquellen; wenn deaktiviert, werden nur feindliche Auren berücksichtigt.

Direkt beim Start schreibt das Modul im Log eine klar erkennbare Zeile zum aktiven Kanal, z. B.:

- `Aktiver Chat-Kanal für Aura-Nachrichten: GM-Whisper (nur Spielleitung)`
- `Aktiver Chat-Kanal für Aura-Nachrichten: Öffentlicher Chat (alle Spieler)`

Im **Debug**-Log wird vor jeder Chat-Nachricht zusätzlich der technische Zielkanal (`public` oder `whisper`) sowie die Empfängerliste ausgegeben.
