// ============================================================
//  app.js  —  Bivariate Choropleth EDA engine
// ============================================================

import * as CONFIG from './config.js';
import {
  DATA_FILE, GEOGRAPHY_LABEL,
  FEATURE_ID_FIELD, FEATURE_NAME_FIELD, FEATURE_GROUP_FIELD,
  VARIABLES, DEFAULT_VAR_X, DEFAULT_VAR_Y,
  DEFAULT_BIVARIATE_SCHEME,
  NULL_COLOR, SELECTION_COLOR, DEEMPHASIS_OPACITY, DOT_RADIUS,
} from './config.js';

// Keys added after the first release. They are read off the namespace rather
// than named in the import list above, because a config.js written against an
// earlier version will not export them — and a missing *named* import is a
// module-level SyntaxError, which kills the page before the preflight can
// report anything. Each falls back to the behaviour that shipped before the
// key existed, and the preflight warns where a fallback is in use.
const PAGE_TITLE             = CONFIG.PAGE_TITLE ?? document.title;
const DATA_CREDIT_HTML       = CONFIG.DATA_CREDIT_HTML ?? '';
const GEOGRAPHY_LABEL_PLURAL = CONFIG.GEOGRAPHY_LABEL_PLURAL ?? (GEOGRAPHY_LABEL + 's');
const PROJECTION             = CONFIG.PROJECTION ?? (() => d3.geoMercator());

// ============================================================
//  BIVARIATE COLOR SCHEMES  (9 colors, row-major: yClass*3+xClass)
// ============================================================

const BIVARIATE_SCHEMES = {
  DkBlue_DkRed: {
    label: 'Blue × Red',
    colors: ['#e8e8e8','#e4acac','#c85a5a',
             '#b0d5df','#ad9ea5','#985356',
             '#64acbe','#627f8c','#574249'],
  },
  DkViolet_DkGreen: {
    label: 'Violet × Green',
    colors: ['#e8e8e8','#b5c0da','#6c83b5',
             '#b8d6be','#90b2b3','#567994',
             '#73ae80','#5a9178','#2a5a5b'],
  },
  DkCyan_DkBrown: {
    label: 'Cyan × Brown',
    colors: ['#e8e8e8','#e4d9ac','#c8b35a',
             '#accea4','#a3b18a','#8c8c5e',
             '#5ac8c8','#5dbfa3','#3b7a7a'],
  },
  GrPink: {
    label: 'Green × Pink',
    colors: ['#f3f3f3','#f0d0d8','#e8a0b0',
             '#cce5cc','#c8c8c0','#c09090',
             '#8fbc8f','#8fa880','#7a7060'],
  },
  PurpleOrange: {
    label: 'Purple × Orange',
    colors: ['#f3f3f3','#f1d28a','#e8a830',
             '#cdc5e0','#c8b070','#b87820',
             '#9e6fbc','#907050','#704020'],
  },
  BlueTan: {
    label: 'Blue × Tan',
    colors: ['#f3f3f3','#e0d4b8','#c8b070',
             '#b8cce0','#a8b8b0','#909060',
             '#5090c8','#508090','#405050'],
  },
  None: {
    label: 'No symbology',
    colors: Array(9).fill('#c8c8c8'),
  },
};

function bivIndex(xClass, yClass) { return yClass * 3 + xClass; }

// ============================================================
//  STATE
// ============================================================

const state = {
  geojson:     null,
  varX:        DEFAULT_VAR_X,
  varY:        DEFAULT_VAR_Y,
  scheme:      DEFAULT_BIVARIATE_SCHEME,
  selectedIds: new Set(),
  mode:        null,
};

// ============================================================
//  HELPERS
// ============================================================

function getVarDef(id)    { return VARIABLES.find(v => v.id === id) || VARIABLES[0]; }
function featureId(f)     { return f.properties[FEATURE_ID_FIELD]; }
function getVal(f, varId) {
  const v = f.properties[getVarDef(varId).prop];
  return (v == null || v === '') ? null : +v;
}

function tertileBreaks(values) {
  const s = [...values].filter(v => v != null).sort((a,b) => a-b);
  return [d3.quantile(s, 1/3), d3.quantile(s, 2/3)];
}

function classify3(value, breaks) {
  if (value == null) return null;
  if (value <= breaks[0]) return 0;
  if (value <= breaks[1]) return 1;
  return 2;
}

function getBivColor(f, xBreaks, yBreaks) {
  const vx = getVal(f, state.varX), vy = getVal(f, state.varY);
  if (vx == null || vy == null) return NULL_COLOR;
  return BIVARIATE_SCHEMES[state.scheme].colors[
    bivIndex(classify3(vx, xBreaks), classify3(vy, yBreaks))
  ];
}

function regression(xv, yv) {
  const n = xv.length;
  if (n < 2) return null;
  const mx = d3.mean(xv), my = d3.mean(yv);
  let ss = 0, sp = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xv[i]-mx, dy = yv[i]-my;
    ss += dx*dx; sp += dx*dy; syy += dy*dy;
  }
  if (ss === 0) return null;
  const slope = sp/ss, intercept = my - slope*mx;
  const r = sp / Math.sqrt(ss * syy) || 0;
  return { slope, intercept, r, n };
}

function calcStats(vals) {
  if (!vals || !vals.length) return null;
  const s = [...vals].sort((a,b) => a-b);
  return { n: s.length, mean: d3.mean(s), median: d3.median(s),
           min: s[0], max: s[s.length-1], stddev: d3.deviation(s) };
}

// ============================================================
//  MAP
// ============================================================

let mapSvg, mapG, mapBrushG, projection, pathGen;
let zoomBehavior, currentTransform;
let zoomHintShown = false;
let cachedXBreaks, cachedYBreaks;

function initMap() {
  mapSvg = d3.select('#mapSvg');
  const zoomG = mapSvg.append('g').attr('class', 'zoom-root');
  mapG      = zoomG.append('g').attr('class', 'zones');
  mapBrushG = zoomG.append('g').attr('class', 'map-brush');
  currentTransform = d3.zoomIdentity;
}

function resizeMap() {
  const el = document.getElementById('mapPane');
  const w = el.clientWidth, h = el.clientHeight;
  mapSvg.attr('viewBox', `0 0 ${w} ${h}`).attr('width', w).attr('height', h);
  projection = PROJECTION().fitSize([w, h], state.geojson);
  pathGen    = d3.geoPath().projection(projection);
  setupZoom(w, h);
}

