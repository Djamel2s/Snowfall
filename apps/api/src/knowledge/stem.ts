// Racinisation légère du français (algorithme de J. Savoy, celui du
// FrenchLightStemmer de Lucene), adaptée à des mots déjà sans accents.
// « Légère » : elle retire les flexions (pluriel, féminin, -ement, -ation…)
// sans les sur-racinisations d'un Porter, plus sûr pour la recherche.
// Les pluriels anglais simples sont aussi couverts (retrait du « s »).

const endsWith = (word: string, suffix: string) => word.endsWith(suffix);

function norm(input: string) {
  let word = input;
  if (word.length > 4) {
    // Lettres doublées réduites : « chiffre » → « chifre ».
    let out = word[0]!;
    for (let i = 1; i < word.length; i++) {
      const char = word[i]!;
      if (char !== out[out.length - 1] || !/\p{L}/u.test(char)) out += char;
    }
    word = out;
  }
  if (word.length > 4 && endsWith(word, "ie")) word = word.slice(0, -2);
  if (word.length > 4) {
    if (endsWith(word, "r")) word = word.slice(0, -1);
    if (endsWith(word, "e")) word = word.slice(0, -1);
    if (endsWith(word, "e")) word = word.slice(0, -1);
    if (word.length > 1 && word[word.length - 1] === word[word.length - 2] && /\p{L}/u.test(word[word.length - 1]!)) {
      word = word.slice(0, -1);
    }
  }
  return word;
}

/** Racine d'un mot en minuscules, sans accents. */
export function stemFrench(input: string): string {
  let word = input;
  if (word.length > 5 && endsWith(word, "x")) {
    // « chevaux » → « cheval », sauf « -eaux ».
    if (endsWith(word, "aux") && word[word.length - 4] !== "e") word = `${word.slice(0, -2)}l`;
    else word = word.slice(0, -1);
  }
  if (word.length > 3 && endsWith(word, "x")) word = word.slice(0, -1);
  if (word.length > 3 && endsWith(word, "s")) word = word.slice(0, -1);

  const replace = (minLength: number, suffix: string, by: string, final = true): string | null => {
    if (word.length > minLength && endsWith(word, suffix)) {
      word = word.slice(0, -suffix.length) + by;
      return final ? norm(word) : null;
    }
    return null;
  };

  return (
    replace(9, "issement", "ir") ??
    replace(8, "issant", "ir") ??
    (word.length > 6 && endsWith(word, "ement")
      ? // Retrait de « -ment » ; « activement » → « actif ».
        norm(endsWith(word.slice(0, -4), "ive") ? `${word.slice(0, -6)}f` : word.slice(0, -4))
      : null) ??
    replace(11, "ficatrice", "fier") ??
    replace(10, "ficateur", "fier") ??
    replace(9, "catrice", "quer") ??
    replace(8, "cateur", "quer") ??
    replace(8, "atrice", "er") ??
    replace(7, "ateur", "er") ??
    replace(6, "trice", "teur", false) ??
    replace(5, "ieme", "") ??
    replace(7, "teuse", "ter") ??
    replace(6, "teur", "ter") ??
    replace(5, "euse", "eu") ??
    replace(8, "ere", "er") ??
    replace(7, "ive", "if") ??
    replace(4, "folle", "fou") ??
    replace(4, "molle", "mou") ??
    replace(9, "nnelle", "n") ??
    replace(9, "nnel", "n") ??
    replace(4, "ete", "et", false) ??
    replace(8, "ique", "", false) ??
    replace(8, "esse", "e") ??
    replace(7, "inage", "in") ??
    replace(9, "isation", "") ??
    replace(9, "isateur", "") ??
    replace(8, "ation", "") ??
    replace(8, "ition", "") ??
    norm(word)
  );
}
