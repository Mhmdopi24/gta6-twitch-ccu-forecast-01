// GTA VI launch-day Twitch viewers, hour by hour (hours 2..24).
//
// Forecast for make.fun competition gta6-twitch-ccu-forecast-01.
// Reads one case file per run (schema "makefun/twitch-ccu-case/v1") from
// $MAKEFUN_INPUT_DIR (else /input) and writes one forecast file per case
// to $MAKEFUN_OUTPUT_DIR (else /output).
//
// Method: for every console-only past big launch in the case's
// comparables, take the hourly viewer count of its release day as a
// ratio to its own hour-1 print, in logs. Launches whose hour-1 print
// is tiny, or whose day peaks many times above hour 1, are launches
// whose real unlock fell later in the UTC day (a single global unlock
// time, early access, or a free-to-play spike), so their shape does not
// describe a rolling midnight-local console launch and they are left
// out. The surviving launches give, per hour, a weighted median log
// ratio (midnight-unlock launches weigh more, as do the biggest
// launches) and a spread from their dispersion. The forecast median
// anchors on this case's own hour-1 print, plus a late-day lift when
// hour 1 came in below the pre-midnight evening (a trough before the
// US unlocks). Quantiles are lognormal around that median, with a
// spread that grows over the day. Everything is deterministic: no
// randomness, no network, standard library only.

import * as fs from "node:fs";
import * as path from "node:path";

const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];
const HOURS = 24;

