import { useEffect, useRef, useState } from 'preact/hooks';
import type { RuntimeTransfer } from '../../../src/runtime-dashboard.ts';
import { routeHandoff, type Rect, type Point } from './handoff-routing.ts';

type Connection = RuntimeTransfer & { projectId: string };
type Line = {
  id: string;
  transferId: string;
  projectId: string;
  from: string;
  to: string;
  path: string;
  label: string;
  labelAt?: Point;
};
const labelSize = { width: 116, height: 28 };
const obstacleSelector = [
  '.seat-speech', '.figure-crop', '.seat-console', '.halo-value',
  '.room-heading > :not(.handoff-references)', '.handoff-caption',
  '.handoff-identity', '.room-project-progress', '.room-footer', '.room-dispatch',
].join(',');

/** Measures each room once per layout change; live text and progress reuse cached routes. */
export function HandoffConnections({ connections, active }: {
  connections: Connection[];
  active: Set<string>;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const cache = useRef(new Map<string, {
    signature: string;
    route: ReturnType<typeof routeHandoff>;
  }>());
  // Object identity changes with live snapshots; geometry depends only on the handoff topology.
  const topology = JSON.stringify(connections.map(({ id, projectId, from, to, label }) =>
    [id, projectId, from, to, label],
  ));
  useEffect(() => {
    const root = document.getElementById('runtime-map');
    if (!root) return;
    let frame = 0;
    let disposed = false;
    const observed = new Set<Element>();
    const schedule = () => {
      if (!frame && !disposed) frame = requestAnimationFrame(calculate);
    };
    const resize = new ResizeObserver(schedule);
    const measure = (el: Element, origin: DOMRect): Rect | undefined => {
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) return;
      // Quarter pixels keep signatures stable without visibly shifting endpoints.
      const round = (n: number) => Math.round(n * 4) / 4;
      return {
        left: round(box.left - origin.left), top: round(box.top - origin.top),
        right: round(box.right - origin.left), bottom: round(box.bottom - origin.top),
      };
    };
    function calculate() {
      frame = 0;
      if (disposed) return;
      const origin = root!.getBoundingClientRect();
      const rooms = new Map<string, {
        bounds: Rect;
        obstacles: Rect[];
        endpoints: Map<string, Rect>;
      }>();
      const watch = new Set<Element>([root!]);
      const wanted = new Set(connections.map((connection) => connection.projectId));
      for (const room of Array.from(root!.querySelectorAll<HTMLElement>('[data-project]'))) {
        if (!wanted.has(room.dataset.project!)) continue;
        const bounds = measure(room, origin);
        if (!bounds) continue;
        watch.add(room);
        const obstacles: Rect[] = [];
        for (const element of Array.from(room.querySelectorAll(obstacleSelector))) {
          watch.add(element);
          const box = measure(element, origin);
          if (!box) continue;
          // Include the speech bubble's tail, which is a CSS pseudo element.
          if (element.classList.contains('seat-speech')) box.bottom += 10;
          obstacles.push(box);
        }
        const endpoints = new Map<string, Rect>();
        for (const figure of Array.from(room.querySelectorAll<HTMLElement>('[data-agent]'))) {
          const endpoint = figure.querySelector('.person-halo') ?? figure;
          watch.add(endpoint);
          const box = measure(endpoint, origin);
          if (box) endpoints.set(figure.dataset.agent!, box);
        }
        rooms.set(room.dataset.project!, {
          bounds: {
            left: bounds.left + 8, top: bounds.top + 8,
            right: bounds.right - 8, bottom: bounds.bottom - 8,
          },
          obstacles, endpoints,
        });
      }
      for (const element of observed) {
        if (!watch.has(element)) { resize.unobserve(element); observed.delete(element); }
      }
      for (const element of watch) {
        if (!observed.has(element)) { resize.observe(element); observed.add(element); }
      }
      const next: Line[] = [];
      const retained = new Set<string>();
      for (const connection of connections) {
        const room = rooms.get(connection.projectId);
        const from = room?.endpoints.get(connection.from);
        const to = room?.endpoints.get(connection.to);
        if (!room || !from || !to) continue;
        const id = `${connection.projectId}-${connection.id}`;
        retained.add(id);
        const obstacles = [
          ...room.obstacles,
          ...[...room.endpoints].filter(([employee]) =>
            employee !== connection.from && employee !== connection.to,
          ).map(([, box]) => box),
        ];
        const input = { from, to, bounds: room.bounds, obstacles, labelSize };
        const signature = JSON.stringify(input);
        const previous = cache.current.get(id);
        const route = previous?.signature === signature ? previous.route : routeHandoff(input);
        if (previous?.signature !== signature) cache.current.set(id, { signature, route });
        // A missing safe route never falls back to drawing over a person or a card.
        if (route) next.push({
          id, transferId: connection.id, projectId: connection.projectId,
          from: connection.from, to: connection.to, path: route.path,
          label: connection.label, labelAt: route.label,
        });
      }
      for (const id of cache.current.keys()) if (!retained.has(id)) cache.current.delete(id);
      setLines((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    }
    const mutation = new MutationObserver((records) => {
      if (records.some((record) => !(record.target instanceof Element
        ? record.target : record.target.parentElement)?.closest('.runtime-connections'))) schedule();
    });
    mutation.observe(root, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'open'],
    });
    window.addEventListener('resize', schedule);
    void document.fonts.ready.then(schedule);
    schedule();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [topology]);
  return (
    <svg class="runtime-connections" aria-hidden="true">
      <defs>
        <marker id="flow-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="userSpaceOnUse">
          <path d="M0 0L7 3.5L0 7Z" fill="#8c8ab5" />
        </marker>
      </defs>
      {lines.map((line) => (
        <g key={line.id} class={active.has(line.transferId) ? 'flow-active' : 'flow-context'}
          data-flow-project={line.projectId} data-flow-from={line.from} data-flow-to={line.to}>
          <path class="flow-halo" d={line.path} />
          <path id={`flow-${line.id}`} class="flow-path" d={line.path} marker-end="url(#flow-arrow)" />
          {active.has(line.transferId) ? (
            <circle r="4" class="flow-dot">
              <animateMotion dur="2s" repeatCount="1" fill="freeze">
                <mpath href={`#flow-${line.id}`} />
              </animateMotion>
            </circle>
          ) : null}
          {active.has(line.transferId) && line.labelAt ? (
            <g class="flow-label" transform={`translate(${line.labelAt.x - labelSize.width / 2},${line.labelAt.y - labelSize.height / 2})`}>
              <rect class="flow-label-bg" width={labelSize.width} height={labelSize.height} rx="14" />
              <text x={labelSize.width / 2} y="19" text-anchor="middle">{line.label}</text>
            </g>
          ) : null}
        </g>
      ))}
    </svg>
  );
}
