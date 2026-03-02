# PF2e Aura Helper

Dieses Foundry VTT Modul erinnert Spieler daran, wenn sie ihren Zug in einer feindlichen Aura beginnen. Es postet automatisch eine Nachricht im Chat mit einem Link zur betreffenden Aura, sodass notwendige Würfe direkt über den Chat durchgeführt werden können.

## Verwendung

1. Installiere das Modul in Foundry VTT (v13) und aktiviere es in deiner Welt.
2. Beim Modulstart schreibt PF2e Aura Helper den aktiven Modus in die Konsole (öffentlich vs. GM-Whisper, nur feindliche vs. auch verbündete Auren, Sichtbarkeitsfilter aktiv/inaktiv).
3. Bei Beginn eines Spielerzuges oder beim Betreten einer Aura prüft das Modul die konfigurierten Aura-Quellen.
4. Wird eine Aura gefunden, erscheint eine Chat-Erinnerung samt Aura-Link (öffentlich oder als GM-Flüstern je nach Einstellung).

## Einstellungen

- **Log level**: Für detaillierte Debug-Ausgaben muss der Wert explizit auf **Debug** gesetzt werden (Legacy-Fallback: **Enable debug logging (Legacy fallback)** nur für bestehende Installationen ohne gesetzten Log-Level).
- **Only trigger visible enemy auras** (Standard: deaktiviert): Wenn aktiviert, werden Aura-Trigger nur für Gegner ausgelöst, die für die Gruppe sichtbar sind.
- **Post aura reminders in public chat (instead of GM whisper)** (Standard: deaktiviert):
  - **Aktiviert**: Aura-Nachrichten erscheinen im öffentlichen Chat für alle.
  - **Deaktiviert**: Aura-Nachrichten werden **nur an die Spielleitung (GM-Whisper)** gesendet.
- **Also check allied auras** (Standard: deaktiviert): Prüft zusätzlich verbündete Auraquellen; wenn deaktiviert, werden nur feindliche Auren berücksichtigt.
- **Aura distance mode** (Standard: **Edge**): Legt fest, wie die Distanz zwischen Aura-Quelle und Zieltoken bewertet wird.

### Distanzerkennungsmodi

Je nach Token-Größe und gewünschter Regelauslegung kann ein anderer Distanzmodus sinnvoll sein:

- **Edge (current behavior)**
  - Misst den Abstand von Kante zu Kante (kleinster Abstand zwischen den Tokenrändern).
  - Entspricht dem bisherigen Standardverhalten des Moduls.

- **Hybrid: 1x1 center, larger tokens edge**
  - Für zwei 1x1-Token wird **Mittelpunkt-zu-Mittelpunkt** gemessen.
  - Sobald mindestens ein Token größer als 1x1 ist, wird wieder **Kante-zu-Kante** verwendet.
  - Sinnvoll, wenn kleine Kreaturen eher „zentral“ und große Kreaturen eher über ihre Base-Ränder bewertet werden sollen.

- **Center (diagnostic)**
  - Erzwingt **Mittelpunkt-zu-Mittelpunkt** für alle Token.
  - Vor allem als Diagnose-/Vergleichsmodus gedacht.

- **Token distance (tooltip-like)**
  - Nutzt Foundrys `token.distanceTo(...)`-Semantik.
  - Orientiert sich damit am Distanzgefühl, das viele Nutzer aus Token-Tooltips bzw. anderen Foundry-Distanzausgaben kennen.

Direkt beim Start schreibt das Modul im Log eine klar erkennbare Zeile zum aktiven Kanal, z. B.:

- `Aktiver Chat-Kanal für Aura-Nachrichten: GM-Whisper (nur Spielleitung)`
- `Aktiver Chat-Kanal für Aura-Nachrichten: Öffentlicher Chat (alle Spieler)`

Im **Debug**-Log wird vor jeder Chat-Nachricht zusätzlich der technische Zielkanal (`public` oder `whisper`) sowie die Empfängerliste ausgegeben.