type HourlyPoint = { from: string; viewers: number; channels?: number | null };
type Comparable = {
  name: string;
  day_start: string;
  unlock?: string;
  platforms?: string;
  hourly: HourlyPoint[];
};
type CaseFile = {
  id: string;
  game: { name: string; twitch_id: string };
  day_start: string;
  checkpoint: string;
  levels: number[];
  known: { hour: number; from: string; until: string; viewers: number; channels?: number | null; reads?: number }[];
  forecast: { hour: number; from: string; until: string }[];
  history: { at: string; viewers: number; channels?: number | null }[];
  history_hourly: { from: string; viewers: number; channels?: number | null; reads?: number }[];
  streams: unknown;
  categories_hourly: unknown;
  comparables: Comparable[];
  notes: string;
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const xs = [...values].sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function weightedMedian(pairs: { v: number; w: number }[]): number {
  if (pairs.length === 0) return 0;
  const sorted = [...pairs].sort((a, b) => a.v - b.v);
  const total = sorted.reduce((s, p) => s + p.w, 0);
  let acc = 0;
  for (const p of sorted) {
    acc += p.w;
    if (acc >= total / 2) return p.v;
  }
  return sorted[sorted.length - 1].v;
}

function weightedQuantile(pairs: { v: number; w: number }[], q: number): number {
  if (pairs.length === 0) return 0;
  const sorted = [...pairs].sort((a, b) => a.v - b.v);
  const total = sorted.reduce((s, p) => s + p.w, 0);
  let acc = 0;
  for (const p of sorted) {
    acc += p.w;
    if (acc >= total * q) return p.v;
  }
  return sorted[sorted.length - 1].v;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function hourMs(iso: string): number {
  return Date.parse(iso);
}

// Release-day log ratios for one comparable launch, keyed by hour 2..24.
// Returns null when the launch cannot anchor a ratio curve.
// Only console-only launches are kept: GTA VI is PlayStation 5 / Xbox
// Series only, and multi-platform (PC) launches follow a different
// day shape — their global simultaneous unlocks and PC audiences make
// their curves fall through the UTC day instead of rising into the US
// unlocks. Also left out: launches with a tiny hour-1 print, or whose
// day peaks many times above hour 1 (their real unlock fell later in
// the UTC day: a single global unlock time, early access, or a
// free-to-play spike), so their shape does not describe a rolling
// midnight-local console launch.
function comparableRatios(c: Comparable): { ratios: Map<number, number>; weight: number } | null {
  const plats = (c.platforms ?? "").toLowerCase();
  if (plats.length === 0 || plats.includes("pc")) return null;
  const dayStart = hourMs(c.day_start);
  if (!Number.isFinite(dayStart)) return null;
  const byHour = new Map<number, number>();
  for (const p of c.hourly ?? []) {
    if (typeof p?.viewers !== "number" || !(p.viewers > 0)) continue;
    const t = hourMs(p.from);
    if (!Number.isFinite(t)) continue;
    const h = Math.round((t - dayStart) / 3600000) + 1;
    if (h >= 1 && h <= HOURS) byHour.set(h, p.viewers);
  }
  const p1 = byHour.get(1);
  if (p1 === undefined || p1 < 10000) return null;
  let peak = 0;
  for (const v of byHour.values()) peak = Math.max(peak, v);
  if (peak <= 0 || peak / p1 > 4) return null;
  const midnight = (c.unlock ?? "").toLowerCase().includes("midnight");
  let weight = midnight ? 1.5 : 1.0;
  if (p1 >= 100000) weight *= 1.25;
  const ratios = new Map<number, number>();
  for (let h = 2; h <= HOURS; h++) {
    const v = byHour.get(h);
    if (v !== undefined && v > 0) ratios.set(h, Math.log(v / p1));
  }
  if (ratios.size < 12) return null;
  return { ratios, weight };
}

// The case's own pre-midnight trend: log of hour-1 print over the median
// of the last two whole-hour means before the release day began. A
// steep fall into hour 1 says the evening hype peak is draining and
// hour 1 is a trough: the US unlocks later in the day then lift the
// audience much further above hour 1 than the cross-launch curve alone
// says. The lift below only fires when the trend is negative, grows
// after hour 5 (the first US unlock), and is capped by the clamp here.
function preTrend(kase: CaseFile, p1: number): number {
  const dayStart = hourMs(kase.day_start);
  const before: number[] = [];
  for (const row of kase.history_hourly ?? []) {
    if (typeof row?.viewers !== "number" || !(row.viewers > 0)) continue;
    const t = hourMs(row.from);
    if (Number.isFinite(t) && t < dayStart) before.push(row.viewers);
  }
  if (before.length < 2 || p1 <= 0) return 0;
  const recent = before.slice(-2);
  const base = median(recent);
  if (!(base > 0)) return 0;
  return clamp(Math.log(p1 / base), -1.2, 0.6);
}

function forecastCase(kase: CaseFile): { hours: { hour: number; q: number[] }[] } {
  const p1 = Math.max(1, kase.known?.[0]?.viewers ?? 1);
  const trend = preTrend(kase, p1);

  // Collect weighted log ratios per hour across the usable comparables.
  const perHour: { v: number; w: number }[][] = Array.from({ length: HOURS + 1 }, () => []);
  for (const c of kase.comparables ?? []) {
    const r = comparableRatios(c);
    if (!r) continue;
    for (const [h, lr] of r.ratios) perHour[h].push({ v: lr, w: r.weight });
  }

  const hours: { hour: number; q: number[] }[] = [];
  let prevMed = 0;
  for (let h = 2; h <= HOURS; h++) {
    const pairs = perHour[h];
    let logRatio: number;
    let spread: number;
    if (pairs.length >= 3) {
      logRatio = weightedMedian(pairs);
      const q25 = weightedQuantile(pairs, 0.25);
      const q75 = weightedQuantile(pairs, 0.75);
      const iqr = Math.max(0, q75 - q25);
      // Lognormal sigma implied by the interquartile range.
      spread = iqr / 1.349;
    } else if (pairs.length > 0) {
      logRatio = weightedMedian(pairs);
      spread = 0.35;
    } else {
      // No comparable reported this hour: carry the previous hour's
      // median ratio forward rather than inventing a shape.
      logRatio = prevMed;
      spread = 0.45;
    }
    prevMed = logRatio;

    // Late-day lift when hour 1 came in below the pre-midnight evening:
    // the trough means the US unlocks lift the day further above hour 1.
    // Zero when hour 1 met or beat the evening level.
    const lift = Math.max(0, -trend) * Math.max(0, (h - 5) / 16);
    const med = Math.log(p1) + logRatio + lift;

    // Spread widens over the day, roughly with sqrt(h - 1), and never
    // below a floor that keeps the 90% band honest.
    const grow = 0.10 + 0.08 * Math.sqrt(h - 1);
    const s = clamp(Math.max(spread, grow), 0.18, 1.05);

    const q = Z.map((z) => {
      const v = Math.exp(med + z * s);
      return clamp(Math.round(v * 100) / 100, 0.01, 1_000_000_000);
    });
    // Enforce non-decreasing quantiles after rounding.
    for (let i = 1; i < q.length; i++) q[i] = Math.max(q[i], q[i - 1]);
    hours.push({ hour: h, q });
  }
  return { hours };
}

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  fs.mkdirSync(outputDir, { recursive: true });
  const files = fs
    .readdirSync(inputDir)
    .filter((f) => f.endsWith(".in"))
    .sort();
  for (const file of files) {
    const kase = JSON.parse(fs.readFileSync(path.join(inputDir, file), "utf8")) as CaseFile;
    const out = forecastCase(kase);
    const id = file.replace(/\.in$/, "");
    fs.writeFileSync(path.join(outputDir, `${id}.out`), JSON.stringify(out), "utf8");
  }
}

main();
