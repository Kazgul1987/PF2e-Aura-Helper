# PF2e Aura Helper

Dieses Foundry VTT Modul erinnert Spieler daran, wenn sie ihren Zug in einer feindlichen Aura beginnen. Es postet automatisch eine Nachricht im Chat mit einem Link zur betreffenden Aura, sodass notwendige Würfe direkt über den Chat durchgeführt werden können.

## Verwendung

1. Installiere das Modul in Foundry VTT (v13) und aktiviere es in deiner Welt.
2. Bei Beginn eines Spielerzuges prüft das Modul, ob sich der aktive Token in einer gegnerischen Aura befindet.
3. Wird eine Aura gefunden, erscheint eine Chat-Erinnerung samt Aura-Link.

## Einstellungen

- **Log level**: Für detaillierte Debug-Ausgaben muss der Wert explizit auf **Debug** gesetzt werden (Legacy-Fallback: **Enable debug logging (Legacy fallback)** nur für bestehende Installationen ohne gesetzten Log-Level).
- **Only trigger visible enemy auras** (Standard: aktiviert): Aura-Trigger werden nur für Gegner ausgelöst, die für die Gruppe sichtbar sind.
- **Send aura chat messages publicly** (Standard: deaktiviert): Aura-Nachrichten werden öffentlich im Chat gepostet statt nur an die Spielleitung geflüstert.

