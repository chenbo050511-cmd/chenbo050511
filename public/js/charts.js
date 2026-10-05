/* 纯 SVG 图表 —— 不引任何 CDN，离线也能画 */
(function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';

  /** 环形进度（用于今日目标） */
  function ring(percent, opts = {}) {
    const size = opts.size || 108;
    const stroke = opts.stroke || 9;
    const p = Math.max(0, Math.min(100, Number(percent) || 0));
    const r = (size - stroke) / 2 - 1;
    const c = 2 * Math.PI * r;
    const dash = (p / 100) * c;
    const color = opts.color || 'var(--accent)';

    return `
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none"
                stroke="var(--track)" stroke-width="${stroke}" stroke-linecap="round"/>
        <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none"
                stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"
                stroke-dasharray="${dash} ${c}" style="transition: stroke-dasharray .6s cubic-bezier(.22,.61,.36,1)"/>
      </svg>`;
  }

  /**
   * 柱状图布局：算好柱宽、间距，并把整组柱子居中。
   * 不加这层的话，只有 7 天数据时单根柱子会被拉成 95px 宽的「砖头」。
   * offset 里要算上左侧刻度轴的宽度，否则整组柱子会整体偏左。
   */
  function layout(n, plotW, maxBarWidth, padLeft) {
    const maxBW = maxBarWidth || 34;
    const gap = Math.max(2, Math.min(9, (plotW / n) * 0.25));
    const bw = Math.min(maxBW, Math.max(2, (plotW - gap * (n - 1)) / n));
    const contentW = n * bw + (n - 1) * gap;
    const offset = padLeft + Math.max(0, (plotW - contentW) / 2);
    return { bw, gap, offset, xOf: (i) => offset + i * (bw + gap) };
  }

  /**
   * 柱状图
   * items: [{ label, value, color? }]
   */
  function barChart(items, opts = {}) {
    const W = 700;
    const H = opts.height || 160;
    const padTop = 16;
    const padBottom = 24;
    const padLeft = 30;
    const plotW = W - padLeft;
    const n = Math.max(1, items.length);
    const { bw, xOf } = layout(n, plotW, opts.maxBarWidth, padLeft);
    const max = Math.max(1, ...items.map((i) => Number(i.value) || 0));
    const plotH = H - padTop - padBottom;

    const y = (v) => padTop + plotH - (v / max) * plotH;

    // 横向网格线（3 档）
    let grid = '';
    for (let i = 0; i <= 2; i++) {
      const val = Math.round((max / 2) * i);
      const yy = y(val);
      grid += `<line class="grid-line" x1="${padLeft}" y1="${yy}" x2="${W}" y2="${yy}" stroke-dasharray="3 5"/>
               <text class="axis-text" x="${padLeft - 7}" y="${yy + 3.5}" text-anchor="end">${val}</text>`;
    }

    const labelEvery = Math.max(1, Math.ceil(n / 9));
    let bars = '';
    let labels = '';
    items.forEach((it, i) => {
      const v = Number(it.value) || 0;
      const x = xOf(i);
      const h = v > 0 ? Math.max(2.5, (v / max) * plotH) : 2;
      const yy = v > 0 ? y(v) : padTop + plotH - 2;
      const fill = it.color || (v > 0 ? 'var(--accent)' : 'var(--track)');
      const rx = Math.min(4, bw / 2).toFixed(1);
      bars += `<rect class="bar-rect" x="${x.toFixed(1)}" y="${yy.toFixed(1)}"
                     width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="${rx}"
                     fill="${fill}"><title>${it.label}：${v}</title></rect>`;
      if (i % labelEvery === 0 || i === n - 1) {
        labels += `<text class="axis-text" x="${(x + bw / 2).toFixed(1)}" y="${H - 8}"
                         text-anchor="middle">${it.label}</text>`;
      }
    });

    return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img">
      ${grid}${bars}${labels}
    </svg>`;
  }

  /** 双色堆积柱状图：正确 / 错误 */
  function stackedBar(items, opts = {}) {
    const W = 700;
    const H = opts.height || 170;
    const padTop = 16;
    const padBottom = 24;
    const padLeft = 34;
    const plotW = W - padLeft;
    const n = Math.max(1, items.length);
    const { bw, xOf } = layout(n, plotW, opts.maxBarWidth, padLeft);
    const max = Math.max(1, ...items.map((i) => (Number(i.right) || 0) + (Number(i.wrong) || 0)));
    const plotH = H - padTop - padBottom;
    const y = (v) => padTop + plotH - (v / max) * plotH;

    let grid = '';
    for (let i = 0; i <= 2; i++) {
      const val = Math.round((max / 2) * i);
      const yy = y(val);
      grid += `<line class="grid-line" x1="${padLeft}" y1="${yy}" x2="${W}" y2="${yy}" stroke-dasharray="3 5"/>
               <text class="axis-text" x="${padLeft - 7}" y="${yy + 3.5}" text-anchor="end">${val}</text>`;
    }

    const labelEvery = Math.max(1, Math.ceil(n / 9));
    const rx = Math.min(4, bw / 2).toFixed(1);
    let bars = '';
    let labels = '';
    items.forEach((it, i) => {
      const right = Number(it.right) || 0;
      const wrong = Number(it.wrong) || 0;
      const total = right + wrong;
      const x = xOf(i);
      if (total === 0) {
        bars += `<rect x="${x.toFixed(1)}" y="${(padTop + plotH - 2).toFixed(1)}" width="${bw.toFixed(1)}" height="2" rx="1" fill="var(--track)"/>`;
      } else {
        const hTotal = (total / max) * plotH;
        const hRight = (right / total) * hTotal;
        const hWrong = hTotal - hRight;
        const yTop = y(total);
        bars += `<g><title>${it.label}：对 ${right} / 错 ${wrong}</title>`;
        if (hRight > 0) {
          bars += `<rect x="${x.toFixed(1)}" y="${(yTop + hWrong).toFixed(1)}" width="${bw.toFixed(1)}" height="${hRight.toFixed(1)}" fill="var(--ok)" ${hWrong === 0 ? `rx="${rx}"` : ''}/>`;
        }
        if (hWrong > 0) {
          bars += `<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${bw.toFixed(1)}" height="${hWrong.toFixed(1)}" fill="var(--bad)" rx="${rx}"/>`;
        }
        bars += '</g>';
      }
      if (i % labelEvery === 0 || i === n - 1) {
        labels += `<text class="axis-text" x="${(x + bw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${it.label}</text>`;
      }
    });

    return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img">${grid}${bars}${labels}</svg>`;
  }

  /**
   * 热力图：按周分列，每列 7 天（周一到周日）
   * items: [{ day: 'YYYY-MM-DD', learned: n }] 按时间升序
   */
  function heatmap(items, opts = {}) {
    if (!items.length) return '<div class="empty">还没有学习记录</div>';

    const max = Math.max(1, ...items.map((i) => i.learned));
    const COLORS = [
      'var(--track)',
      'color-mix(in srgb, var(--accent) 30%, transparent)',
      'color-mix(in srgb, var(--accent) 55%, transparent)',
      'color-mix(in srgb, var(--accent) 78%, transparent)',
      'var(--accent)',
    ];
    const level = (v) => {
      if (!v) return 0;
      const r = v / max;
      if (r <= 0.25) return 1;
      if (r <= 0.5) return 2;
      if (r <= 0.75) return 3;
      return 4;
    };

    // 首列补齐到周一
    const first = new Date(items[0].day + 'T00:00:00');
    const shift = (first.getDay() + 6) % 7;   // 周一=0
    const cells = [...Array(shift).fill(null), ...items];

    let cols = '';
    for (let i = 0; i < cells.length; i += 7) {
      const week = cells.slice(i, i + 7);
      let col = '<div class="heat-col">';
      for (const c of week) {
        if (!c) {
          col += '<div class="heat-cell" style="background:transparent"></div>';
        } else {
          const [, m, d] = c.day.split('-');
          col += `<div class="heat-cell" style="background:${COLORS[level(c.learned)]}"
                        title="${m}月${d}日 · ${c.learned} 次"></div>`;
        }
      }
      col += '</div>';
      cols += col;
    }

    return `<div class="heatmap">${cols}</div>`;
  }

  /** 横向分布条（阶段分布用） */
  function stageBars(items, opts = {}) {
    const max = Math.max(1, ...items.map((i) => i.count));
    return items
      .map((it) => {
        const pct = (it.count / max) * 100;
        const color = opts.colorFor ? opts.colorFor(it) : 'var(--accent)';
        return `<div class="stage-row">
          <span class="lbl">${it.label}</span>
          <span class="bar"><i style="width:${pct}%;background:${color}"></i></span>
          <span class="num">${it.count}</span>
        </div>`;
      })
      .join('');
  }

  window.Charts = { ring, barChart, stackedBar, heatmap, stageBars };
})();
