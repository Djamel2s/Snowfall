// Branches de conversation. Les messages forment un arbre : chaque message a un
// parent (le précédent dans SA branche). Modifier un message ou régénérer une
// réponse ajoute une sœur au lieu d'effacer : l'ancienne version reste
// consultable (‹ 1/2 ›). La conversation retient la feuille affichée ; le
// chemin de la racine à cette feuille est l'historique (affiché et envoyé au modèle).

export type BranchNode = { id: string; parentId: string | null; createdAt: string };
/** Position d'un message parmi ses sœurs (versions du même tour). */
export type BranchInfo = { index: number; count: number; siblings: string[] };

const byAge = (a: BranchNode, b: BranchNode) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

function children(nodes: BranchNode[]) {
  const map = new Map<string | null, BranchNode[]>();
  for (const node of nodes) map.set(node.parentId, [...(map.get(node.parentId) ?? []), node]);
  for (const list of map.values()) list.sort(byAge);
  return map;
}

/** Feuille la plus récente sous un message : on descend toujours vers la version la plus récente. */
export function latestLeaf(nodes: BranchNode[], fromId: string | null): string | null {
  const tree = children(nodes);
  let current = fromId;
  for (let guard = 0; guard <= nodes.length; guard++) {
    const next = tree.get(current)?.at(-1);
    if (!next) return current;
    current = next.id;
  }
  return current;
}

/**
 * Chemin affiché : de la racine à la feuille retenue (ou, à défaut, la plus
 * récente). Chaque message du chemin porte ses sœurs s'il en a.
 */
export function activePath(nodes: BranchNode[], leafId: string | null) {
  const index = new Map(nodes.map((node) => [node.id, node]));
  const tree = children(nodes);
  const leaf = leafId && index.has(leafId) ? leafId : latestLeaf(nodes, null);
  const path: string[] = [];
  const seen = new Set<string>();
  for (let current = leaf; current && !seen.has(current); current = index.get(current)?.parentId ?? null) {
    seen.add(current);
    path.unshift(current);
  }
  const branches = new Map<string, BranchInfo>();
  for (const id of path) {
    const siblings = tree.get(index.get(id)!.parentId) ?? [];
    if (siblings.length > 1) branches.set(id, { index: siblings.findIndex((node) => node.id === id), count: siblings.length, siblings: siblings.map((node) => node.id) });
  }
  return { path, branches };
}
