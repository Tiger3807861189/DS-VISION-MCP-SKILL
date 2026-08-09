#!/usr/bin/env node
// DS-VISION BUFF — pixel-level evidence tools that compensate for the
// vision model's weak spots (coordinates, small details, exact colors).
//
// Every command prints one JSON object for the agent to consume directly.
//
//   size <img>
//   color <img> [nx,ny]... [--grid CxR]
//   mask  <img> --hex RRGGBB [--tol N] [--row-band y0,y1]
//   textlines <img> --region x0,y0,x1,y1 [--dark 75]
//   trapezoid <img> --hex RRGGBB [--tol N]
//   diff <imgA> <imgB> [--grid CxR] [--tol N]
//   tilt-test <angle>
//
// Coordinates are normalized 0..1. Colors are hex without '#'.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const cmd = args[0];
const imgOf = (p) => `data:${p.endsWith(".png") ? "image/png" : "image/jpeg"};base64,${readFileSync(p).toString("base64")}`;

function parseOpts(a) {
  const o = { pos: [] };
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith("--")) {
      const k = a[i].slice(2);
      o[k] = a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : true;
      if (o[k] !== true) i++;
    } else o.pos.push(a[i]);
  }
  return o;
}

const HELPERS = `
  const W = img.naturalWidth, H = img.naturalHeight;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, W, H).data;
  const px = (x, y) => [d[(y*W+x)*4], d[(y*W+x)*4+1], d[(y*W+x)*4+2]];
  const near = (p, [tr,tg,tb], tol) => Math.abs(p[0]-tr)<=tol && Math.abs(p[1]-tg)<=tol && Math.abs(p[2]-tb)<=tol;
`;

async function evalImage(imgPath, fnBody) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto("about:blank");
  const src = imgOf(imgPath);
  const out = await page.evaluate(`(async (src) => { const img = new Image(); img.src = src; await img.decode(); ${fnBody} })(${JSON.stringify(src)})`);
  await browser.close();
  return out;
}

