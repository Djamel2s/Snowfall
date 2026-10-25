// Prism en mode manuel, AVANT son chargement : sans cela, il parcourt la page au
// démarrage et réécrit les blocs de code en HTML (interdit par notre CSP Trusted Types).
;(globalThis as { Prism?: { manual?: boolean } }).Prism = { manual: true }

export {}
