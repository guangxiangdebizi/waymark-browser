import type { CapabilityManifest } from '../capabilities/CapabilityRegistry.js';
import type { IdlePlanner, IdleScene, IdleStep, Rect } from './IdleController.js';

/** The 0.4 behaviour: the pointer drifts to a point on plain background and rests there. It never clicks. */
export class DriftPlanner implements IdlePlanner {
  readonly manifest: CapabilityManifest = { id: 'idle.drift', version: '0.1.0', kind: 'action', runtime: 'node', dataEgress: 'local-only', description: 'The pointer drifts over page background while the agent thinks. Never clicks.' };
  plan(scene: IdleScene): IdleStep[] {
    const spot = pick(scene.spots);
    return spot ? [{ type: 'move', ...spot }] : [];
  }
  async invoke(scene: IdleScene): Promise<IdleStep[]> { return this.plan(scene); }
}

/**
 * What a person does while deciding: looks at what just appeared, reads with the pointer, rests, clicks on empty page,
 * scrolls a little and back, and now and then opens a link and comes back. Waymark enforces what each page allows and
 * undoes all of it before the agent's next call, so the agent always finds the page it left.
 */
export class AdaptivePlanner implements IdlePlanner {
  readonly manifest: CapabilityManifest = { id: 'idle.adaptive', version: '0.1.0', kind: 'action', runtime: 'node', dataEgress: 'local-only', description: 'Looks at new content, reads, clicks empty page, scrolls and briefly visits links while the agent thinks; undone before the agent acts.' };
  private attended = '';

  plan(scene: IdleScene): IdleStep[] {
    const fresh = scene.fresh.map(r => `${Math.round(r.x)},${Math.round(r.y)}`).join(';');
    if (fresh && fresh !== this.attended) {
      this.attended = fresh;
      return [{ type: 'move', ...inside(pick(scene.fresh)!) }, { type: 'pause', ms: between(300, 900) }];
    }
    // An agent gone quiet for minutes is not thinking: keep only the occasional drift.
    if (scene.sinceAgentMs > 120000) return Math.random() < 0.3 ? new DriftPlanner().plan(scene) : [];
    const choices: Array<[number, () => IdleStep[]]> = [
      [0.30, () => { const spot = pick(scene.spots); return spot ? [{ type: 'move', ...spot }, { type: 'pause', ms: between(200, 1200) }] : []; }],
      [0.25, () => this.read(scene)],
      [0.15, () => []],
      [scene.allow.scroll ? 0.12 : 0, () => { const dy = Math.round(between(120, 360)); return [{ type: 'scroll', dy }, { type: 'pause', ms: between(600, 1600) }, { type: 'scroll', dy: -dy }]; }],
      [scene.allow.click && scene.spots.length ? 0.12 : 0, () => { const spot = pick(scene.spots)!; return [{ type: 'move', ...spot }, { type: 'pause', ms: between(80, 300) }, { type: 'click', ...spot }]; }],
      [scene.allow.visit && scene.links.length && scene.sinceAgentMs > 1500 ? 0.06 : 0, () => [{ type: 'visit', link: Math.floor(Math.random() * scene.links.length), dwellMs: between(1500, 4000) }]]
    ];
    const total = choices.reduce((sum, [weight]) => sum + weight, 0);
    let roll = Math.random() * total;
    for (const [weight, build] of choices) { roll -= weight; if (roll < 0) return build(); }
    return [];
  }

  async invoke(scene: IdleScene): Promise<IdleStep[]> { return this.plan(scene); }

  /** A reading sweep: start at the left of a text block and move right in a few uneven steps. */
  private read(scene: IdleScene): IdleStep[] {
    const block = pick(scene.text);
    if (!block) return [];
    const y = block.y + Math.min(block.height - 2, 8 + Math.random() * Math.max(1, block.height - 16));
    const steps: IdleStep[] = [{ type: 'move', x: block.x + 6, y }];
    const hops = 2 + Math.floor(Math.random() * 3);
    for (let i = 1; i <= hops; i++) {
      steps.push({ type: 'pause', ms: between(150, 450) });
      steps.push({ type: 'move', x: Math.min(scene.viewport.width - 1, block.x + (block.width - 12) * (i / hops)), y: y + between(-3, 3) });
    }
    return steps;
  }
}

function inside(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width * (0.3 + Math.random() * 0.4), y: rect.y + rect.height * (0.3 + Math.random() * 0.4) };
}
function pick<T>(items: T[]): T | undefined { return items.length ? items[Math.floor(Math.random() * items.length)] : undefined; }
function between(min: number, max: number): number { return min + Math.random() * (max - min); }
