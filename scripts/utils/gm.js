export function getResponsibleGM() {
  return [...(game.users ?? [])]
    .filter((user) => user.active && user.isGM)
    .sort((a, b) => a.id.localeCompare(b.id))[0] ?? null;
}

export function isResponsibleGM() {
  return !!game.user && game.user.id === getResponsibleGM()?.id;
}

export function getGMIds({ activeOnly = false } = {}) {
  return [...(game.users ?? [])]
    .filter((user) => user.isGM && (!activeOnly || user.active))
    .map((user) => user.id);
}
