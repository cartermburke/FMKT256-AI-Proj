// Compact, URL-safe encoding of a game (config + action log) for shareable replays.
// The ticker is inside the encoded blob so blind games aren't spoiled by the link.

function toB64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64Url(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

const pctInt = (x) => Math.round(x * 100);

export function encodeReplay(cfg, actions) {
  const a = actions.map((act) => [
    act.stock === null || act.stock === undefined ? null : pctInt(act.stock),
    (act.legs || []).map((l) => `${l.side}${l.type}${l.strike}:${pctInt(l.notional)}`).join(","),
  ]);
  return toB64Url(JSON.stringify({ c: cfg, a }));
}

export function decodeReplay(s) {
  const { c, a } = JSON.parse(fromB64Url(s));
  const actions = a.map(([stock, legs]) => ({
    stock: stock === null ? null : stock / 100,
    legs: legs ? legs.split(",").map((x) => {
      const m = /^([BW])([CP])(\d+):(\d+)$/.exec(x);
      return { side: m[1], type: m[2], strike: Number(m[3]), notional: Number(m[4]) / 100 };
    }) : [],
  }));
  return { cfg: c, actions };
}
