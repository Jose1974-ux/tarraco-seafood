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
