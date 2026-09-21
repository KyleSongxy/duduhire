const clauseBoundary = /[，,。！？!?；;\r\n]/u;
// Keep Chinese negation in either position, including "远程合作我不接受".
const qualification = /[不没未]|并非|只负责|只参与|只是|只做|仅负责|仅参与|仅做|仅了解|计划|希望|预计|估计|暂定|团队|同事|他人|别人|其他人|供应商|外包|\b(?:not|never|without|only|team|colleagues?)\b|\b(?:didn['’]?t|don['’]?t|doesn['’]?t|haven['’]?t)\b/iu;

/**
 * Recover only exact source text. A short quote can otherwise turn "没有做过模型
 * 微调" into an affirmative skill or omit "由同事负责". Restore its containing
 * comma/sentence clause only when that clause has a qualification; ordinary
 * excerpts remain short. Repeated phrases retain all distinct qualified contexts.
 * Empty means no exact match or an ambiguity that cannot fit the evidence budget.
 */
export function recoverEvidenceContext(source: string, quote: string): string[] {
  if (!quote || quote.length > 800) return [];
  const result: string[] = [];
  let cursor = 0;
  let found = false;
  while (cursor <= source.length - quote.length) {
    const offset = source.indexOf(quote, cursor);
    if (offset < 0) break;
    found = true;
    let start = offset;
    while (start > 0 && !clauseBoundary.test(source[start - 1]!)) start--;
    let end = offset + quote.length;
    // A quote that already ends a sentence must not absorb the next sentence.
    if (!clauseBoundary.test(quote.at(-1)!)) {
      while (end < source.length && !clauseBoundary.test(source[end]!)) end++;
    }
    const context = source.slice(start, end).trim();
    const recovered = qualification.test(context) ? context : quote;
    if (!recovered || recovered.length > 800 || !source.includes(recovered)) return [];
    if (!result.includes(recovered)) result.push(recovered);
    if (result.length > 4) return [];
    cursor = offset + Math.max(quote.length, 1);
  }
  return found ? result : [];
}
