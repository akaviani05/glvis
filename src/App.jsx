import React, { useEffect, useRef, useState } from "react";
import jsyaml from "js-yaml";

// Single-file React component. Drop into a Create React App / Vite + React project.
// Tailwind classes are used for styling but component will work without Tailwind.

export default function DirectedGraphDrawer() {
  const svgRef = useRef(null);
  const containerRef = useRef(null);
  const [rawYaml, setRawYaml] = useState("");
  const [frames, setFrames] = useState([]); // array of frames
  const [currentFrameIdx, setCurrentFrameIdx] = useState(0);
  const [graph, setGraph] = useState(null); // { nodes: number[], edges: [u,v][] }
  const [positions, setPositions] = useState({}); // id -> {x,y,locked}
  const positionsRef = useRef({});
  const sourcesOrderedRef = useRef([]);   // persistent source order across frames
  const sourceColorsRef = useRef({});     // persistent color mapping across frames
  const [view, setView] = useState({ tx: 100, ty: 0, scale: 0.9 }); // centered with left margin
  const draggingRef = useRef({ id: null, ox: 0, oy: 0 });
  const pointerOwner = useRef(null);

  const [layoutAlgo, setLayoutAlgo] = useState("layered");
  const [forceRunning, setForceRunning] = useState(false);
  // load mode: 'random' -> log/{n}_{k}_{idx}.yml
  //            'three'  -> log/TL_{n}_{k}_{idx}.yml
  //            'file'   -> choose local file
  const [loadMode, setLoadMode] = useState("three");
  const [nInput, setNInput] = useState("");
  const [kInput, setKInput] = useState("");
  const [idxInput, setIdxInput] = useState("");

  // visual constants
  const NODE_RADIUS = 30; // makes nodes larger
  const NODE_FONT = 16;

  // color palette and helper (10 base colors; generate extra via HSL)
  const BASE_COLORS = [
    "#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
    "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf",
  ];
  function getColorByIndex(i) {
    if (i < BASE_COLORS.length) return BASE_COLORS[i];
    // generate additional distinct colors via HSL
    const hue = (i * 37) % 360; // coarse equidistribution
    return `hsl(${hue} 65% 50%)`;
  }

  // centralised YAML parsing / frame setup used by both file reader and fetch-by-path
  function parseYamlText(text) {
    setRawYaml(text);
    try {
      const docs = jsyaml.loadAll(text);
      const parsedFrames = docs.map((doc) => {
        const edges = (doc && doc.edges) || [];
        const parsedEdges = edges.map((p) => {
          const u = Number(p[0]);
          const v = Number(p[1]);
          const col = p[2] !== undefined && p[2] !== null ? String(p[2]) : undefined;
          return col ? [u, v, col] : [u, v, "#333"];
        });
        const nodesSet = new Set();
        parsedEdges.forEach(([u, v]) => {
          nodesSet.add(u);
          nodesSet.add(v);
        });
        const nodes = Array.from(nodesSet).sort((a, b) => a - b);

        const niRaw = doc && doc.ni ? doc.ni : {};
        const ni = {};
        Object.entries(niRaw).forEach(([k, val]) => {
          const m = k.match(/^source_(\d+)$/);
          if (m) ni[Number(m[1])] = Number(val);
          else ni[k] = val;
        });

        const assignRaw = doc && doc.assignment && doc.assignment.assignable_nodes ? doc.assignment.assignable_nodes : {};
        const assignable = {};
        Object.entries(assignRaw).forEach(([sk, arr]) => {
          const m = sk.match(/^source_(\d+)$/);
          if (!m) return;
          const sid = Number(m[1]);
          (arr || []).forEach((nodeId) => {
            const nid = Number(nodeId);
            if (!assignable[nid]) assignable[nid] = [];
            if (!assignable[nid].includes(sid)) assignable[nid].push(sid);
          });
        });

        return {
          nodes,
          edges: parsedEdges,
          metadata: doc.metadata || {},
          label: doc.label || "",
          event_id: doc.event_id || null,
          ni,
          assignable,
        };
      });

      // Precompute positions
      const container = svgRef.current || containerRef.current;
      const rect = container ? container.getBoundingClientRect() : { width: 1000, height: 600 };
      let prevPositions = {};
      const framesWithPositions = parsedFrames.map((frame) => {
        const computed = computePositionsForAlgorithm(frame.nodes, frame.edges, layoutAlgo, rect.width, rect.height);
        const merged = {};
        frame.nodes.forEach((id) => {
          if (prevPositions[id]) merged[id] = prevPositions[id];
          else merged[id] = computed[id] || { x: rect.width / 2, y: rect.height / 2, locked: false };
        });
        prevPositions = { ...prevPositions };
        frame.nodes.forEach((id) => {
          prevPositions[id] = merged[id];
        });
        return { ...frame, positions: merged };
      });

      // compute global stable source set/colors across all parsed frames
      const allSourceSet = new Set();
      parsedFrames.forEach((f) => Object.keys(f.ni || {}).forEach((k) => allSourceSet.add(Number(k))));
      const sourcesOrderedGlobal = Array.from(allSourceSet).sort((a, b) => a - b);
      const sourceColorsGlobal = {};
      sourcesOrderedGlobal.forEach((s, idx) => (sourceColorsGlobal[s] = getColorByIndex(idx)));
      sourcesOrderedRef.current = sourcesOrderedGlobal;
      sourceColorsRef.current = sourceColorsGlobal;

      setFrames(framesWithPositions);
      setCurrentFrameIdx(0);
      if (framesWithPositions.length > 0) {
        const f0 = framesWithPositions[0];
        setGraph({
          nodes: f0.nodes,
          edges: f0.edges,
          ni: f0.ni || {},
          assignable: f0.assignable || {},
          sourcesOrdered: sourcesOrderedRef.current,
          sourceColors: sourceColorsRef.current,
        });
        setPositions(f0.positions);
        positionsRef.current = f0.positions;
      }
    } catch (err) {
      alert("Failed to parse YAML: " + (err && err.message ? err.message : String(err)));
    }
  }

  // Read uploaded file with multiple frames
  function handleFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = (ev) => parseYamlText(ev.target.result);
    reader.readAsText(f);
  }

  // loadFromPath optionally accepts overrides (n,k,idx,mode) otherwise uses state inputs and loadMode
  async function loadFromPath(ov = null) {
    const n = ov && ov.n !== undefined ? String(ov.n).trim() : nInput.trim();
    const k = ov && ov.k !== undefined ? String(ov.k).trim() : kInput.trim();
    const idx = ov && ov.idx !== undefined ? String(ov.idx).trim() : idxInput.trim();
    const mode = ov && ov.mode ? ov.mode : loadMode;
    if (!n || !k || !idx) {
      alert("Please fill n, k and idx.");
      return;
    }
    let path;
    if (mode === "random") path = `log/${n}_${k}_${idx}.yml`;
    else if (mode === "three") path = `log/TL_${n}_${k}_${idx}.yml`;
    else {
      alert("Invalid mode for loadFromPath");
      return;
    }
    try {
      const resp = await fetch(path);
      if (!resp.ok) throw new Error(`Failed to fetch ${path}: ${resp.statusText}`);
      const text = await resp.text();
      // keep UI inputs in sync when overrides provided
      if (ov) {
        setNInput(String(n));
        setKInput(String(k));
        setIdxInput(String(idx));
      }
      parseYamlText(text);
    } catch (err) {
      alert("Failed to load file by path: " + (err && err.message ? err.message : String(err)));
    }
  }

  // increment idx by 1 and load next example; starts from beginning (parseYamlText resets frames)
  function loadNextExample() {
    const n = nInput.trim();
    const k = kInput.trim();
    const idxRaw = idxInput.trim();
    if (!n || !k || !idxRaw) {
      alert("Please fill n, k and idx.");
      return;
    }
    const cur = parseInt(idxRaw, 10);
    const next = Number.isNaN(cur) ? 1 : cur + 1;
    // update state and load using current loadMode
    setIdxInput(String(next));
    loadFromPath({ n, k, idx: String(next), mode: loadMode });
  }

  // listen for Enter key to trigger loadNextExample when a path-mode (not 'file') is selected
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Enter" && loadMode !== "file") {
        e.preventDefault();
        loadNextExample();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [loadMode, nInput, kInput, idxInput]);

  // Utility: build adjacency list
  function buildAdj(nodes, edges) {
    const adj = new Map();
    nodes.forEach((v) => adj.set(v, []));
    edges.forEach(([u, v]) => {
      if (!adj.has(u)) adj.set(u, []);
      adj.get(u).push(v);
      if (!adj.has(v)) adj.set(v, []);
    });
    return adj;
  }

  // Tarjan SCC
  function tarjanSCC(nodes, adj) {
    const index = new Map();
    const lowlink = new Map();
    const onstack = new Map();
    const stack = [];
    let idx = 0;
    const comps = [];

    function dfs(v) {
      index.set(v, idx);
      lowlink.set(v, idx);
      idx += 1;
      stack.push(v);
      onstack.set(v, true);
      const neighbors = adj.get(v) || [];
      for (const w of neighbors) {
        if (!index.has(w)) {
          dfs(w);
          lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
        } else if (onstack.get(w)) {
          lowlink.set(v, Math.min(lowlink.get(v), index.get(w)));
        }
      }
      if (lowlink.get(v) === index.get(v)) {
        const comp = [];
        while (true) {
          const w = stack.pop();
          onstack.set(w, false);
          comp.push(w);
          if (w === v) break;
        }
        comps.push(comp);
      }
    }

    for (const v of nodes) if (!index.has(v)) dfs(v);
    return comps; // list of components, each is array of nodes
  }

  // Build SCC DAG and compute longest distance from any source (source dist 0)
  function computeLayers(nodes, edges) {
    const adj = buildAdj(nodes, edges);
    const sccs = tarjanSCC(nodes, adj);
    // map node -> compIndex
    const compIndex = new Map();
    sccs.forEach((comp, idx) => comp.forEach((v) => compIndex.set(v, idx)));
    const compCount = sccs.length;

    const cadj = Array.from({ length: compCount }, () => new Set());
    const indeg = Array.from({ length: compCount }, () => 0);
    edges.forEach(([u, v]) => {
      const cu = compIndex.get(u);
      const cv = compIndex.get(v);
      if (cu !== cv && !cadj[cu].has(cv)) {
        cadj[cu].add(cv);
        indeg[cv]++;
      }
    });

    // topological order (Kahn)
    const queue = [];
    for (let i = 0; i < compCount; i++) if (indeg[i] === 0) queue.push(i);
    const topo = [];
    while (queue.length) {
      const x = queue.shift();
      topo.push(x);
      for (const y of cadj[x]) {
        indeg[y]--;
        if (indeg[y] === 0) queue.push(y);
      }
    }

    // longest path from any source: initialize dist[source]=0, others=-inf
    const dist = Array.from({ length: compCount }, () => -Infinity);
    // sources are those with no incoming edges in original indeg array (we recompute)
    const incoming = Array.from({ length: compCount }, () => 0);
    for (let u = 0; u < compCount; u++) for (const v of cadj[u]) incoming[v]++;
    for (let i = 0; i < compCount; i++) if (incoming[i] === 0) dist[i] = 0;

    // process in topo order
    for (const u of topo) {
      if (dist[u] === -Infinity) continue; // unreachable from any source
      for (const v of cadj[u]) {
        if (dist[v] < dist[u] + 1) dist[v] = dist[u] + 1;
      }
    }

    // map nodes to layer = dist[comp]
    const nodeLayer = new Map();
    nodes.forEach((v) => {
      const c = compIndex.get(v);
      const d = dist[c];
      // if d is -Infinity (component not reachable from any source) place it below others
      nodeLayer.set(v, d === -Infinity ? Math.max(...dist.filter((x) => x !== -Infinity)) + 1 : d);
    });

    // compute number of layers and grouping
    const maxLayer = Math.max(...Array.from(nodeLayer.values()));
    const layers = Array.from({ length: maxLayer + 1 }, () => []);
    nodes.forEach((v) => layers[nodeLayer.get(v)].push(v));

    return { nodeLayer, layers, sccs, compIndex, cadj };
  }

  function computeBfsLayers(nodes, edges) {
    // Build adjacency list and indegree map
    const adj = new Map();
    const indeg = new Map();

    // Initialize nodes from given list
    nodes.forEach((v) => {
      adj.set(v, []);
      indeg.set(v, 0);
    });

    // Add edges
    edges.forEach(([v, u]) => { // WARNING: was changed
      if (!adj.has(u)) adj.set(u, []); // ensure u exists
      if (!indeg.has(v)) indeg.set(v, 0); // ensure v exists

      adj.get(u).push(v);
      indeg.set(v, indeg.get(v) + 1);
    });

    // Initialize queue with sources (indegree 0)
    const queue = [];
    const nodeLayer = new Map();
    adj.forEach((_, v) => {
      if (indeg.get(v) === 0) {
        queue.push(v);
        nodeLayer.set(v, 0);
      }
    });

    // BFS
    while (queue.length > 0) {
      const u = queue.shift();
      const curLayer = nodeLayer.get(u);
      for (const v of adj.get(u)) {
        indeg.set(v, indeg.get(v) - 1);
        if(!nodeLayer.has(v)){
          nodeLayer.set(v, curLayer + 1);
          queue.push(v);
        }
      }
    }

    // Group nodes by layer
    const maxLayer = Math.max(...nodeLayer.values());
    const layers = Array.from({ length: maxLayer + 1 }, () => []);
    nodeLayer.forEach((layer, v) => layers[layer].push(v));

    return { nodeLayer, layers };
  }

  // Layered layout with increased side margins
  function computeLayeredPositions(nodes, edges, width = 1000, height = 600) {
    const { nodeLayer, layers } = computeBfsLayers(nodes, edges);
    const padX = Math.max(80, NODE_RADIUS + 20);
    const padY = Math.max(60, NODE_RADIUS + 20);
    const sideMargin = Math.max(150, width * 0.25); // ~1/4 of width for each side
    const usableW = Math.max(300, width - sideMargin * 2);
    const usableH = Math.max(300, height - padY * 2);
    const maxLayer = layers.length - 1;
    const layerHeight = maxLayer > 0 ? usableH / maxLayer : 0;
    const pos = {};
    for (let li = 0; li < layers.length; li++) {
      const layerNodes = layers[li];
      const count = layerNodes.length;
      for (let i = 0; i < count; i++) {
        const id = layerNodes[i];
        let x;
        if (count === 1) x = sideMargin + usableW / 2;
        else x = sideMargin + (usableW * i) / (count - 1);
        const y = padY + li * layerHeight;
        pos[id] = { x, y, locked: false };
      }
    }
    return pos;
  }

  // Circular layout
  function computeCircularPositions(nodes, width = 1000, height = 600) {
    const cx = width / 2;
    const cy = height / 2;
    const r = Math.min(width, height) * 0.35;
    const pos = {};
    const n = nodes.length;
    nodes.forEach((id, i) => {
      const theta = (2 * Math.PI * i) / n;
      pos[id] = { x: cx + r * Math.cos(theta), y: cy + r * Math.sin(theta), locked: false };
    });
    return pos;
  }

  // Grid layout with increased side margins
  function computeGridPositions(nodes, width = 1000, height = 600) {
    const cols = Math.ceil(Math.sqrt(nodes.length));
    const rows = Math.ceil(nodes.length / cols);
    const padX = Math.max(80, NODE_RADIUS + 20);
    const padY = Math.max(60, NODE_RADIUS + 20);
    const sideMargin = Math.max(150, width * 0.25);
    const usableW = Math.max(300, width - sideMargin * 2);
    const usableH = Math.max(300, height - padY * 2);
    const pos = {};
    nodes.forEach((id, idx) => {
      const r = Math.floor(idx / cols);
      const c = idx % cols;
      const x = sideMargin + (usableW * c) / Math.max(1, cols - 1);
      const y = padY + (usableH * r) / Math.max(1, rows - 1);
      pos[id] = { x, y, locked: false };
    });
    return pos;
  }

  // Simple force-directed layout (no external libs)
  function computeForceLayout(nodes, edges, width = 1000, height = 600, iterations = 300) {
    // initialize positions (either existing or random)
    const pos = {};
    const existing = positionsRef.current;
    nodes.forEach((id) => {
      if (existing && existing[id] && !existing[id].locked) pos[id] = { x: existing[id].x, y: existing[id].y };
      else if (existing && existing[id]) pos[id] = { x: existing[id].x, y: existing[id].y };
      else pos[id] = { x: width * (0.2 + 0.6 * Math.random()), y: height * (0.2 + 0.6 * Math.random()) };
    });

    // parameters
    const k = Math.sqrt((width * height) / Math.max(1, nodes.length));
    const repulsion = 5000;
    const attraction = 0.1;
    for (let it = 0; it < iterations; it++) {
      const disp = {};
      nodes.forEach((v) => (disp[v] = { x: 0, y: 0 }));
      // repulsive forces
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const u = nodes[i];
          const v = nodes[j];
          let dx = pos[u].x - pos[v].x;
          let dy = pos[u].y - pos[v].y;
          let d2 = dx * dx + dy * dy + 0.01;
          const d = Math.sqrt(d2);
          const f = (repulsion * k * k) / d2;
          const ux = dx / d;
          const uy = dy / d;
          disp[u].x += ux * f;
          disp[u].y += uy * f;
          disp[v].x -= ux * f;
          disp[v].y -= uy * f;
        }
      }
      // attractive forces (edges)
      edges.forEach(([a, b]) => {
        let dx = pos[a].x - pos[b].x;
        let dy = pos[a].y - pos[b].y;
        let d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = (d * d) / (k) * attraction;
        const ux = dx / d;
        const uy = dy / d;
        disp[a].x -= ux * f;
        disp[a].y -= uy * f;
        disp[b].x += ux * f;
        disp[b].y += uy * f;
      });
      // apply displacements with small step
      const step = Math.max(1, (width + height) / 300); // slightly faster step
      nodes.forEach((v) => {
        if (positionsRef.current && positionsRef.current[v] && positionsRef.current[v].locked) return; // keep locked nodes
        pos[v].x += (disp[v].x / (1 + Math.sqrt(disp[v].x * disp[v].x + disp[v].y * disp[v].y))) * step;
        pos[v].y += (disp[v].y / (1 + Math.sqrt(disp[v].x * disp[v].x + disp[v].y * disp[v].y))) * step;
        // keep inside bounds
        pos[v].x = Math.max(NODE_RADIUS + 20, Math.min(width - (NODE_RADIUS + 20), pos[v].x));
        pos[v].y = Math.max(NODE_RADIUS + 20, Math.min(height - (NODE_RADIUS + 20), pos[v].y));
      });
    }

    const out = {};
    nodes.forEach((id) => (out[id] = { x: pos[id].x, y: pos[id].y, locked: false }));
    return out;
  }

  // Compute positions based on selected algorithm
  function computePositionsForAlgorithm(nodes, edges, algo, width, height) {
    if (algo === "layered") return computeLayeredPositions(nodes, edges, width, height);
    if (algo === "circular") return computeCircularPositions(nodes, width, height);
    if (algo === "grid") return computeGridPositions(nodes, width, height);
    if (algo === "force") return computeForceLayout(nodes, edges, width, height, 200);
    return computeLayeredPositions(nodes, edges, width, height);
  }

  // Handle frame navigation
  useEffect(() => {
    if (frames.length === 0 || currentFrameIdx < 0 || currentFrameIdx >= frames.length) return;
    const frame = frames[currentFrameIdx];

    // Use precomputed positions for the frame. Prefer any user-locked positions
    const mergedPositions = {};
    frame.nodes.forEach((id) => {
      const userPos = positionsRef.current && positionsRef.current[id] && positionsRef.current[id].locked ? positionsRef.current[id] : null;
      if (userPos) {
        mergedPositions[id] = userPos;
      } else if (frame.positions && frame.positions[id]) {
        mergedPositions[id] = frame.positions[id];
      } else {
        mergedPositions[id] = { x: 0, y: 0, locked: false };
      }
    });

    // include ni and assignable mapping. reuse global persistent source ordering/colors so colors don't shift when nodes are removed
    setGraph({
      nodes: frame.nodes,
      edges: frame.edges,
      ni: frame.ni || {},
      assignable: frame.assignable || {},
      sourcesOrdered: sourcesOrderedRef.current,
      sourceColors: sourceColorsRef.current,
    });
    setPositions(mergedPositions);
    positionsRef.current = mergedPositions;
  }, [currentFrameIdx, frames, layoutAlgo]);

  // helpers to render edges and nodes
  function edgePath(p1, p2, edgeIndex = 0) {
    // p1 and p2 are centers {x,y,id}
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux = dx / d;
    const uy = dy / d;

    // move endpoints to circle boundaries
    const startX = p1.x + ux * NODE_RADIUS;
    const startY = p1.y + uy * NODE_RADIUS;
    const endX = p2.x - ux * NODE_RADIUS;
    const endY = p2.y - uy * NODE_RADIUS;

    // quick straight-line feasibility check: ensure that straight segment doesn't pass too close to any other node
    const padding = 8;
    let straightOkay = true;
    Object.keys(positionsRef.current).forEach((nid) => {
      const idn = Number(nid);
      if (idn === p1.id || idn === p2.id) return;
      const q = positionsRef.current[idn];
      if (!q) return;

      const vx = endX - startX;
      const vy = endY - startY;
      const len2 = vx * vx + vy * vy + 1e-6;
      const t = ((q.x - startX) * vx + (q.y - startY) * vy) / len2;
      const tt = Math.max(0, Math.min(1, t));
      const projx = startX + vx * tt;
      const projy = startY + vy * tt;
      const distToSeg = Math.hypot(q.x - projx, q.y - projy);

      if (distToSeg < NODE_RADIUS + padding) {
        straightOkay = false;
      }
    });

    if (straightOkay) {
      return `M ${startX} ${startY} L ${endX} ${endY}`;
    }

    // otherwise compute a quadratic bezier that curves slightly to the right (clockwise)
    const mx = (startX + endX) / 2;
    const my = (startY + endY) / 2;

    // clockwise perpendicular (dx,dy) -> (dy, -dx)
    const vx = endX - startX;
    const vy = endY - startY;
    const len = Math.hypot(vx, vy);
    const px = vy / len;       // rightward perpendicular x
    const py = -vx / len;      // rightward perpendicular y

    // base curvature magnitude
    const base = Math.min(160, d * 0.6);
    const strength = base * 0.6; // small right-bias

    let cx = mx + px * strength;
    let cy = my + py * strength;

    // increase curvature if curve would approach other nodes (heuristic)
    Object.keys(positionsRef.current).forEach((nid) => {
      const idn = Number(nid);
      if (idn === p1.id || idn === p2.id) return;
      const q = positionsRef.current[idn];
      if (!q) return;

      const vx2 = endX - startX;
      const vy2 = endY - startY;
      const len2 = vx2 * vx2 + vy2 * vy2 + 1e-6;
      const t = ((q.x - startX) * vx2 + (q.y - startY) * vy2) / len2;
      const tt = Math.max(0, Math.min(1, t));
      const projx = startX + vx2 * tt;
      const projy = startY + vy2 * tt;
      const distToSeg = Math.hypot(q.x - projx, q.y - projy);

      if (distToSeg < NODE_RADIUS + padding) {
        const more = (NODE_RADIUS + padding - distToSeg) * 1.8;
        cx += px * more;
        cy += py * more;
      }
    });

    return `M ${startX} ${startY} Q ${cx} ${cy} ${endX} ${endY}`;
  }


  // Mouse / Pointer dragging handlers
  useEffect(() => {
    function onMove(ev) {
      const id = draggingRef.current.id;
      if (id === null) return;
      ev.preventDefault();
      const svg = svgRef.current;
      const pt = svg.createSVGPoint();
      pt.x = ev.clientX;
      pt.y = ev.clientY;
      const ctm = svg.getScreenCTM().inverse();
      const loc = pt.matrixTransform(ctm);
      // move exactly with mouse: place center at cursor accounting for initial offset
      const nx = loc.x - draggingRef.current.ox;
      const ny = loc.y - draggingRef.current.oy;
      positionsRef.current = {
        ...positionsRef.current,
        [id]: { ...positionsRef.current[id], x: nx, y: ny, locked: true },
      };
      setPositions({ ...positionsRef.current });
    }
    function onUp(ev) {
      // release pointer capture on the owning element (if any)
      try {
        if (pointerOwner.current && ev && ev.pointerId) {
          pointerOwner.current.releasePointerCapture(ev.pointerId);
        }
      } catch (e) {
        // ignore
      }
      draggingRef.current.id = null;
      pointerOwner.current = null;
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  function startDrag(ev, id) {
    ev.preventDefault();
    // move exactly with mouse: compute offset so node center follows pointer
    const svg = svgRef.current;
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX;
    pt.y = ev.clientY;
    const ctm = svg.getScreenCTM().inverse();
    const loc = pt.matrixTransform(ctm);
    const cur = positionsRef.current[id] || { x: loc.x, y: loc.y };
    // ox = loc.x - cur.x so that new center = loc.x - ox = cur.x at start
    const ox = loc.x - cur.x;
    const oy = loc.y - cur.y;
    draggingRef.current = { id, ox, oy };

    // pointer capture so events are stable; remember owner to release later
    try {
      ev.currentTarget.setPointerCapture && ev.currentTarget.setPointerCapture(ev.pointerId);
      pointerOwner.current = ev.currentTarget;
    } catch (e) {
      pointerOwner.current = null;
    }
  }

  function resetPositions(full = false) {
    if (!graph) return;
    const container = svgRef.current;
    const rect = container ? container.getBoundingClientRect() : { width: 1000, height: 600 };
    const defaults = computePositionsForAlgorithm(graph.nodes, graph.edges, layoutAlgo, rect.width, rect.height);
    if (full) {
      setPositions(defaults);
      positionsRef.current = defaults;
    } else {
      // reset only unlocked nodes
      const merged = { ...positionsRef.current };
      Object.keys(merged).forEach((k) => {
        if (!merged[k].locked && defaults[k]) merged[k] = defaults[k];
      });
      setPositions(merged);
      positionsRef.current = merged;
    }
  }

  // zoom / pan handlers
  function onWheel(ev) {
    ev.preventDefault();
    const delta = -ev.deltaY;
    const factor = delta > 0 ? 1.1 : 0.9;
    setView((v) => ({ ...v, scale: Math.max(0.2, Math.min(5, v.scale * factor)) }));
  }

  function onMouseDownPan(ev) {
    if (ev.button !== 1) return; // middle mouse to pan
    ev.preventDefault();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const orig = { ...view };
    function move(e2) {
      const dx = e2.clientX - startX;
      const dy = e2.clientY - startY;
      setView({ tx: orig.tx + dx, ty: orig.ty + dy, scale: orig.scale });
    }
    function up() {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  function zoomBy(factor) {
    setView((v) => ({ ...v, scale: Math.max(0.2, Math.min(5, v.scale * factor)) }));
  }

  function panBy(dx, dy) {
    setView((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }));
  }

  // Frame navigation
  function goToNextFrame() {
    if (currentFrameIdx < frames.length - 1) {
      setCurrentFrameIdx(currentFrameIdx + 1);
    }
  }

  function goToPrevFrame() {
    if (currentFrameIdx > 0) {
      setCurrentFrameIdx(currentFrameIdx - 1);
    }
  }

  // Run a force layout interactively (toggle)
  useEffect(() => {
    let raf = null;
    if (!graph) return;
    if (layoutAlgo !== "force" || !forceRunning) return;
    const nodes = graph.nodes;
    const edges = graph.edges;
    const container = svgRef.current;
    const rect = container ? container.getBoundingClientRect() : { width: 1000, height: 600 };
    // initialize positions if absent
    if (!positionsRef.current || Object.keys(positionsRef.current).length === 0) {
      positionsRef.current = computeForceLayout(nodes, edges, rect.width, rect.height, 1);
      setPositions({ ...positionsRef.current });
    }
    // run iterations gradually
    let iter = 0;
    const maxIter = 500;
    function step() {
      iter++;
      const updated = computeForceLayout(nodes, edges, rect.width, rect.height, 5);
      // merge respecting locked nodes
      Object.keys(updated).forEach((k) => {
        if (positionsRef.current[k] && positionsRef.current[k].locked) return;
        positionsRef.current[k] = updated[k];
      });
      setPositions({ ...positionsRef.current });
      if (iter < maxIter && forceRunning) raf = requestAnimationFrame(step);
    }
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceRunning, layoutAlgo, graph]);

  // Keyboard shortcuts for frame navigation
  useEffect(() => {
    function handleKeyDown(e) {
      if (frames.length === 0) return;
      if (e.key === "ArrowLeft" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        goToPrevFrame();
      } else if (e.key === "ArrowRight" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        goToNextFrame();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frames, currentFrameIdx]);

  return (
    <div className="p-4 max-w-full">
      <div className="flex gap-3 items-center mb-3 flex-wrap">
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2">
            <span className="text-sm mr-2">Mode</span>
            <select value={loadMode} onChange={(e) => setLoadMode(e.target.value)} className="p-1 border rounded">
              <option value="random">Random Graph {`{n}_{k}_{idx}.yml`}</option>
              <option value="three">Three Layered {`TL_{n}_{k}_{idx}.yml`}</option>
              <option value="file">Choose file</option>
            </select>
          </label>
          {loadMode === "file" ? (
            <label className="flex items-center gap-2">
              <span className="text-sm">Choose YAML</span>
              <input type="file" accept=".yml,.yaml" onChange={handleFile} className="ml-2" />
            </label>
          ) : (
            <div className="flex items-center gap-2">
              <input placeholder="n" value={nInput} onChange={(e) => setNInput(e.target.value)} className="p-1 border rounded w-16" />
              <input placeholder="k" value={kInput} onChange={(e) => setKInput(e.target.value)} className="p-1 border rounded w-16" />
              <input placeholder="idx" value={idxInput} onChange={(e) => setIdxInput(e.target.value)} className="p-1 border rounded w-20" />
              <button onClick={() => loadFromPath()} className="px-2 py-1 rounded bg-blue-600 text-white">Load</button>
              <button onClick={loadNextExample} title="Next example (Enter)" className="px-2 py-1 rounded bg-green-600 text-white ml-2">Next (Enter)</button>
            </div>
           )}
         </div>

        {frames.length > 0 && (
          <>
            <div className="flex items-center gap-2 ml-4 px-3 py-1 bg-blue-50 rounded border border-blue-200">
              <button
                onClick={goToPrevFrame}
                disabled={currentFrameIdx === 0}
                className="px-2 py-1 rounded bg-blue-600 text-white disabled:bg-gray-300 disabled:cursor-not-allowed"
              >
                ← Prev
              </button>
              <span className="text-sm font-semibold">
                Frame {currentFrameIdx + 1} / {frames.length}
              </span>
              <button
                onClick={goToNextFrame}
                disabled={currentFrameIdx === frames.length - 1}
                className="px-2 py-1 rounded bg-blue-600 text-white disabled:bg-gray-300 disabled:cursor-not-allowed"
              >
                Next →
              </button>
            </div>
            {frames[currentFrameIdx] && (
              <div className="text-sm px-3 py-1 bg-green-50 rounded border border-green-200">
                <strong>Event {frames[currentFrameIdx].event_id}:</strong> {frames[currentFrameIdx].label}
              </div>
            )}
          </>
        )}

        <label className="flex items-center gap-2">
          <span className="text-sm">Layout</span>
          <select value={layoutAlgo} onChange={(e) => setLayoutAlgo(e.target.value)} className="ml-1 p-1 border rounded">
            <option value="layered">Layered (BFS layers)</option>
            {/* <option value="force">Force-directed</option> */}
            <option value="circular">Circular</option>
            <option value="grid">Grid</option>
          </select>
        </label>

        {/* <button
          className="px-3 py-1 rounded bg-slate-700 text-white"
          onClick={() => resetPositions(false)}
        >
          Reset unlocked positions
        </button> */}
        <button
          className="px-3 py-1 rounded bg-slate-700 text-white"
          onClick={() => resetPositions(true)}
        >
          Reset all positions
        </button>

        {layoutAlgo === "force" && (
          <label className="flex items-center gap-2 ml-2">
            <input type="checkbox" checked={forceRunning} onChange={(e) => setForceRunning(e.target.checked)} />
            <span className="text-sm">Run force</span>
          </label>
        )}

        <div className="ml-auto text-sm text-slate-600">Tip: drag nodes, wheel to zoom, ← → keys for frames</div>
      </div>

      <div ref={containerRef} style={{ position: "relative", border: "1px solid #ddd", borderRadius: 8, overflow: "hidden" }}>
        <svg
          ref={svgRef}
          width="100%"
          height={600}
          onWheel={onWheel}
          onMouseDown={onMouseDownPan}
          style={{ background: "#ffffff", display: "block" }}
        >
          <defs>
            <marker
              id="arrowhead"
              markerWidth="10"
              markerHeight="7"
              refX="10"
              refY="3.5"
              orient="auto"
              markerUnits="strokeWidth"
            >
              {/* use currentColor so marker follows stroke color of referencing path */}
              <path d="M 0 0 L 10 3.5 L 0 7 z" fill="currentColor" stroke="currentColor" />
            </marker>
            <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
              <feDropShadow stdDeviation="2" dx="1" dy="1" />
            </filter>
          </defs>

          <g transform={`translate(${view.tx}, ${view.ty}) scale(${view.scale})`}>
            {/* edges */}
            {graph &&
              graph.edges.map((edge, i) => {
                const [u, v, color] = edge;
                const pu = positions[u];
                const pv = positions[v];
                if (!pu || !pv) return null;
                // create small objects with id for collision checks
                const p1 = { x: pu.x, y: pu.y, id: u };
                const p2 = { x: pv.x, y: pv.y, id: v };

                const path = edgePath(p1, p2, i);
                return (
                  <g key={`e-${i}`}>
                    <path
                      d={path}
                      stroke={color}
                      strokeWidth={2}
                      fill="none"
                      markerEnd="url(#arrowhead)"
                      // set CSS color so marker with fill="currentColor" matches
                      style={{ pointerEvents: "none", color }}
                    />
                  </g>
                );
              })}

            {/* nodes */}
            {graph &&
              graph.nodes.map((id) => {
                const p = positions[id] || { x: 0, y: 0 };
                return (
                  <g
                    key={`n-${id}`}
                    transform={`translate(${p.x}, ${p.y})`}
                    style={{ cursor: "grab" }}
                    onPointerDown={(ev) => startDrag(ev, id)}
                  >
                    {/*
                      Render node fill:
                        - if node is a source (exists in graph.sourcesOrdered) => single solid color
                        - else if node has assignable sources (graph.assignable[id]) => draw pie slices for each source color
                        - else use default pale fill
                    */}
                    {(() => {
                      const assignList = (graph && graph.assignable && graph.assignable[id]) || [];
                      const isSource = graph && graph.sourcesOrdered && graph.sourcesOrdered.includes(Number(id));
                      const singleColor = isSource ? graph.sourceColors[id] : (assignList.length === 1 ? graph.sourceColors[assignList[0]] : null);
                      if (singleColor) {
                        return <circle r={NODE_RADIUS} fill={singleColor} stroke="#111827" strokeWidth={2} />;
                      }
                      if (assignList.length > 1) {
                        // draw equal pie slices centered at (0,0)
                        const slices = [];
                        const n = assignList.length;
                        const r = NODE_RADIUS;
                        const startOffset = -Math.PI / 2; // start from top
                        for (let si = 0; si < n; si++) {
                          const src = assignList[si];
                          const a0 = startOffset + (2 * Math.PI * si) / n;
                          const a1 = startOffset + (2 * Math.PI * (si + 1)) / n;
                          const x0 = Math.cos(a0) * r;
                          const y0 = Math.sin(a0) * r;
                          const x1 = Math.cos(a1) * r;
                          const y1 = Math.sin(a1) * r;
                          const largeArc = (a1 - a0) > Math.PI ? 1 : 0;
                          const color = graph.sourceColors && graph.sourceColors[src] ? graph.sourceColors[src] : getColorByIndex(si);
                          const d = `M 0 0 L ${x0} ${y0} A ${r} ${r} 0 ${largeArc} 1 ${x1} ${y1} Z`;
                          slices.push(<path key={`s-${si}`} d={d} fill={color} stroke="none" />);
                        }
                        return (
                          <>
                            {slices}
                            <circle r={NODE_RADIUS} fill="none" stroke="#111827" strokeWidth={2} />
                          </>
                        );
                      }
                      // default pale fill
                      return <circle r={NODE_RADIUS} fill="#f7fafc" stroke="#111827" strokeWidth={2} />;
                    })()}
                    <text
                      x={0}
                      y={NODE_FONT / 3 + 2}
                      textAnchor="middle"
                      style={{ userSelect: "none", fontSize: NODE_FONT, fontFamily: "monospace", fontWeight: 700, fill: "#000" }}
                    >
                      {graph && graph.ni && graph.ni[id] !== undefined ? `${id}, [${graph.ni[id]}]` : String(id)}
                    </text>
                  </g>
                );
              })}
          </g>
        </svg>

        {/* control buttons bottom-right */}
        <div style={{ position: "absolute", right: 12, bottom: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <button onClick={() => zoomBy(1.2)} style={{ width: 44, height: 44, borderRadius: 10, border: "none", background: "#111827", color: "#fff", fontSize: 20 }}>+</button>
          <button onClick={() => zoomBy(1 / 1.2)} style={{ width: 44, height: 44, borderRadius: 10, border: "none", background: "#111827", color: "#fff", fontSize: 20 }}>−</button>
        </div>

        {/* pan buttons left */}
        <div style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", display: "flex", flexDirection: "column", gap: 8 }}>
          <button onClick={() => panBy(-60, 0)} title="Pan left" style={{ width: 44, height: 44, borderRadius: 10, border: "none", background: "#111827", color: "#fff", fontSize: 18 }}>←</button>
          <button onClick={() => panBy(60, 0)} title="Pan right" style={{ width: 44, height: 44, borderRadius: 10, border: "none", background: "#111827", color: "#fff", fontSize: 18 }}>→</button>
        </div>

        {/* pan buttons top */}
        <div style={{ position: "absolute", left: "50%", transform: "translateX(-50%)", bottom: 12, display: "flex", gap: 8 }}>
          <button onClick={() => panBy(0, -60)} title="Pan up" style={{ width: 44, height: 44, borderRadius: 10, border: "none", background: "#111827", color: "#fff", fontSize: 18 }}>↑</button>
          <button onClick={() => panBy(0, 60)} title="Pan down" style={{ width: 44, height: 44, borderRadius: 10, border: "none", background: "#111827", color: "#fff", fontSize: 18 }}>↓</button>
        </div>
      </div>

      <div className="mt-3 text-sm text-slate-600">
        <strong>YAML format expected</strong>: Multiple frames separated by <code>---</code>, each with an <code>edges</code> list:
        <pre className="bg-slate-50 p-2 rounded text-xs mt-2">{`---
event_id: 1
label: Initial
edges:
  - [2, 3]
  - [9, 6]
  - [4, 6]
---
event_id: 2
label: Remove_edge
edges:
  - [2, 3]
  - [4, 6]`}</pre>
        Nodes are inferred from edge endpoints. Use Prev/Next buttons to navigate frames. Node positions are preserved across frames.
      </div>
    </div>
  );
}