function setupZoom(w, h) {
  zoomBehavior = d3.zoom()
    .scaleExtent([0.5, 32])
    .translateExtent([[-w,-h],[2*w,2*h]])
    .filter(e => e.type === 'wheel' || (e.type === 'mousedown' && !e.shiftKey))
    .on('zoom', e => {
      currentTransform = e.transform;
      mapSvg.select('.zoom-root').attr('transform', e.transform);
    });
  mapSvg.call(zoomBehavior).on('dblclick.zoom', null);
  // setupZoom runs again on every resize, so carry the current view across
  // rather than snapping back to identity, and keep the hint a one-shot.
  if (currentTransform && currentTransform !== d3.zoomIdentity) {
    mapSvg.call(zoomBehavior.transform, currentTransform);
  }
  zoomBehavior.on('zoom.hint', e => {
    if (!zoomHintShown && e.transform.k > 1.5) {
      zoomHintShown = true;
      const h = document.getElementById('shiftHint');
      h.classList.add('visible');
      setTimeout(() => h.classList.remove('visible'), 3000);
    }
  });
}

function zoomBy(f)   { mapSvg.transition().duration(280).call(zoomBehavior.scaleBy, f); }
function zoomReset() { mapSvg.transition().duration(380).call(zoomBehavior.transform, d3.zoomIdentity); }

function computeBreaks() {
  const ax = state.geojson.features.map(f => getVal(f,state.varX)).filter(v=>v!=null);
  const ay = state.geojson.features.map(f => getVal(f,state.varY)).filter(v=>v!=null);
  cachedXBreaks = tertileBreaks(ax);
  cachedYBreaks = tertileBreaks(ay);
}

function drawMap() {
  computeBreaks();
  mapG.selectAll('.zone')
    .data(state.geojson.features, featureId)
    .join('path')
    .attr('class', 'zone')
    .attr('d', pathGen)
    .attr('stroke', '#555')
    .attr('stroke-width', 0.5)
    .on('mousemove', onZoneHover)
    .on('mouseleave', hideTooltip);
  applyMapColors();
  drawLegend();
}

function applyMapColors() {
  const xb = cachedXBreaks, yb = cachedYBreaks;
  const hasSel = state.selectedIds.size > 0;
  mapG.selectAll('.zone')
    .attr('fill', d => {
      if (hasSel && !state.selectedIds.has(featureId(d))) return NULL_COLOR;
      return getBivColor(d, xb, yb);
    })
    .attr('opacity', d => {
      if (!hasSel) return 1;
      return state.selectedIds.has(featureId(d)) ? 1 : DEEMPHASIS_OPACITY;
    });
}

function onZoneHover(event, d) {
  const p   = d.properties;
  const vdx = getVarDef(state.varX), vdy = getVarDef(state.varY);
  const vx  = getVal(d, state.varX), vy = getVal(d, state.varY);
  const tip = document.getElementById('tooltip');
  const grp = FEATURE_GROUP_FIELD ? p[FEATURE_GROUP_FIELD] : null;
  tip.style.display = 'block';
  tip.style.left = (event.clientX + 14) + 'px';
  tip.style.top  = (event.clientY - 36) + 'px';
  tip.innerHTML =
    `${grp ? `<span class="tip-group">${grp}</span><br>` : ''}<span class="tip-id">${p[FEATURE_NAME_FIELD]||''}</span><br>` +
    `<span class="tip-label">${vdx.label}</span> <span class="tip-val">${vx!=null?vdx.fmt(vx):'N/A'}</span><br>` +
    `<span class="tip-label">${vdy.label}</span> <span class="tip-val">${vy!=null?vdy.fmt(vy):'N/A'}</span>`;
}
function hideTooltip() { document.getElementById('tooltip').style.display = 'none'; }

// ── Floating bivariate legend ──
function drawLegend() {
  const legend = document.getElementById('floatLegend');
  legend.innerHTML = '';
  const vdx = getVarDef(state.varX), vdy = getVarDef(state.varY);

  if (state.scheme === 'None') {
    legend.innerHTML = '<div style="font-size:10px;color:#888;padding:2px 0;">No symbology</div>';
    return;
  }

  const colors = BIVARIATE_SCHEMES[state.scheme].colors;
  const xb = cachedXBreaks, yb = cachedYBreaks;

  // Outer row: Y label | grid+X label
  const outer = document.createElement('div');
  outer.style.cssText = 'display:flex;flex-direction:row;align-items:stretch;gap:5px;';

  // Rotated Y label
  const yLbl = document.createElement('div');
  yLbl.style.cssText = 'display:flex;align-items:center;justify-content:center;';
  const yTxt = document.createElement('div');
  // In vertical-rl the inline axis runs top-to-bottom, so max-height is what
  // wraps this label. Without it a long variable name sets the height of the
  // whole legend row and leaves dead space under the 3x3 grid — barely
  // noticeable at 1x, obvious once the legend is scaled up.
  yTxt.style.cssText = 'font-size:9px;color:#777;font-weight:500;writing-mode:vertical-rl;transform:rotate(180deg);max-height:88px;';
  yTxt.textContent = '↑ ' + vdy.label;
  yLbl.appendChild(yTxt);
  outer.appendChild(yLbl);

  // Right: col headers + rows + x label
  const gridWrap = document.createElement('div');
  gridWrap.style.cssText = 'display:flex;flex-direction:column;gap:2px;';

  // Column headers
  const hdr = document.createElement('div');
  hdr.style.cssText = 'display:flex;gap:2px;';
  ['Low','Mid','High'].forEach(lbl => {
    const el = document.createElement('div');
    el.style.cssText = 'width:28px;font-size:9px;color:#999;text-align:center;';
    el.textContent = lbl;
    hdr.appendChild(el);
  });
  gridWrap.appendChild(hdr);

  // 3 data rows (high-Y at top)
  for (let row = 0; row < 3; row++) {
    const yClass = 2 - row;
    const rowEl = document.createElement('div');
    rowEl.style.cssText = 'display:flex;gap:2px;';
    for (let col = 0; col < 3; col++) {
      const cell = document.createElement('div');
      cell.style.cssText = `width:28px;height:22px;border-radius:3px;border:0.5px solid rgba(0,0,0,0.07);background:${colors[bivIndex(col,yClass)]};`;
      cell.title = `X:${['Low','Mid','High'][col]}, Y:${['Low','Mid','High'][yClass]}`;
      rowEl.appendChild(cell);
    }
    gridWrap.appendChild(rowEl);
  }

  // X axis label
  const xLbl = document.createElement('div');
  xLbl.style.cssText = 'font-size:9px;color:#777;font-weight:500;text-align:center;margin-top:1px;';
  xLbl.textContent = '→ ' + vdx.label;
  gridWrap.appendChild(xLbl);

  outer.appendChild(gridWrap);
  legend.appendChild(outer);

  // Divider + breakpoints.
  // Test the contents, not the arrays: tertileBreaks() returns
  // [undefined, undefined] for a variable with no numeric values, and a
  // two-element array is truthy even when both entries are undefined —
  // which used to reach vd.fmt(undefined) and throw.
  if (xb?.[0] != null && yb?.[0] != null) {
    const div = document.createElement('div');
    div.style.cssText = 'border-top:0.5px solid #eee;margin:7px 0 5px;';
    legend.appendChild(div);

    const brkTitle = document.createElement('div');
    brkTitle.style.cssText = 'font-size:9px;font-weight:700;color:#aaa;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px;';
    brkTitle.textContent = 'Class breaks';
    legend.appendChild(brkTitle);

    [[vdx,'X:',xb],[vdy,'Y:',yb]].forEach(([vd, label, brk]) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:4px;margin-bottom:2px;align-items:baseline;';
      row.innerHTML = `<span style="font-size:9px;color:#bbb;width:16px;flex-shrink:0;">${label}</span>` +
        `<span style="font-size:9px;color:#555;">≤${vd.fmt(brk[0])} / ≤${vd.fmt(brk[1])} / >${vd.fmt(brk[1])}</span>`;
      legend.appendChild(row);
    });
  }
}

