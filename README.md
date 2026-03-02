# PF2e Aura Helper

This Foundry VTT module reminds players when they start their turn inside a hostile aura. It automatically posts a chat message with a link to the relevant aura so required rolls can be made directly from chat.

## Usage

1. Install the module in Foundry VTT (v13) and enable it in your world.
2. On module startup, PF2e Aura Helper writes the active mode to the console (public vs. GM whisper, hostile-only vs. also allied auras, visibility filter enabled/disabled).
3. At the start of a player turn or when entering an aura, the module checks the configured aura sources.
4. If an aura is found, a chat reminder appears with an aura link (public or GM whisper, depending on settings).

## Settings

- **Log level**: For detailed debug output, this must be explicitly set to **Debug** (legacy fallback: **Enable debug logging (Legacy fallback)** only for existing installations without a configured log level).
- **Only trigger visible enemy auras** (default: disabled): When enabled, aura triggers are only fired for enemies visible to the party.
- **Post aura reminders in public chat (instead of GM whisper)** (default: disabled):
  - **Enabled**: Aura messages are shown in public chat for everyone.
  - **Disabled**: Aura messages are sent **only to the GM (GM whisper)**.
- **Also check allied auras** (default: disabled): Also checks allied aura sources; when disabled, only hostile auras are considered.
- **Aura distance mode** (default: **Edge**): Defines how distance between the aura source and the target token is evaluated.

### Distance detection modes

Depending on token size and your preferred rule interpretation, a different distance mode may be useful:

- **Edge (current behavior)**
  - Measures edge-to-edge distance (minimum distance between token borders).
  - Matches the module’s previous default behavior.

- **Hybrid: 1x1 center, larger tokens edge**
  - For two 1x1 tokens, distance is measured **center-to-center**.
  - As soon as at least one token is larger than 1x1, it switches back to **edge-to-edge**.
  - Useful if small creatures should be evaluated more “centrally” and large creatures more by their base edges.

- **Center (diagnostic)**
  - Forces **center-to-center** measurement for all tokens.
  - Intended mainly as a diagnostic/comparison mode.

- **Token distance (tooltip-like)**
  - Uses Foundry’s `token.distanceTo(...)` semantics.
  - This aligns with the distance behavior many users know from token tooltips and other Foundry distance outputs.

Right at startup, the module writes a clearly visible log line for the active chat channel, for example:

- `Active chat channel for aura messages: GM whisper (GM only)`
- `Active chat channel for aura messages: Public chat (all players)`

In **Debug** logs, the technical target channel (`public` or `whisper`) and recipient list are additionally printed before each chat message.
