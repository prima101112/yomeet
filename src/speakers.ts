// Works out who said each transcript line from Meet's caption updates.
// Captions show "Name: words" and update while that person talks, roughly 0.5-2 s behind the audio.
const SELF = new Set(['you', 'your presentation']); // the bot's own captions

export class Speakers {
  private events: { t: number; name: string }[] = [];
  private seen = new Set<string>();

  add(name: string, at: number) {
    if (!name || SELF.has(name.toLowerCase())) return;
    this.events.push({ t: at, name });
    this.seen.add(name);
    const cutoff = at - 10 * 60_000;
    while (this.events.length && this.events[0].t < cutoff) this.events.shift();
  }

  /** The only other person who spoke in the whole call, if there was exactly one. */
  onlyOther(): string | null {
    return this.seen.size === 1 ? [...this.seen][0] : null;
  }

  /** Name of whoever spoke between `start` and `end` (ms), or a fallback when captions don't say. */
  who(start: number, end: number): string {
    const counts = new Map<string, number>();
    for (const e of this.events) {
      if (e.t >= start + 200 && e.t <= end + 2500) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
    }
    let best: string | null = null;
    for (const [name, n] of counts) if (!best || n > counts.get(best)!) best = name;
    if (best) return best;
    if (this.seen.size === 1) return [...this.seen][0]; // only one other person has ever spoken
    return 'Participant';
  }
}