// ============================================================
//  SYMBOLOGY DROPDOWN
// ============================================================

function buildSymDropdown() {
  const inner = document.getElementById('symDropdownInner');
  inner.innerHTML = '';
  Object.entries(BIVARIATE_SCHEMES).forEach(([id, scheme]) => {
    const row = document.createElement('div');
    row.className = 'sym-row' + (id === state.scheme ? ' sym-row--active' : '');
    row.dataset.schemeId = id;
    if (id === 'None') {
      const lbl = document.createElement('span');
      lbl.className = 'sym-row-label'; lbl.textContent = scheme.label;
      row.appendChild(lbl);
    } else {
      const g = document.createElement('div'); g.className = 'sym-grid';
      for (let r = 2; r >= 0; r--) for (let c = 0; c < 3; c++) {
        const cell = document.createElement('div'); cell.className = 'sym-grid-cell';
        cell.style.background = scheme.colors[bivIndex(c,r)]; g.appendChild(cell);
      }
      const lbl = document.createElement('span');
      lbl.className = 'sym-row-label'; lbl.textContent = scheme.label;
      row.appendChild(g); row.appendChild(lbl);
    }
    row.addEventListener('click', () => { onSchemeChange(id); closeSymDropdown(); });
    inner.appendChild(row);
  });
}

function updateSymBtn() {
  const wrap = document.getElementById('symBtnSwatch');
  wrap.innerHTML = '';
  if (state.scheme === 'None') { wrap.style.display = 'none'; return; }
  wrap.style.display = 'grid';
  const colors = BIVARIATE_SCHEMES[state.scheme].colors;
  for (let r = 2; r >= 0; r--) for (let c = 0; c < 3; c++) {
    const s = document.createElement('span');
    s.className = 'sym-cell'; s.style.background = colors[bivIndex(c,r)];
    wrap.appendChild(s);
  }
}

let symDropdownOpen = false;
function openSymDropdown() {
  const btn = document.getElementById('symBtn');
  const dd  = document.getElementById('symDropdown');
  const r   = btn.getBoundingClientRect();
  const tr  = document.getElementById('toolbar').getBoundingClientRect();
  dd.style.left = (r.left - tr.left) + 'px';
  dd.classList.add('open'); btn.classList.add('open'); symDropdownOpen = true;
  btn.setAttribute('aria-expanded', 'true');
}
function closeSymDropdown() {
  document.getElementById('symDropdown').classList.remove('open');
  document.getElementById('symBtn').classList.remove('open');
  document.getElementById('symBtn').setAttribute('aria-expanded', 'false');
  symDropdownOpen = false;
}
function toggleSymDropdown() { symDropdownOpen ? closeSymDropdown() : openSymDropdown(); }

// ============================================================
//  MAP LASSO / RECTANGLE SELECTION
// ============================================================

let selDrag = null;

function setupMapBrush() {
  mapBrushG.selectAll('*').remove();
  mapBrushG.append('path').attr('class', 'sel-path');
  mapBrushG.append('rect').attr('class', 'sel-rect')
    .attr('fill','rgba(80,120,255,0.06)').attr('stroke','none').style('display','none');
  mapSvg.on('mousedown.sel', onSelMouseDown);
  // Track and finish the drag on the window, not on the SVG. A drag that ends
  // over the floating legend, the zoom buttons, or past the edge of the pane
  // never delivered its mouseup here: the selection was silently discarded
  // and selDrag stayed set, so the lasso kept following the cursor with no
  // button held. Both handlers no-op unless a drag is in progress.
  d3.select(window)
    .on('mousemove.sel', onSelMouseMove)
    .on('mouseup.sel',   onSelMouseUp);
}

function svgPoint(event) {
  const el = document.getElementById('mapPane');
  const rc = el.getBoundingClientRect();
  const t  = currentTransform || d3.zoomIdentity;
  return [(event.clientX - rc.left - t.x) / t.k,
          (event.clientY - rc.top  - t.y) / t.k];
}

function onSelMouseDown(event) {
  if (!event.shiftKey) return;
  event.preventDefault(); event.stopPropagation();
  const mode = event.altKey ? 'rect' : 'lasso';
  const pt   = svgPoint(event);
  selDrag = { mode, points:[pt], startX:pt[0], startY:pt[1] };
  showSelMode(mode);
}

function onSelMouseMove(event) {
  if (!selDrag) return;
  event.preventDefault();
  const pt = svgPoint(event);
  selDrag.points.push(pt);
  if (selDrag.mode === 'lasso') {
    mapBrushG.select('.sel-path')
      .attr('d','M'+[...selDrag.points,selDrag.points[0]].map(p=>p.join(',')).join('L')+'Z')
      .attr('fill','rgba(80,120,255,0.08)').attr('stroke','#4466cc')
      .attr('stroke-width',1.5).attr('stroke-dasharray','5,3').attr('stroke-linejoin','round');
  } else {
    const x0=Math.min(selDrag.startX,pt[0]), y0=Math.min(selDrag.startY,pt[1]);
    const w=Math.abs(pt[0]-selDrag.startX),  h=Math.abs(pt[1]-selDrag.startY);
    mapBrushG.select('.sel-rect').style('display',null)
      .attr('x',x0).attr('y',y0).attr('width',w).attr('height',h);
    mapBrushG.select('.sel-path')
      .attr('d',`M${x0},${y0}h${w}v${h}h${-w}Z`)
      .attr('fill','none').attr('stroke','#4466cc')
      .attr('stroke-width',1.5).attr('stroke-dasharray','5,3');
  }
}

