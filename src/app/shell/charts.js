// Small dependency-free SVG charts for the local insight pages. Colors come from CSS custom properties
// (--series-1..8, --seq-*), so light and dark mode are chosen in CSS, not here.
(function (root) {
  const NS = 'http://www.w3.org/2000/svg';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let tip;
  function tooltip() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.className = 'viz-tip';
    tip.hidden = true;
    document.body.appendChild(tip);
    return tip;
  }
  function showTip(event, html) {
    const box = tooltip();
    box.innerHTML = html;
    box.hidden = false;
    const pad = 14, w = box.offsetWidth, h = box.offsetHeight;
    let x = event.clientX + pad, y = event.clientY + pad;
    if (x + w > innerWidth - 8) x = event.clientX - w - pad;
    if (y + h > innerHeight - 8) y = event.clientY - h - pad;
    box.style.transform = `translate(${Math.max(8, x)}px,${Math.max(8, y)}px)`;
  }
  function hideTip() { if (tip) tip.hidden = true; }
  const el = (name, attrs = {}) => { const node = document.createElementNS(NS, name); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v); return node; };
  function niceMax(value) {
    if (value <= 0) return 1;
    const power = 10 ** Math.floor(Math.log10(value));
    for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= value) return step * power;
    return 10 * power;
  }
  /** Path for a bar with 4px rounded top corners and a square base on the baseline. */
  function barPath(x, y, w, h, r) {
    r = Math.min(r, w / 2, h);
    if (h <= 0) return '';
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  /**
   * Stacked columns over categories (days). series: [{ name, color, values[] }]. Each column's top segment is rounded,
   * segments are separated by a 2px surface gap, and hovering a column lists every series with its value.
   */
  function columns(container, { labels, series, format = v => v, height = 220, emptyText = '' }) {
    container.innerHTML = '';
    const width = Math.max(320, container.clientWidth || 600);
    const totals = labels.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] || 0), 0));
    const max = niceMax(Math.max(...totals, 0));
    const left = 36, right = 8, top = 10, bottom = 24;
    const plotW = width - left - right, plotH = height - top - bottom;
    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'viz', role: 'img', style: `width:${width}px;height:${height}px` });
    for (let i = 0; i <= 3; i++) {
      const y = top + plotH - (plotH * i) / 3;
      svg.appendChild(el('line', { x1: left, x2: width - right, y1: y, y2: y, class: i === 0 ? 'axis' : 'grid' }));
      const t = el('text', { x: left - 6, y: y + 4, class: 'tick', 'text-anchor': 'end' });
      t.textContent = format(Math.round((max * i) / 3));
      svg.appendChild(t);
    }
    const step = plotW / Math.max(1, labels.length);
    const barW = Math.max(3, Math.min(28, step * 0.62));
    const every = Math.ceil(labels.length / Math.max(1, Math.floor(plotW / 54)));
    labels.forEach((label, i) => {
      const x = left + step * i + (step - barW) / 2;
      let base = top + plotH;
      const visible = series.filter(s => (s.values[i] || 0) > 0);
      visible.forEach((s, index) => {
        const h = (plotH * (s.values[i] || 0)) / max;
        const isTop = index === visible.length - 1;
        const gap = index > 0 ? 2 : 0;
        const segH = Math.max(0, h - gap);
        const y = base - h;
        const shape = isTop ? el('path', { d: barPath(x, y, barW, segH, 4), fill: s.color }) : el('rect', { x, y, width: barW, height: segH, fill: s.color });
        svg.appendChild(shape);
        base = y;
      });
      if (i % every === 0) {
        const t = el('text', { x: x + barW / 2, y: height - 6, class: 'tick', 'text-anchor': 'middle' });
        t.textContent = label;
        svg.appendChild(t);
      }
      const hit = el('rect', { x: left + step * i, y: top, width: step, height: plotH, class: 'hit' });
      hit.addEventListener('mousemove', event => showTip(event, `<b>${esc(label)}</b>` + series.map(s => `<div class="row"><i style="background:${s.color}"></i><span>${esc(s.name)}</span><b>${esc(format(s.values[i] || 0))}</b></div>`).join('') + (series.length > 1 ? `<div class="row total"><span>Σ</span><b>${esc(format(totals[i]))}</b></div>` : '')));
      hit.addEventListener('mouseleave', hideTip);
      svg.appendChild(hit);
    });
    container.appendChild(svg);
    if (!totals.some(Boolean) && emptyText) { const note = document.createElement('div'); note.className = 'viz-empty'; note.textContent = emptyText; container.appendChild(note); }
  }

  /** Weekday × hour grid, one sequential hue (5 steps), empty cells stay on the surface. */
  function heatmap(container, { matrix, rows, format = v => v, unit = '' }) {
    container.innerHTML = '';
    const max = Math.max(1, ...matrix.flat());
    const cell = 'var(--seq-0)';
    const steps = ['var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)', 'var(--seq-5)'];
    const grid = document.createElement('div');
    grid.className = 'heat';
    grid.innerHTML = '<span></span>' + Array.from({ length: 24 }, (_, h) => `<span class="hx">${h % 3 === 0 ? h : ''}</span>`).join('');
    matrix.forEach((row, r) => {
      grid.insertAdjacentHTML('beforeend', `<span class="hy">${esc(rows[r])}</span>`);
      row.forEach((value, h) => {
        const span = document.createElement('span');
        span.className = 'hc';
        span.style.background = value ? steps[Math.min(4, Math.floor((value / max) * 4.999))] : cell;
        span.addEventListener('mousemove', event => showTip(event, `<b>${esc(rows[r])} ${h}:00–${h + 1}:00</b><div class="row"><span>${esc(unit)}</span><b>${esc(format(value))}</b></div>`));
        span.addEventListener('mouseleave', hideTip);
        grid.appendChild(span);
      });
    });
    container.appendChild(grid);
  }

  /** Horizontal bars as HTML rows: label, bar, value. */
  function hbars(container, { rows, format = v => v, color = 'var(--series-1)' }) {
    const max = Math.max(1, ...rows.map(r => r.value));
    container.innerHTML = rows.map(r => `<div class="hbar" title="${esc(r.title || r.label)}"><span class="hl">${esc(r.label)}</span><span class="ht"><i style="width:${Math.max(2, (100 * r.value) / max)}%;background:${r.color || color}"></i></span><b>${esc(format(r.value))}</b></div>`).join('');
  }

  /** A thin ring for a single share (success rate and the like); the number sits inside, the ring is decoration. */
  function ring(percent, color = 'var(--series-3)') {
    const r = 26, c = 2 * Math.PI * r, p = Math.max(0, Math.min(100, percent || 0));
    return `<svg class="ring" viewBox="0 0 64 64" width="64" height="64"><circle cx="32" cy="32" r="${r}" class="ring-bg"/><circle cx="32" cy="32" r="${r}" stroke="${color}" stroke-dasharray="${(c * p) / 100} ${c}" transform="rotate(-90 32 32)" class="ring-fg"/></svg>`;
  }

  root.WaymarkCharts = { columns, heatmap, hbars, ring, showTip, hideTip, esc };
})(globalThis);
