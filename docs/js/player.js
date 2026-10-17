// Playback planning. The mask cycles through a PLAY list on its own, about one entry per
// second, without the flicker that every new PLAY command causes. So playback sends lists
// of up to 10 slots, repeating a frame to make it last longer, and sends a new list only
// when the previous one is nearly done.

export const MAX_PLAY = 10; // slots that fit in one PLAY command
export const SPEEDS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 45, 60]; // seconds per frame

/**
 * Endless (or, for mode "once", finite) sequence of frame indices, one per mask tick.
 * Each frame is repeated `reps` ticks. Modes: once, loop, pingpong.
 */
export function makeTimeline(n, reps, mode, start = 0) {
  let idx = Math.max(0, Math.min(n - 1, start));
  let dir = 1;
  let rep = 0;
  let ended = false;
  return {
    get ended() { return ended; },
    next() {
      if (ended) return null;
      const out = idx;
      if (++rep >= reps) {
        rep = 0;
        let nx = idx + dir;
        if (nx >= n || nx < 0) {
          if (mode === 'once') { ended = true; return out; }
          if (mode === 'loop') nx = 0;
          else { dir = -dir; nx = Math.max(0, Math.min(n - 1, idx + dir)); }
        }
        idx = nx;
      }
      return out;
    },
  };
}

/**
 * Next list of frame indices to hand to the mask: up to 9 new entries plus the last one again.
 * The follow-up command is sent during that final duplicate, so arriving a bit early or late
 * never shows an older frame. Returns { entries, ticks } (ticks = new entries) or null when done.
 */
export function nextSegment(timeline) {
  const entries = [];
  while (entries.length < MAX_PLAY - 1) {
    const f = timeline.next();
    if (f === null) break;
    entries.push(f);
  }
  if (!entries.length) return null;
  return { entries: [...entries, entries[entries.length - 1]], ticks: entries.length };
}

/**
 * For repeating modes, the whole cycle if it fits into a single PLAY list (then the mask
 * loops it by itself forever, with no further commands). Otherwise null.
 */
export function wholeCycle(n, reps, mode) {
  if (mode === 'once') return null;
  const up = Array.from({ length: n }, (_, i) => i);
  const order = mode === 'loop' || n < 3 ? up : [...up, ...up.slice(1, -1).reverse()];
  const entries = order.flatMap((f) => Array(reps).fill(f));
  return entries.length <= MAX_PLAY ? entries : null;
}
