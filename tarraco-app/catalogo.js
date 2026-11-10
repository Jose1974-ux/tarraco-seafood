const catalogAliases = [
  ['gamba vermella', 'gamba roja'], ['escamarla', 'cigala'],
  ['llagosti', 'langostino'], ['llagosta', 'langosta'], ['llamantol', 'bogavante'],
  ['cloissa', 'almeja'], ['musclo', 'mejillon'], ['navallas', 'navajas'],
  ['choco', 'chco', 'sepia'], ['pop', 'popet', 'pulpo'], ['cranc', 'cangrejo'],
  ['lluc', 'merluza'], ['bacalla', 'bacalao'], ['rap', 'rape'],
  ['llenguado', 'lenguado'], ['tonyina', 'atun'], ['salmo', 'salmon'],
  ['seito', 'anxoa', 'boqueron', 'anchoa'], ['remol', 'rodaballo'],
  ['gall sant pere', 'pez san pedro'], ['peix espasa', 'emperador', 'pez espada']
];

function catalogText(value) {
  return String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function catalogSearchText(product) {
  const text = catalogText([product.name, product.product_code, product.category,
    product.catalog_group, product.catalog_format].filter(Boolean).join(' '));
  const words = ' ' + text + ' ';
  const aliases = catalogAliases.filter(set => set.some(term => words.includes(' ' + term + ' '))).flat();
  return [text, ...aliases].join(' ');
}

function catalogMatches(text, query) {
  return catalogText(query).split(' ').every(term => text.includes(term));
}

function catalogGroups(products) {
  const groups = new Map();
  for (const product of products) {
    const title = product.catalog_group?.trim();
    const key = title ? 'group:' + catalogText(title) : product.id;
    if (!groups.has(key)) groups.set(key, { key, title: title || product.name, items: [] });
    groups.get(key).items.push(product);
  }
  return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title, 'es'));
}

function orderArticleCode(item) {
  return item.price_unit_snapshot == null
    ? item.products?.product_code ?? ''
    : item.product_code_snapshot ?? '';
}

const catalogSections = Object.freeze({
  fresh: 'Fresco',
  seafood: 'Congelat - Marisc',
  cephalopods: 'Congelats - Cefalopode',
  'mixed-fish': 'Congelats - Peix Variat',
  prepared: 'Congelats - Elab Precuinats/Verdures'
});

function catalogSection(product) {
  return product.catalog_section ?? 'fresh';
}

function catalogNavigation() {
  return `<nav class="catalog-navigation" aria-label="Secciones del catálogo">
    <h4 id="catalogNavigationTitle" tabindex="-1">Elige una sección</h4>
    <div class="catalog-navigation-options" id="catalogMainChoices">
      <button type="button" data-catalog-location="fresh">Fresco</button>
      <button type="button" data-catalog-location="frozen">Congelado</button>
    </div>
    <div class="catalog-navigation-options hidden" id="catalogFrozenChoices">
      ${Object.entries(catalogSections).filter(([id]) => id !== 'fresh').map(([id, label]) =>
        `<button type="button" data-catalog-location="${id}">${label}</button>`).join('')}
    </div>
    <div class="row catalog-navigation-back" id="catalogBack">
      <button type="button" class="secondary" data-catalog-location="home">← Volver al inicio del catálogo</button>
      <button type="button" class="secondary" id="catalogBackToFrozen" data-catalog-location="frozen">← Volver a Congelado</button>
    </div>
  </nav>`;
}

function updateCatalogNavigation() {
  const home = catalogLocation === 'home';
  const frozen = catalogLocation === 'frozen';
  const label = catalogSections[catalogLocation];
  const heading = $('catalogNavigationTitle');
  heading.textContent = home ? 'Elige una sección' : 'Congelado';
  heading.classList.toggle('hidden', !home && !frozen);
  $('catalogMainChoices').classList.toggle('hidden', !home);
  $('catalogFrozenChoices').classList.toggle('hidden', !frozen);
  $('catalogBack').classList.toggle('hidden', home);
  $('catalogBackToFrozen').classList.toggle('hidden', home || frozen || catalogLocation === 'fresh');
  $('catalogBrowseResults').classList.toggle('hidden', !label);
  $('catalogSectionTitle').textContent = label ?? '';
}
