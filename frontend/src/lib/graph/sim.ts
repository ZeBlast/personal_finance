/**
 * A small force simulation for the network graph, in the manner of Obsidian's graph view: nodes
 * push each other apart, links pull their ends together like springs, and a gentle pull keeps
 * everything near the center. It cools down and stops, and is woken again when something changes.
 *
 * Repulsion only looks at nearby nodes (a grid of cells), so thousands of nodes stay smooth.
 */

export interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Held in place (being dragged). */
  fixed: boolean;
  radius: number;
  /** How hard it pushes others away (1 for a big node; small nodes push gently). */
  charge: number;
}

export interface SimLink {
  source: string;
  target: string;
  /** Rest length. */
  distance: number;
  /** 0 to 1. */
  strength: number;
}

export interface Forces {
  /** How strongly nodes push apart. */
  repel: number;
  /** How strongly links pull. */
  link: number;
  /** How strongly everything is pulled to the center. */
  center: number;
  /** Multiplies every link's rest length. */
  linkDistance: number;
}

export const DEFAULT_FORCES: Forces = { repel: 1, link: 1, center: 0.5, linkDistance: 1 };

const REPEL_RANGE = 420;
const VELOCITY_DECAY = 0.6;
const ALPHA_MIN = 0.002;
/** No node moves further than this in one step, so nothing ever flies off. */
const MAX_SPEED = 10;
/** The golden angle: children placed at multiples of it spread evenly round their parent. */
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

export class Simulation {
  nodes = new Map<string, SimNode>();
  links: SimLink[] = [];
  forces: Forces = { ...DEFAULT_FORCES };
  /** How "hot" the layout is: 1 moves freely, near 0 it has settled. */
  alpha = 1;

  /**
   * Replaces the nodes and links. Nodes that were already there keep their place. New ones start
   * already spread out in a spiral round a neighbour that has a place (a group's transactions
   * round the group), so they do not start on top of each other and burst apart.
   */
  setGraph(
    nodes: Array<{ id: string; radius: number; charge?: number }>,
    links: SimLink[],
    reheat = 0.6,
  ): void {
    const next = new Map<string, SimNode>();
    const placed = (id: string) => next.get(id) ?? this.nodes.get(id);
    let ring = 0;
    /** How many new nodes each parent has been given so far. */
    const children = new Map<string, number>();
    const linkOf = new Map<string, SimLink[]>();
    for (const l of links) {
      for (const end of [l.source, l.target]) {
        const list = linkOf.get(end);
        if (list) list.push(l);
        else linkOf.set(end, [l]);
      }
    }
    for (const n of nodes) {
      const old = this.nodes.get(n.id);
      if (old) {
        next.set(n.id, { ...old, radius: n.radius, charge: n.charge ?? 1 });
        continue;
      }
      const link = (linkOf.get(n.id) ?? []).find((l) =>
        placed(l.source === n.id ? l.target : l.source),
      );
      const parent = link ? placed(link.source === n.id ? link.target : link.source) : undefined;
      let at: { x: number; y: number };
      if (parent && link) {
        const i = children.get(parent.id) ?? 0;
        children.set(parent.id, i + 1);
        // A sunflower spiral round the parent, starting at the link's length.
        const r = link.distance * 0.8 + 7 * Math.sqrt(i);
        const angle = i * GOLDEN;
        at = { x: parent.x + Math.cos(angle) * r, y: parent.y + Math.sin(angle) * r };
      } else {
        at = { x: Math.cos(ring) * 150, y: Math.sin(ring) * 150 };
        ring += GOLDEN;
      }
      next.set(n.id, {
        id: n.id,
        ...at,
        vx: 0,
        vy: 0,
        fixed: false,
        radius: n.radius,
        charge: n.charge ?? 1,
      });
    }
    this.nodes = next;
    this.links = links.filter((l) => next.has(l.source) && next.has(l.target));
    this.alpha = Math.max(this.alpha, reheat);
  }

  /** Whether it is still moving. */
  get running(): boolean {
    return this.alpha > ALPHA_MIN;
  }

  reheat(to = 0.5): void {
    this.alpha = Math.max(this.alpha, to);
  }

  /** One step. */
  tick(): void {
    if (!this.running) return;
    const { repel, link, center, linkDistance } = this.forces;
    const alpha = this.alpha;
    const list = [...this.nodes.values()];

    // Repulsion between nearby nodes, through a grid of cells.
    const cell = REPEL_RANGE;
    const grid = new Map<string, SimNode[]>();
    for (const n of list) {
      const key = `${Math.floor(n.x / cell)},${Math.floor(n.y / cell)}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(n);
      else grid.set(key, [n]);
    }
    const strength = 2600 * repel * alpha;
    for (const n of list) {
      const cx = Math.floor(n.x / cell);
      const cy = Math.floor(n.y / cell);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const bucket = grid.get(`${cx + dx},${cy + dy}`);
          if (!bucket) continue;
          for (const m of bucket) {
            if (m === n) continue;
            let x = n.x - m.x;
            let y = n.y - m.y;
            let d2 = x * x + y * y;
            if (d2 === 0) {
              x = Math.random() - 0.5;
              y = Math.random() - 0.5;
              d2 = x * x + y * y;
            }
            if (d2 > REPEL_RANGE * REPEL_RANGE) continue;
            const d = Math.sqrt(d2);
            const minGap = n.radius + m.radius + 4;
            // Repulsion by the other node's charge; never stronger than at touching distance, so
            // two nodes close together do not shoot apart.
            let push = (strength * m.charge) / Math.max(d2, minGap * minGap);
            // Overlapping nodes are eased apart by how much they overlap.
            if (d < minGap) push += (minGap - d) * 0.25;
            n.vx += (x / d) * push;
            n.vy += (y / d) * push;
          }
        }
      }
    }

    // Links pull toward their rest length.
    for (const l of this.links) {
      const a = this.nodes.get(l.source)!;
      const b = this.nodes.get(l.target)!;
      const x = b.x - a.x;
      const y = b.y - a.y;
      const d = Math.sqrt(x * x + y * y) || 1;
      const pull = ((d - l.distance * linkDistance) / d) * l.strength * link * alpha * 0.5;
      a.vx += x * pull;
      a.vy += y * pull;
      b.vx -= x * pull;
      b.vy -= y * pull;
    }

    // Toward the center, and move.
    for (const n of list) {
      n.vx -= n.x * 0.01 * center * alpha;
      n.vy -= n.y * 0.01 * center * alpha;
      if (n.fixed) {
        n.vx = 0;
        n.vy = 0;
        continue;
      }
      n.vx *= VELOCITY_DECAY;
      n.vy *= VELOCITY_DECAY;
      const speed = Math.hypot(n.vx, n.vy);
      if (speed > MAX_SPEED) {
        n.vx *= MAX_SPEED / speed;
        n.vy *= MAX_SPEED / speed;
      }
      n.x += n.vx;
      n.y += n.vy;
    }
    this.alpha *= 0.985;
  }

  /** The node under a point, if any (the top-most, smallest first when they overlap). */
  nodeAt(x: number, y: number, slop = 0): SimNode | undefined {
    let best: SimNode | undefined;
    let bestD = Infinity;
    for (const n of this.nodes.values()) {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d <= n.radius + slop && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }
}
