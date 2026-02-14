const AURA_HELPER_MODULE_ID = "pf2e-aura-helper";
const SIDEBAR_SELECTED_TARGETS_FLAG = "sidebarSelectedTargets";

class AuraHelperSidebarTab extends SidebarTab {
  static get defaultOptions() {
    const parentClasses = Array.isArray(super.defaultOptions?.classes) ? super.defaultOptions.classes : [];

    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "aura-helper",
      classes: [...parentClasses, "aura-helper-sidebar"],
      title: "Auras",
      template: "modules/pf2e-aura-helper/templates/aura-helper-tab.hbs",
    });
  }

  getData(options = {}) {
    const data = super.getData(options);
    const combat = game.combat ?? null;
    const userSelectedTargetIds = new Set(game.user.getFlag(AURA_HELPER_MODULE_ID, SIDEBAR_SELECTED_TARGETS_FLAG) ?? []);

    const combatants = (combat?.combatants?.contents ?? []).map((combatant) => {
      const token = combatant.token ?? null;
      const actor = token?.actor ?? combatant.actor ?? null;
      const auraEntries = actor?.auras ? this.#getAuraEntries(actor.auras) : [];

      return {
        id: combatant.id,
        name: token?.name ?? combatant.name ?? actor?.name ?? game.i18n.localize("PF2E.Unknown"),
        tokenId: token?.id ?? null,
        isDefeated: Boolean(combatant.defeated),
        isTargeted: token?.id ? game.user.targets.has(token.object) : false,
        isSelected: token?.id ? userSelectedTargetIds.has(token.id) : false,
        auraCount: auraEntries.length,
        auras: auraEntries,
      };
    });

    return {
      ...data,
      hasCombat: Boolean(combat),
      combatId: combat?.id ?? null,
      round: combat?.round ?? null,
      turn: combat?.turn ?? null,
      combatants,
      selectedTargetIds: [...userSelectedTargetIds],
      targetCount: game.user.targets.size,
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find('input[data-action="toggle-target"]').on("change", async (event) => {
      const checkbox = event.currentTarget;
      const tokenId = checkbox?.dataset?.tokenId;
      if (!tokenId) return;

      const selectedTargetIds = new Set(game.user.getFlag(AURA_HELPER_MODULE_ID, SIDEBAR_SELECTED_TARGETS_FLAG) ?? []);
      if (checkbox.checked) {
        selectedTargetIds.add(tokenId);
      } else {
        selectedTargetIds.delete(tokenId);
      }

      await game.user.setFlag(AURA_HELPER_MODULE_ID, SIDEBAR_SELECTED_TARGETS_FLAG, [...selectedTargetIds]);
    });
  }

  #getAuraEntries(auras) {
    if (typeof auras.entries === "function") {
      return [...auras.entries()].map(([key, aura]) => this.#prepareAuraData(key, aura));
    }

    if (Array.isArray(auras)) {
      return auras.map((aura, index) => this.#prepareAuraData(index, aura));
    }

    if (typeof auras === "object" && auras !== null) {
      return Object.entries(auras).map(([key, aura]) => this.#prepareAuraData(key, aura));
    }

    return [];
  }

  #prepareAuraData(key, aura) {
    return {
      key: String(key),
      slug: aura?.slug ?? null,
      name: aura?.name ?? aura?.label ?? game.i18n.localize("PF2E.AuraLabel"),
      radius: Number.isFinite(Number(aura?.radius)) ? Number(aura.radius) : null,
      traits: Array.isArray(aura?.traits) ? aura.traits : [],
    };
  }
}

Hooks.once("init", () => {
  CONFIG.ui = CONFIG.ui ?? {};
  CONFIG.ui.sidebarTabs = CONFIG.ui.sidebarTabs ?? {};
  CONFIG.ui.sidebarTabs["aura-helper"] = AuraHelperSidebarTab;
});
