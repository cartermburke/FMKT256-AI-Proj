// Loads the committed JSON data (written by scripts/fetch_data.py via GitHub Actions).
const cache = new Map();

async function getJSON(path) {
  if (cache.has(path)) return cache.get(path);
  const p = fetch(path, { cache: "no-cache" }).then((r) => {
    if (!r.ok) throw new Error(`Failed to load ${path} (${r.status})`);
    return r.json();
  });
  cache.set(path, p);
  try {
    return await p;
  } catch (e) {
    cache.delete(path);
    throw e;
  }
}

export const loadMeta = () => getJSON("data/meta.json");
export const loadSeries = (file) => getJSON(`data/prices/${file}.json`);

/** Everything needed to build markets for a stock: the stock plus SPY, VIX and the T-bill yield. */
export async function loadBundle(symbol) {
  const [stock, spy, vix, irx] = await Promise.all([
    loadSeries(symbol.replace("^", "")),
    loadSeries("SPY"),
    loadSeries("VIX"),
    loadSeries("IRX"),
  ]);
  return { stock, spy, vix, irx };
}
