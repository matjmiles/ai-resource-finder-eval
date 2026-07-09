const { parse } = require('node-html-parser');

/**
 * Parse the Resource Finder result cards from a full-page HTML string.
 *
 * DOM structure (confirmed via smoke test 2026-07-09):
 *   div.mud-card                              -> one result per card
 *     h2 > a[href][aria-label]               -> database name + link
 *     div[role="img"][aria-label="Relevance score: N% match"]
 *       div[role="progressbar"][aria-valuenow]-> the tool's own relevance %
 *     div.mud-card-content
 *       p.mud-typography-body2 (first)        -> static database description
 *       ... "Why this matches your search:" block -> AI per-query justification
 *
 * @param {string} html full page HTML (e.g. from page.content())
 * @returns {Array<{rank:number,title:string,url:string,toolScore:(number|null),description:string,whyMatches:string}>}
 */
function parseResultsFromHtml(html) {
  const root = parse(html);
  const cards = root.querySelectorAll('.mud-card');
  const results = [];

  cards.forEach((card, i) => {
    const link = card.querySelector('h2 a') || card.querySelector('a');
    if (!link) return; // not a result card

    const title = link.text.trim();
    const url = link.getAttribute('href') || '';

    // Tool's own relevance score, from the progressbar aria-valuenow.
    let toolScore = null;
    const pb = card.querySelector('[role="progressbar"]');
    if (pb) {
      const v = pb.getAttribute('aria-valuenow');
      if (v != null && v !== '') toolScore = Number(v);
    }
    if (toolScore == null) {
      const scoreImg = card.querySelector('[aria-label^="Relevance score"]');
      const m = scoreImg && scoreImg.getAttribute('aria-label').match(/(\d+)%/);
      if (m) toolScore = Number(m[1]);
    }

    // Static description: first body2 paragraph inside card content.
    const content = card.querySelector('.mud-card-content');
    let description = '';
    let whyMatches = '';
    if (content) {
      // "Why this matches your search:" block — grab the paragraph after that caption.
      // (Extract this first so we can exclude it when picking the static description.)
      const caption = content
        .querySelectorAll('.mud-typography-caption')
        .find((c) => /why this matches/i.test(c.text));
      let whyBox = null;
      if (caption) {
        whyBox = caption.parentNode;
        const whyP = whyBox && whyBox.querySelector('p');
        if (whyP) whyMatches = whyP.text.replace(/\s+/g, ' ').trim();
      }

      // Static description: the source markup nests <p> inside <p> (invalid HTML), so the
      // classed wrapper parses empty. Take the first non-empty paragraph that isn't inside
      // the "why matches" box.
      const whyText = whyMatches;
      const descP = content.querySelectorAll('p').find((p) => {
        const t = p.text.replace(/\s+/g, ' ').trim();
        if (t.length === 0) return false;
        if (whyBox && whyBox.querySelectorAll('p').includes(p)) return false;
        return t !== whyText;
      });
      if (descP) description = descP.text.replace(/\s+/g, ' ').trim();
    }

    results.push({ rank: i + 1, title, url, toolScore, description, whyMatches });
  });

  return results;
}

module.exports = { parseResultsFromHtml };