async function run() {
  const o = parseOpts(args.slice(1));
  const img = o.pos[0];
  const needsImg = !["tilt-test"].includes(cmd);
  if (needsImg && !img) {
    console.log(JSON.stringify({ error: "missing image path", usage: "size|color|mask|textlines|trapezoid|diff|tilt-test" }));
    return;
  }

  if (cmd === "size") {
    console.log(JSON.stringify(await evalImage(img, `return { w: img.naturalWidth, h: img.naturalHeight, aspect: +(img.naturalWidth/img.naturalHeight).toFixed(3) };`)));
    return;
  }

  if (cmd === "color") {
    const grid = o.grid ? o.grid.split("x").map(Number) : null;
    const pts = JSON.stringify(o.pos.slice(1));
    const g = JSON.stringify(grid);
    const out = await evalImage(img, `
      ${HELPERS}
      const result = { samples: {}, grid: [] };
      if (${g}) {
        const [C, R] = ${g};
        for (let r2 = 0; r2 < R; r2++) {
          const row = [];
          for (let c2 = 0; c2 < C; c2++) {
            const x = Math.min(W-1, Math.round((c2+0.5)/C*W));
            const y = Math.min(H-1, Math.round((r2+0.5)/R*H));
            row.push('#' + px(x,y).map(v=>v.toString(16).padStart(2,'0')).join(''));
          }
          result.grid.push(row.join(' '));
        }
      }
      for (const p of ${pts}) {
        const [nx, ny] = p.split(',').map(Number);
        const x = Math.min(W-1, Math.round(nx*W)), y = Math.min(H-1, Math.round(ny*H));
        result.samples['(' + nx + ',' + ny + ')'] = '#' + px(x,y).map(v=>v.toString(16).padStart(2,'0')).join('');
      }
      return result;
    `);
    console.log(JSON.stringify(out, null, 1));
    return;
  }

  if (cmd === "mask") {
    const hex = (o.hex || "000000").replace("#", "");
    const tol = Number(o.tol || 28);
    const rowBand = o["row-band"] ? JSON.stringify(o["row-band"].split(",").map(Number)) : "null";
    const out = await evalImage(img, `
      ${HELPERS}
      const [tr, tg, tb] = [parseInt('${hex}'.slice(0,2),16), parseInt('${hex}'.slice(2,4),16), parseInt('${hex}'.slice(4,6),16)];
      const bbox = { minX: W, minY: H, maxX: -1, maxY: -1, count: 0 };
      for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
        if (near(px(x,y), [tr,tg,tb], ${tol})) {
          if (x < bbox.minX) bbox.minX = x; if (x > bbox.maxX) bbox.maxX = x;
          if (y < bbox.minY) bbox.minY = y; if (y > bbox.maxY) bbox.maxY = y;
          bbox.count++;
        }
      }
      const result = { hex: '#${hex}', tol: ${tol}, bbox: null, rows: [] };
      if (bbox.count > 0) result.bbox = { x0: +(bbox.minX/W).toFixed(3), y0: +(bbox.minY/H).toFixed(3), x1: +(bbox.maxX/W).toFixed(3), y1: +(bbox.maxY/H).toFixed(3), count: bbox.count };
      const rb = ${rowBand};
      if (rb) {
        for (let y = Math.round(rb[0]*H); y <= Math.round(rb[1]*H); y++) {
          let x0 = -1, x1 = -1;
          for (let x = Math.round(0.05*W); x < W; x++) if (near(px(x,y), [tr,tg,tb], ${tol})) { if (x0 < 0) x0 = x; x1 = x; }
          if (x0 >= 0) result.rows.push({ fy: +(y/H).toFixed(3), fx0: +(x0/W).toFixed(3), fx1: +(x1/W).toFixed(3) });
        }
      }
      return result;
    `);
    console.log(JSON.stringify(out, null, 1));
    return;
  }

  if (cmd === "textlines") {
    const [rx0, ry0, rx1, ry1] = (o.region || "0.33,0.25,0.67,0.82").split(",").map(Number);
    const dark = Number(o.dark || 75);
    const out = await evalImage(img, `
      ${HELPERS}
      const x0 = Math.round(${rx0}*W), x1 = Math.round(${rx1}*W);
      const rows = [];
      for (let y = Math.round(${ry0}*H); y <= Math.round(${ry1}*H); y++) {
        let dn = 0, total = 0, xmin = W, xmax = -1;
        for (let x = x0; x <= x1; x += 2) {
          const p = px(x, y);
          if (0.299*p[0]+0.587*p[1]+0.114*p[2] < ${dark}) { dn++; if (x < xmin) xmin = x; if (x > xmax) xmax = x; }
          total++;
        }
        rows.push({ fy: y/H, frac: dn/total, fx0: xmin/W, fx1: xmax/W });
      }
      const bands = []; let cur = null;
      for (const rr of rows) {
        if (rr.frac > 0.045) {
          if (!cur) cur = { y0: rr.fy, y1: rr.fy, peak: rr.frac, peakY: rr.fy, x0: rr.fx0, x1: rr.fx1 };
          else { cur.y1 = rr.fy; if (rr.frac > cur.peak) { cur.peak = rr.frac; cur.peakY = rr.fy; cur.x0 = rr.fx0; cur.x1 = rr.fx1; } }
        } else if (cur) { bands.push(cur); cur = null; }
      }
      if (cur) bands.push(cur);
      const merged = [];
      for (const b of bands) {
        const last = merged[merged.length-1];
        if (last && (b.y0 - last.y1)*H < 4) { last.y1 = b.y1; if (b.peak > last.peak) { last.peak = b.peak; last.peakY = b.peakY; last.x0 = b.x0; last.x1 = b.x1; } }
        else merged.push({ ...b });
      }
      return merged.filter(b => b.peak > 0.1 && b.peakY < 0.80).map(b => ({ y0: +b.y0.toFixed(3), y1: +b.y1.toFixed(3), peakY: +b.peakY.toFixed(3), peak: +b.peak.toFixed(2), x0: +b.x0.toFixed(3), x1: +b.x1.toFixed(3) }));
    `);
    console.log(JSON.stringify(out, null, 1));
    return;
  }

  if (cmd === "trapezoid") {
    const hex = (o.hex || "8f7954").replace("#", "");
    const tol = Number(o.tol || 28);
    const out = await evalImage(img, `
      ${HELPERS}
      const [tr, tg, tb] = [parseInt('${hex}'.slice(0,2),16), parseInt('${hex}'.slice(2,4),16), parseInt('${hex}'.slice(4,6),16)];
      const cols = [];
      for (let i = 0; i < 5; i++) {
        const x = Math.round((0.35 + i*0.075) * W);
        let top = -1, bot = -1;
        for (let y = Math.round(0.20*H); y <= Math.round(0.34*H); y++) if (near(px(x,y), [tr,tg,tb], ${tol})) { top = y; break; }
        for (let y = Math.round(0.90*H); y >= Math.round(0.75*H); y--) if (near(px(x,y), [tr,tg,tb], ${tol})) { bot = y; break; }
        if (top >= 0 || bot >= 0) cols.push({ x: +(x/W).toFixed(3), top: top >= 0 ? +(top/H).toFixed(3) : null, bot: bot >= 0 ? +(bot/H).toFixed(3) : null });
      }
      const valid = cols.filter(k => k.top !== null && k.bot !== null);
      if (valid.length < 2) return { error: "not enough columns matched", cols };
      const L = valid[0], R = valid[valid.length - 1];
      return {
        cols: valid,
        topSlope: +((R.top - L.top) / (R.x - L.x)).toFixed(4),
        botSlope: +((R.bot - L.bot) / (R.x - L.x)).toFixed(4),
        ratioLeftOverRight: +((L.bot - L.top) / (R.bot - R.top)).toFixed(3),
        hint: "ratio > 1 => left edge taller => left nearer the camera",
      };
    `);
    console.log(JSON.stringify(out, null, 1));
    return;
  }

  if (cmd === "diff") {
    const grid = (o.grid || "8x6").split("x").map(Number);
    const tol = Number(o.tol || 30);
    const srcB = imgOf(o.pos[1]);
    const out = await evalImage(img, `
      const imB = new Image(); imB.src = ${JSON.stringify(srcB)}; await imB.decode();
      const W = img.naturalWidth, H = img.naturalHeight;
      const mk = (im) => {
        const c = document.createElement("canvas"); c.width = W; c.height = H;
        const ctx = c.getContext("2d"); ctx.drawImage(im, 0, 0);
        return ctx.getImageData(0, 0, W, H).data;
      };
      const dA = mk(img), dB = mk(imB);
      const [C, R] = ${JSON.stringify(grid)};
      const cells = [];
      let maxDiff = 0;
      for (let r2 = 0; r2 < R; r2++) for (let c2 = 0; c2 < C; c2++) {
        const x = Math.min(W-1, Math.round((c2+0.5)/C*W)), y = Math.min(H-1, Math.round((r2+0.5)/R*H));
        const i = (y*W+x)*4;
        const diff = Math.max(Math.abs(dA[i]-dB[i]), Math.abs(dA[i+1]-dB[i+1]), Math.abs(dA[i+2]-dB[i+2]));
        maxDiff = Math.max(maxDiff, diff);
        cells.push({ x: +(x/W).toFixed(2), y: +(y/H).toFixed(2), diff });
      }
      const changed = cells.filter(k => k.diff > ${tol});
      return { grid: [C, R], tol: ${tol}, maxDiff, changedCells: changed.length, totalCells: cells.length, biggest: changed.sort((a,b)=>b.diff-a.diff).slice(0,8) };
    `);
    console.log(JSON.stringify(out, null, 1));
    return;
  }

  if (cmd === "tilt-test") {
    const angle = Number(o.pos[0] || 10);
    const testHtml = `<!DOCTYPE html><html><head><style>
      body{margin:0;background:#000}
      #p{position:absolute;inset:0;perspective:1600px;perspective-origin:50% 50%}
      #t{position:absolute;left:667px;top:134px;width:400px;height:600px;background:#ff0000;transform:rotateY(${angle}deg);transform-origin:50% 50%}
    </style></head><body><div id="p"><div id="t"></div></div></body></html>`;
    const tmp = "C:/Users/Tiger/Desktop/_ds-vision-repo/.ds-vision/buff-tilt.html";
    writeFileSync(tmp, testHtml);
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1734, height: 868 } });
    await page.goto("file:///" + tmp.replace(/\\/g, "/"));
    await page.waitForTimeout(200);
    const m = await page.evaluate((angle) => {
      const el = document.getElementById("t");
      const probe = (x) => {
        let lo = 0, hi = 868, top = -1;
        while (lo < hi) { const mid = (lo+hi)>>1; const h = document.elementFromPoint(x, mid); if (h === el || el.contains(h)) { hi = mid; top = mid; } else lo = mid + 1; }
        let bot = -1; lo = 0; hi = 868;
        while (lo < hi) { const mid = (lo+hi+1)>>1; const h = document.elementFromPoint(x, mid); if (h === el || el.contains(h)) { lo = mid; bot = mid; } else hi = mid - 1; }
        return { top, bot };
      };
      const cols = [];
      for (let x = 640; x <= 1100; x += 20) { const p = probe(x); if (p.top >= 0) cols.push({ x, ...p }); }
      const L = cols[0], R = cols[cols.length - 1];
      const taller = (L.bot - L.top) > (R.bot - R.top);
      return {
        rotateY: angle + "deg",
        leftEdgeH: L.bot - L.top, rightEdgeH: R.bot - R.top,
        conclusion: taller ? "rotateY(+) = LEFT edge nearer camera (left-near)" : "rotateY(+) = RIGHT edge nearer camera",
      };
    }, angle);
    await browser.close();
    console.log(JSON.stringify(m, null, 1));
    return;
  }

  console.log(JSON.stringify({ error: "unknown command: " + cmd, usage: "size|color|mask|textlines|trapezoid|diff|tilt-test" }));
}

run().catch((e) => { console.error(String(e)); process.exit(1); });
