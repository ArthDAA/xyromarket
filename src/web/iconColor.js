import { PNG } from 'pngjs';

/**
 * Server-side "ambient color" for a guild card banner when the guild has no
 * real banner/splash (A36) — the average RGB of its icon, in place of the
 * flat gradient placeholder. Same trick as an album-art-derived background.
 * Forces `.png` regardless of whether the icon hash is animated (`a_...`) —
 * Discord's CDN happily serves the first frame as a static PNG for that
 * extension, which avoids writing a second, GIF, decoder for a value that's
 * only ever reduced to one averaged color anyway.
 */
const cache = new Map(); // `${guildId}:${iconHash}` -> '#rrggbb' | null
const MAX_CACHE_ENTRIES = 5000;

function staticIconUrl(guild, size = 32) {
  if (!guild?.id || !guild?.iconHash) return null;
  return `https://cdn.discordapp.com/icons/${guild.id}/${guild.iconHash}.png?size=${size}`;
}

async function computeAverageColor(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const png = PNG.sync.read(Buffer.from(await res.arrayBuffer()));
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    for (let i = 0; i < png.data.length; i += 4) {
      if (png.data[i + 3] < 128) continue; // skip transparent pixels — they'd skew the average toward black
      r += png.data[i];
      g += png.data[i + 1];
      b += png.data[i + 2];
      count += 1;
    }
    if (count === 0) return null;
    const toHex = (sum) => Math.round(sum / count).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  } catch {
    return null; // network hiccup or a malformed/unexpected response — never blocks the page on this
  }
}

/** Cached per guild+iconHash for the process's lifetime — an icon hash change is a new cache key, never a stale hit. */
export async function averageIconColorHex(guild) {
  if (!guild?.iconHash) return null;
  const key = `${guild.id}:${guild.iconHash}`;
  if (cache.has(key)) return cache.get(key);
  const hex = await computeAverageColor(staticIconUrl(guild));
  if (cache.size >= MAX_CACHE_ENTRIES) cache.clear(); // simplest possible bound — a refill is cheap and this should rarely even trigger
  cache.set(key, hex);
  return hex;
}

/**
 * Returns `guilds` with `avgColorHex` attached on every row that has no real
 * banner/splash (`guildBannerUrl` would resolve to nothing for it) and does
 * have an icon to average — used wherever a guild renders inside a
 * `cardHtml` banner. `mapRow` freezes its objects, so this always returns
 * shallow copies rather than mutating in place.
 */
export async function attachAvgColors(guilds) {
  return Promise.all(
    guilds.map(async (g) => {
      if (g.bannerHash || g.splashHash) return g;
      const avgColorHex = await averageIconColorHex(g);
      return avgColorHex ? { ...g, avgColorHex } : g;
    }),
  );
}