function onSelMouseUp(event) {
  if (!selDrag) return;
  const drag = selDrag; selDrag = null; hideSelMode();
  const poly = drag.mode === 'lasso' ? drag.points : (() => {
    const pt = svgPoint(event);
    const x0=Math.min(drag.startX,pt[0]), y0=Math.min(drag.startY,pt[1]);
    const x1=Math.max(drag.startX,pt[0]), y1=Math.max(drag.startY,pt[1]);
    return [[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
  })();
  if (poly.length < 3) { clearSelPath(); return; }
  state.selectedIds.clear(); state.mode = 'map';
  state.geojson.features.forEach(f => {
    const c = pathGen.centroid(f);
    if (!isNaN(c[0]) && d3.polygonContains(poly, c)) state.selectedIds.add(featureId(f));
  });
  mapBrushG.select('.sel-path').attr('stroke-dasharray',null).attr('fill','rgba(80,120,255,0.10)');
  mapBrushG.select('.sel-rect').style('display','none');
  setTimeout(clearSelPath, 600);
  finishSelection();
}

function clearSelPath() {
  mapBrushG.select('.sel-path').attr('d',null).attr('fill','none');
  mapBrushG.select('.sel-rect').style('display','none');
}

function showSelMode(mode) {
  const el = document.getElementById('selModeIndicator');
  el.textContent = mode === 'lasso' ? '⟡ Lasso' : '⬜ Rectangle';
  el.style.opacity = '1';
}
function hideSelMode() { document.getElementById('selModeIndicator').style.opacity = '0'; }

// ============================================================
//  SCATTERPLOT
// ============================================================

const SM = { top:24, right:20, bottom:50, left:54 };
let scatterSvg, scatterG, scatterW, scatterH, xScale, yScale;
let scatterSelDrag = null;

function initScatter() {
  scatterSvg = d3.select('#scatterSvg');
  recalcScatterDims();
  scatterSvg.append('defs').append('clipPath').attr('id','plotClip')
    .append('rect').attr('class','plot-clip-rect');
  scatterG = scatterSvg.append('g').attr('transform', `translate(${SM.left},${SM.top})`);
  scatterG.append('g').attr('class','x-axis');
  scatterG.append('g').attr('class','y-axis');
  scatterG.append('text').attr('class','x-axis-label')
    .attr('text-anchor','middle')
    .style('font-size','11px').style('fill','#888');
  scatterG.append('text').attr('class','y-axis-label')
    .attr('text-anchor','middle').attr('transform','rotate(-90)')
    .style('font-size','11px').style('fill','#888');
  // Both fitted lines are clipped to the plot rect: at the edges of a .nice()'d
  // domain a fit routinely predicts values outside the y range, and the line
  // was drawing straight through the x-axis and its label.
  const regLayer = scatterG.append('g').attr('class','reg-layer')
    .attr('clip-path','url(#plotClip)');
  regLayer.append('line').attr('class','reg-all');
  regLayer.append('line').attr('class','reg-sel');
  layoutScatter();
  setupScatterSel();
  bindScatterSelEvents();
}

// Everything that depends on the pane's size, split out of initScatter so a
// resize can re-apply it.
function layoutScatter() {
  scatterSvg.select('.plot-clip-rect')
    .attr('x',0).attr('y',0).attr('width',scatterW).attr('height',scatterH);
  scatterG.select('.x-axis').attr('transform',`translate(0,${scatterH})`);
  scatterG.select('.x-axis-label').attr('y', scatterH+42);
  scatterG.select('.y-axis-label').attr('x',-scatterH/2).attr('y',-SM.left+13);
}

function recalcScatterDims() {
  const el = document.getElementById('scatterPane');
  scatterW = el.clientWidth  - SM.left - SM.right;
  scatterH = el.clientHeight - SM.top  - SM.bottom;
  scatterSvg.attr('width',el.clientWidth).attr('height',el.clientHeight)
    .attr('viewBox',`0 0 ${el.clientWidth} ${el.clientHeight}`);
}

function drawScatter() {
  const vdx = getVarDef(state.varX), vdy = getVarDef(state.varY);
  const allPairs = state.geojson.features
    .map(f => ({ id:featureId(f), x:getVal(f,state.varX), y:getVal(f,state.varY), f }))
    .filter(d => d.x != null && d.y != null);
  const selPairs = state.selectedIds.size > 0
    ? allPairs.filter(d => state.selectedIds.has(d.id)) : null;

  xScale = d3.scaleLinear().domain(d3.extent(allPairs,d=>d.x)).nice().range([0,scatterW]);
  yScale = d3.scaleLinear().domain(d3.extent(allPairs,d=>d.y)).nice().range([scatterH,0]);

  scatterG.select('.x-axis').call(
    d3.axisBottom(xScale).ticks(5).tickFormat(v => vdx.fmt(v))
  ).selectAll('text').style('font-size','10px');
  scatterG.select('.y-axis').call(
    d3.axisLeft(yScale).ticks(5).tickFormat(v => vdy.fmt(v))
  ).selectAll('text').style('font-size','10px');
  scatterG.select('.x-axis-label').attr('x',scatterW/2).text(vdx.label);
  scatterG.select('.y-axis-label').attr('x',-scatterH/2).attr('y',-SM.left+13).text(vdy.label);

  const hasSel = state.selectedIds.size > 0;
  scatterG.selectAll('.dot-all')
    .data(allPairs, d=>d.id).join('circle').attr('class','dot-all')
    .attr('cx',d=>xScale(d.x)).attr('cy',d=>yScale(d.y)).attr('r',DOT_RADIUS)
    .attr('fill',    d => hasSel && !state.selectedIds.has(d.id) ? '#ddd' : '#3a7abf')
    .attr('opacity', d => hasSel && !state.selectedIds.has(d.id) ? DEEMPHASIS_OPACITY : 0.65)
    .attr('stroke',  d => hasSel &&  state.selectedIds.has(d.id) ? '#1a4a8f' : 'none')
    .attr('stroke-width', 0.8)
    .on('mousemove', (e,d) => onZoneHover(e, d.f))
    .on('mouseleave', hideTooltip);

  scatterG.selectAll('.dot-sel')
    .data(selPairs||[], d=>d.id).join('circle').attr('class','dot-sel')
    .attr('cx',d=>xScale(d.x)).attr('cy',d=>yScale(d.y)).attr('r',DOT_RADIUS+1)
    .attr('fill',SELECTION_COLOR).attr('opacity',0.9)
    .attr('stroke','#b05520').attr('stroke-width',0.8)
    .on('mousemove', (e,d) => onZoneHover(e, d.f))
    .on('mouseleave', hideTooltip);

  const regAll = regression(allPairs.map(d=>d.x), allPairs.map(d=>d.y));
  const regSel = selPairs && selPairs.length >= 2
    ? regression(selPairs.map(d=>d.x), selPairs.map(d=>d.y)) : null;

  drawRegLine('.reg-all', regAll, '#3a7abf', 0.5);
  drawRegLine('.reg-sel', regSel, SELECTION_COLOR, 0.9);

  setupScatterSel();
  drawStats(allPairs, selPairs, regAll, regSel);
}

function drawRegLine(cls, reg, color, opacity) {
  const line = scatterG.select(cls);
  if (!reg) {
    line.attr('x1',null).attr('x2',null).attr('y1',null).attr('y2',null);
    return;
  }
  const x0=xScale.domain()[0], x1=xScale.domain()[1];
  line.attr('x1',xScale(x0)).attr('y1',yScale(reg.slope*x0+reg.intercept))
      .attr('x2',xScale(x1)).attr('y2',yScale(reg.slope*x1+reg.intercept))
      .attr('stroke',color).attr('stroke-width',2).attr('opacity',opacity)
      .attr('pointer-events','none');
}

// ── Scatter lasso / rectangle ──
// Re-appends the overlay above the dots, which drawScatter joins in after it.
function setupScatterSel() {
  scatterG.selectAll('.sc-sel-path,.sc-sel-rect').remove();
  scatterG.append('path').attr('class','sc-sel-path');
  scatterG.append('rect').attr('class','sc-sel-rect')
    .attr('fill','rgba(80,120,255,0.06)').attr('stroke','none').style('display','none');
}

// Bound once from initScatter. As on the map, the drag is tracked on the
// window so it survives leaving the plot area, and so it always terminates.
function bindScatterSelEvents() {
  scatterSvg.on('mousedown.scsel', onScatterSelDown);
  d3.select(window)
    .on('mousemove.scsel', onScatterSelMove)
    .on('mouseup.scsel',   onScatterSelUp);
}

function scatterPoint(event) {
  const svg = scatterSvg.node();
  const pt = svg.createSVGPoint();
  pt.x = event.clientX;
  pt.y = event.clientY;
  const svgPt = pt.matrixTransform(svg.getScreenCTM().inverse());
  return [svgPt.x - SM.left, svgPt.y - SM.top];
}

function onScatterSelDown(event) {
  if (!event.shiftKey) return;
  event.preventDefault(); event.stopPropagation();
  const mode = event.altKey ? 'rect' : 'lasso';
  const pt   = scatterPoint(event);
  scatterSelDrag = { mode, points:[pt], startX:pt[0], startY:pt[1] };
}

function onScatterSelMove(event) {
  if (!scatterSelDrag) return;
  event.preventDefault();
  const pt = scatterPoint(event);
  scatterSelDrag.points.push(pt);
  if (scatterSelDrag.mode === 'lasso') {
    scatterG.select('.sc-sel-path')
      .attr('d','M'+[...scatterSelDrag.points,scatterSelDrag.points[0]].map(p=>p.join(',')).join('L')+'Z')
      .attr('fill','rgba(80,120,255,0.08)').attr('stroke','#4466cc')
      .attr('stroke-width',1.5).attr('stroke-dasharray','5,3').attr('stroke-linejoin','round');
  } else {
    const x0=Math.min(scatterSelDrag.startX,pt[0]), y0=Math.min(scatterSelDrag.startY,pt[1]);
    const w=Math.abs(pt[0]-scatterSelDrag.startX), h=Math.abs(pt[1]-scatterSelDrag.startY);
    scatterG.select('.sc-sel-rect').style('display',null)
      .attr('x',x0).attr('y',y0).attr('width',w).attr('height',h);
    scatterG.select('.sc-sel-path')
      .attr('d',`M${x0},${y0}h${w}v${h}h${-w}Z`)
      .attr('fill','none').attr('stroke','#4466cc')
      .attr('stroke-width',1.5).attr('stroke-dasharray','5,3');
  }
}

function onScatterSelUp(event) {
  if (!scatterSelDrag) return;
  const drag = scatterSelDrag; scatterSelDrag = null;
  const poly = drag.mode === 'lasso' ? drag.points : (() => {
    const pt = scatterPoint(event);
    const x0=Math.min(drag.startX,pt[0]), y0=Math.min(drag.startY,pt[1]);
    const x1=Math.max(drag.startX,pt[0]), y1=Math.max(drag.startY,pt[1]);
    return [[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
  })();
  if (poly.length < 3) { clearScatterSelPath(); return; }
  state.selectedIds.clear(); state.mode = 'scatter';
  state.geojson.features.forEach(f => {
    const vx=getVal(f,state.varX), vy=getVal(f,state.varY);
    if (vx==null||vy==null) return;
    if (d3.polygonContains(poly,[xScale(vx),yScale(vy)])) state.selectedIds.add(featureId(f));
  });
  scatterG.select('.sc-sel-path').attr('stroke-dasharray',null).attr('fill','rgba(80,120,255,0.10)');
  scatterG.select('.sc-sel-rect').style('display','none');
  setTimeout(clearScatterSelPath, 600);
  finishSelection();
}

function clearScatterSelPath() {
  scatterG.select('.sc-sel-path').attr('d',null).attr('fill','none');
  scatterG.select('.sc-sel-rect').style('display','none');
}

// ── Shared post-selection update ──
function finishSelection() {
  showClearBtn(state.selectedIds.size > 0);
  applyMapColors();
  drawScatter();
  updateStatusBar();
  emitSelectionChange();
}

// ============================================================
//  STATS PANEL
// ============================================================

function drawStats(allPairs, selPairs, regAll, regSel) {
  const panel  = document.getElementById('statsPanel');
  const hasSel = selPairs && selPairs.length > 0;
  const vdx = getVarDef(state.varX), vdy = getVarDef(state.varY);

  const sAll = {
    x: calcStats(allPairs.map(d=>d.x)),
    y: calcStats(allPairs.map(d=>d.y)),
  };
  const sSel = hasSel ? {
    x: calcStats(selPairs.map(d=>d.x)),
    y: calcStats(selPairs.map(d=>d.y)),
  } : null;

  function pct(sv, av) {
    if (sv==null||!av) return '—';
    const d = ((sv-av)/Math.abs(av))*100;
    return (d>=0?'+':'')+d.toFixed(1)+'%';
  }
  function pctCls(sv,av) {
    if (sv==null) return '';
    return sv-av>0.001?'pos':sv-av<-0.001?'neg':'';
  }
  function fmtR(r)    { return r ? r.r.toFixed(3) : '—'; }
  function fmtSlope(r,vd) { return r ? r.slope.toFixed(3)+' '+vd.unit+'/'+vdx.unit : '—'; }

  function statBlock(label, sA, sS, vd) {
    return `<div class="stats-var-label">${label}</div>` +
      ['Mean','Median','Std dev'].map((lbl,i) => {
        const k=['mean','median','stddev'][i];
        const av=sA[k], sv=sS?sS[k]:null;
        return `<div class="stats-row">
          <span class="stats-label">${lbl}</span>
          <span class="stats-val">${vd.fmt(av)}</span>
          ${sS?`<span class="stats-val stats-col-sel">${vd.fmt(sv)}</span>`:''}
          ${sS?`<span class="stats-pct ${pctCls(sv,av)}">${pct(sv,av)}</span>`:''}
        </div>`;
      }).join('');
  }

  panel.innerHTML = `
    <div class="stats-header">
      <span class="stats-title">Stats</span>
      <span class="stats-col-head">All (${allPairs.length})</span>
      ${hasSel?`<span class="stats-col-head stats-col-sel">Sel (${selPairs.length})</span>`:''}
      ${hasSel?`<span class="stats-col-head">Δ vs all</span>`:''}
    </div>
    ${statBlock(vdx.label+' (X)', sAll.x, sSel?.x, vdx)}
    <hr class="stats-divider">
    ${statBlock(vdy.label+' (Y)', sAll.y, sSel?.y, vdy)}
    <hr class="stats-divider">
    <div class="stats-var-label">Regression</div>
    <div class="stats-row">
      <span class="stats-label">r</span>
      <span class="stats-val">${fmtR(regAll)}</span>
      ${hasSel?`<span class="stats-val stats-col-sel">${fmtR(regSel)}</span>`:''}
      ${hasSel?`<span class="stats-pct"></span>`:''}
    </div>
    <div class="stats-row">
      <span class="stats-label">slope</span>
      <span class="stats-val">${fmtSlope(regAll,vdy)}</span>
      ${hasSel?`<span class="stats-val stats-col-sel">${fmtSlope(regSel,vdy)}</span>`:''}
      ${hasSel?`<span class="stats-pct"></span>`:''}
    </div>`;
  panel.style.display = 'block';
}

// ============================================================
//  SELECTION EVENT
// ============================================================

function emitSelectionChange() {
  document.dispatchEvent(new CustomEvent('selectionchange', {
    detail: { selectedIds:[...state.selectedIds], count:state.selectedIds.size,
              total:state.geojson.features.length, mode:state.mode,
              varX:state.varX, varY:state.varY },
    bubbles:true, composed:true,
  }));
}

// ============================================================
//  STATUS & CONTROLS
// ============================================================

// GEOGRAPHY_LABEL + 's' produced 'countys', 'parishs', 'municipalitys' for
// anyone adapting the tool, so the plural comes from config instead.
function geogLabel(n) {
  return n === 1 ? GEOGRAPHY_LABEL : GEOGRAPHY_LABEL_PLURAL;
}

function updateStatusBar() {
  const total=state.geojson.features.length, sel=state.selectedIds.size;
  document.getElementById('statusText').textContent = sel>0
    ? `${sel.toLocaleString()} of ${total.toLocaleString()} ${geogLabel(total)} selected`
    : `${total.toLocaleString()} ${geogLabel(total)}`;
}

function showClearBtn(show) {
  document.getElementById('clearBtn').style.display = show ? 'inline-block' : 'none';
}

function clearSelection() {
  state.selectedIds.clear(); state.mode = null;
  showClearBtn(false);
  applyMapColors();
  drawScatter();
  updateStatusBar();
  emitSelectionChange();
}

function onVarXChange(id) { state.varX=id; clearSelection(); computeBreaks(); drawMap(); drawScatter(); }
function onVarYChange(id) { state.varY=id; clearSelection(); computeBreaks(); drawMap(); drawScatter(); }

function onSchemeChange(id) {
  state.scheme = id;
  document.querySelectorAll('.sym-row').forEach(r =>
    r.classList.toggle('sym-row--active', r.dataset.schemeId===id));
  updateSymBtn();
  applyMapColors();
  drawLegend();
}

// ============================================================
//  PAGE IDENTITY
// ============================================================

function applyPageIdentity() {
  document.title = PAGE_TITLE;
  const h = document.getElementById('appTitle');
  if (h) h.textContent = PAGE_TITLE;
  const credit = document.getElementById('pageCredit');
  // DATA_CREDIT_HTML is authored in config.js rather than read from the
  // data, so it is trusted markup and may contain links.
  if (credit && DATA_CREDIT_HTML) credit.innerHTML = DATA_CREDIT_HTML;
}

// ============================================================
//  CONFIG PREFLIGHT
//  Catches the mistakes that are easy to make when pointing the tool
//  at a new dataset — a mistyped `prop`, a missing or duplicated id
//  field, a file that was never reprojected — and reports them on the
//  page. Without this a single wrong character in config.js renders a
//  blank map whose only clue is a TypeError in the devtools console.
// ============================================================

function code(text) {
  return `<code style="font-family:ui-monospace,Menlo,Consolas,monospace;` +
         `background:#f0f0f0;border-radius:3px;padding:0 3px;">${text}</code>`;
}
function stripTags(s) { return s.replace(/<[^>]*>/g, ''); }

// Union of property names across all features. GeoJSON does not require
// every feature to carry the same keys, so inspecting features[0] alone
// would raise false alarms on sparse data.
function collectPropertyNames(features) {
  const keys = new Set();
  features.forEach(f => {
    if (f.properties) Object.keys(f.properties).forEach(k => keys.add(k));
  });
  return keys;
}

function nameList(keys) {
  const all = [...keys];
  const shown = all.slice(0, 25).map(k => `'${k}'`).join(', ');
  return all.length > 25 ? `${shown}, … (${all.length} total)` : shown;
}

// Descend to the first coordinate pair and check it against lon/lat bounds.
// A projected file (State Plane feet, UTM metres, Web Mercator) carries
// values far outside this range, and geoMercator renders it as a single dot.
function looksUnprojected(features) {
  for (const f of features) {
    let c = f.geometry && f.geometry.coordinates;
    while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
    if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') {
      return Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90;
    }
  }
  return false;
}

// Returns { errors, warnings }. Errors stop the app and are shown on the
// page; warnings are repaired where possible and logged to the console.
function validateConfig(geojson) {
  const errors = [], warnings = [];

  if (!geojson || geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
    errors.push(`${code(DATA_FILE)} is not a GeoJSON FeatureCollection.`);
    return { errors, warnings };
  }
  const feats = geojson.features;
  if (!feats.length) {
    errors.push(`${code(DATA_FILE)} contains no features.`);
    return { errors, warnings };
  }

  // ── geometry ──
  const badGeom = feats.filter(f =>
    !f.geometry || (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon'));
  if (badGeom.length === feats.length) {
    errors.push('No feature has Polygon or MultiPolygon geometry, so there is nothing to draw.');
  } else if (badGeom.length) {
    const kinds = [...new Set(badGeom.map(f => (f.geometry && f.geometry.type) || 'null'))].join(', ');
    warnings.push(`${badGeom.length} of ${feats.length} features have unusable geometry (${kinds}) and will not appear on the map.`);
  }
  if (looksUnprojected(feats)) {
    errors.push('Coordinates fall outside the range of longitude and latitude, so this file is probably not in WGS 84 (EPSG:4326). Reproject it before loading — see the README.');
  }

  // ── identity fields ──
  const keys = collectPropertyNames(feats);
  if (!keys.has(FEATURE_ID_FIELD)) {
    errors.push(`FEATURE_ID_FIELD ${code(FEATURE_ID_FIELD)} is not a property of this data.<br>Available properties: ${nameList(keys)}`);
  } else {
    const ids = new Set(feats.map(featureId));
    if (ids.size !== feats.length) {
      errors.push(`FEATURE_ID_FIELD ${code(FEATURE_ID_FIELD)} is not unique — ${feats.length} features share only ${ids.size} distinct values. Duplicates are dropped from the map and break selection.`);
    }
  }
  if (FEATURE_NAME_FIELD && !keys.has(FEATURE_NAME_FIELD)) {
    warnings.push(`FEATURE_NAME_FIELD '${FEATURE_NAME_FIELD}' is not in the data — tooltips will have no title.`);
  }
  if (FEATURE_GROUP_FIELD && !keys.has(FEATURE_GROUP_FIELD)) {
    warnings.push(`FEATURE_GROUP_FIELD '${FEATURE_GROUP_FIELD}' is not in the data — set it to null to omit the tooltip's second line.`);
  }

  // ── variables ──
  if (!Array.isArray(VARIABLES) || !VARIABLES.length) {
    errors.push(`${code('VARIABLES')} is empty — add at least two mappable numeric fields.`);
  } else {
    if (VARIABLES.length < 2) {
      warnings.push('VARIABLES has only one entry, so the X and Y axes will show the same field.');
    }
    const seenIds = new Set();
    VARIABLES.forEach((v, i) => {
      const where = `VARIABLES[${i}]` + (v.label ? ` ('${v.label}')` : '');
      if (!v.id) errors.push(`${where} has no ${code('id')}.`);
      else if (seenIds.has(v.id)) errors.push(`${where} repeats the id '${v.id}' — ids must be unique.`);
      else seenIds.add(v.id);

      if (typeof v.fmt !== 'function') {
        errors.push(`${where} has no ${code('fmt')} function — it formats values for tooltips, axes and class breaks.`);
      }
      if (typeof v.unit !== 'string') {
        warnings.push(`${where} has no 'unit' string — the regression slope label will read "undefined".`);
      }

      if (!v.prop) { errors.push(`${where} has no ${code('prop')}.`); return; }
      if (!keys.has(v.prop)) {
        errors.push(`${where}: prop ${code(v.prop)} is not a property of this data.<br>Available properties: ${nameList(keys)}`);
        return;
      }
      const n = feats.reduce((acc, f) => {
        const raw = f.properties && f.properties[v.prop];
        return acc + ((raw == null || raw === '' || isNaN(+raw)) ? 0 : 1);
      }, 0);
      if (n === 0) {
        errors.push(`${where}: prop ${code(v.prop)} exists but holds no numeric values. Pre-compute it as a number before loading.`);
      } else if (n < feats.length * 0.5) {
        warnings.push(`${where}: only ${n} of ${feats.length} features have a numeric value for '${v.prop}'.`);
      }
    });
  }

  // ── projection and labels ──
  if (typeof PROJECTION !== 'function') {
    errors.push(`${code('PROJECTION')} must be a function returning a d3 projection, e.g. ${code('() => d3.geoMercator()')}.`);
  } else {
    let proj = null;
    try { proj = PROJECTION(); } catch (e) { /* reported below */ }
    if (!proj || typeof proj.fitSize !== 'function') {
      errors.push(`${code('PROJECTION')} did not return a usable d3 projection. It should be a factory, ${code('() => d3.geoMercator()')}, not a projection object.`);
    }
  }
  if (typeof CONFIG.GEOGRAPHY_LABEL_PLURAL !== 'string' || !CONFIG.GEOGRAPHY_LABEL_PLURAL) {
    warnings.push(`GEOGRAPHY_LABEL_PLURAL is not exported by config.js — falling back to '${GEOGRAPHY_LABEL_PLURAL}', which is wrong for words like 'county'.`);
  }
  if (typeof CONFIG.DATA_CREDIT_HTML !== 'string' || !CONFIG.DATA_CREDIT_HTML) {
    warnings.push('DATA_CREDIT_HTML is not exported by config.js, so the page footer carries no data credit.');
  }

  // ── defaults (repaired by repairDefaults(), so these only warn) ──
  const varIds = new Set((VARIABLES || []).map(v => v.id));
  if (varIds.size) {
    if (!varIds.has(DEFAULT_VAR_X)) warnings.push(`DEFAULT_VAR_X '${DEFAULT_VAR_X}' is not a VARIABLES id — falling back to the first variable.`);
    if (!varIds.has(DEFAULT_VAR_Y)) warnings.push(`DEFAULT_VAR_Y '${DEFAULT_VAR_Y}' is not a VARIABLES id — falling back to the first variable.`);
  }
  if (!BIVARIATE_SCHEMES[DEFAULT_BIVARIATE_SCHEME]) {
    warnings.push(`DEFAULT_BIVARIATE_SCHEME '${DEFAULT_BIVARIATE_SCHEME}' is not a known scheme — falling back to '${Object.keys(BIVARIATE_SCHEMES)[0]}'. Choose one of: ${Object.keys(BIVARIATE_SCHEMES).map(k => `'${k}'`).join(', ')}.`);
  }

  return { errors, warnings };
}

// An out-of-range default is a typo, not a reason to refuse to start.
function repairDefaults() {
  const varIds = new Set(VARIABLES.map(v => v.id));
  if (!varIds.has(state.varX)) state.varX = VARIABLES[0].id;
  if (!varIds.has(state.varY)) state.varY = VARIABLES[Math.min(1, VARIABLES.length - 1)].id;
  if (!BIVARIATE_SCHEMES[state.scheme]) state.scheme = Object.keys(BIVARIATE_SCHEMES)[0];
}

// Reuses the loading overlay so problems appear over the map, in the place
// the map would have been.
function showStartupProblems(errors, warnings) {
  const box  = document.getElementById('loadingMsg');
  const list = items => items.map(m => `<li style="margin:0 0 7px;">${m}</li>`).join('');
  box.style.display        = 'flex';
  box.style.alignItems     = 'flex-start';
  box.style.justifyContent = 'flex-start';
  box.style.overflow       = 'auto';
  box.style.padding        = '20px 24px';
  box.innerHTML = `
    <div style="max-width:660px;font-size:12px;line-height:1.55;color:#444;text-align:left;">
      <div style="font-size:13px;font-weight:700;color:#c0392b;margin-bottom:9px;">
        ⚠ config.js does not match this data
      </div>
      <ul style="margin:0 0 0 18px;padding:0;">${list(errors)}</ul>
      ${warnings.length ? `<div style="font-weight:700;color:#9a7000;margin:13px 0 6px;">Also worth fixing</div>
      <ul style="margin:0 0 0 18px;padding:0;">${list(warnings)}</ul>` : ''}
      <div style="margin-top:13px;color:#888;">Correct these in ${code('config.js')} and reload.</div>
    </div>`;
}

// ============================================================
//  RESIZE
//  resizeMap() and recalcScatterDims() used to run only at startup, so the
//  SVGs kept whatever viewBox the panes had on load. After a window resize
//  the map letterboxed inside its pane and, because svgPoint() works from
//  raw screen offsets, lasso coordinates drifted out of step with the cursor.
// ============================================================

function handleResize() {
  if (!state.geojson) return;
  resizeMap();
  drawMap();
  recalcScatterDims();
  layoutScatter();
  drawScatter();
}

function observeResize() {
  // Coalesce bursts of observer callbacks into one redraw per frame.
  let queued = false;
  const ro = new ResizeObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; handleResize(); });
  });
  ro.observe(document.getElementById('mapPane'));
  ro.observe(document.getElementById('scatterPane'));
}

// ============================================================
//  INIT
// ============================================================

async function init() {
  applyPageIdentity();
  document.getElementById('loadingMsg').style.display = 'flex';
  try {
    const res = await fetch(DATA_FILE);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.geojson = await res.json();
  } catch(err) {
    showStartupProblems([
      `Could not load ${code(DATA_FILE)} — ${err.message}.`,
      `Check DATA_FILE in ${code('config.js')}, and make sure the folder is being served
       over HTTP: a ${code('file://')} URL will not work.`,
    ], []);
    return;
  }

  // Report config/data mismatches here rather than letting them surface as
  // a blank map and a console TypeError several draw calls later.
  const { errors, warnings } = validateConfig(state.geojson);
  warnings.forEach(w => console.warn('[config]', stripTags(w)));
  if (errors.length) { showStartupProblems(errors, warnings); return; }
  repairDefaults();

  document.getElementById('loadingMsg').style.display = 'none';

  // This deployment fixes the pairing (snow on X, potholes on Y) and drops
  // the pickers from index.html, so every lookup here is optional. When the
  // <select>s are present the tool behaves exactly as upstream.
  ['varXSelect','varYSelect'].forEach((elId, idx) => {
    const sel = document.getElementById(elId);
    if (!sel) return;
    const def = idx===0 ? state.varX : state.varY;
    sel.innerHTML = '';
    VARIABLES.forEach(v => {
      const opt = document.createElement('option');
      opt.value=v.id; opt.textContent=v.label;
      if (v.id===def) opt.selected=true;
      sel.appendChild(opt);
    });
  });

  document.getElementById('varXSelect')?.addEventListener('change', e=>onVarXChange(e.target.value));
  document.getElementById('varYSelect')?.addEventListener('change', e=>onVarYChange(e.target.value));

  // Static stand-in for the pickers, if index.html provides one.
  const axisX = document.getElementById('axisXName');
  const axisY = document.getElementById('axisYName');
  if (axisX) axisX.textContent = getVarDef(state.varX).label;
  if (axisY) axisY.textContent = getVarDef(state.varY).label;
  document.getElementById('clearBtn').addEventListener('click', clearSelection);

  const symBtn = document.getElementById('symBtn');
  symBtn.addEventListener('click', e => {
    e.stopPropagation(); toggleSymDropdown();
  });
  // role="button" promises keyboard operability that a click handler alone
  // does not deliver: Enter and Space did nothing.
  symBtn.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault(); e.stopPropagation(); toggleSymDropdown();
    }
  });
  document.addEventListener('click', e => {
    if (symDropdownOpen &&
        !document.getElementById('symDropdown').contains(e.target) &&
        !document.getElementById('symBtn').contains(e.target)) closeSymDropdown();
  });
  document.addEventListener('keydown', e => { if(e.key==='Escape') closeSymDropdown(); });

  document.getElementById('zoomIn').addEventListener('click',    ()=>zoomBy(2));
  document.getElementById('zoomOut').addEventListener('click',   ()=>zoomBy(0.5));
  document.getElementById('zoomReset').addEventListener('click', ()=>zoomReset());

  initMap();
  resizeMap();
  drawMap();
  setupMapBrush();

  initScatter();
  drawScatter();
  updateStatusBar();

  buildSymDropdown();
  updateSymBtn();

  observeResize();
}

window.addEventListener('DOMContentLoaded', init);
