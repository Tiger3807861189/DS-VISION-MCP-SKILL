#!/usr/bin/env node
// Tilt calibration: compute a rotated panel's perspective projection for a
// range of rotateY angles and pick the one matching the ORIGINAL trapezoid
// (measured from pixels). Companion of ds-vision-buff.mjs "trapezoid".
//
//   node scripts/tune-tilt.mjs <replica.html> [--perspective 1600] [--origin-y 0.41]
//
// Scene-specific constants below (sign layout, original panel corners) are
// from the Bilbo-sign replica; update them for other scenes. The defaults
// mirror the replica's CSS (perspective 1600px, perspective-origin 50% 41%).
import { chromium } from "playwright";

const htmlPath = process.argv[2] || "D:/Claude/Claude Code for VSCode/bilbo-sign-replica.html";
const D = Number((process.argv.find(a => a.startsWith("--perspective=")) || "--perspective=1600").split("=")[1]);
const OYF = Number((process.argv.find(a => a.startsWith("--origin-y=")) || "--origin-y=0.41").split("=")[1]);
const OX = 1734 * 0.5;     // perspective-origin x (50%)
const OY = 868 * OYF;      // perspective-origin y

// Original panel corners (measured from pixels), stage coords:
// left edge x=0.35W, right edge x=0.65W
const T = (f) => [f[0] * 1734, f[1] * 868];
const orig = {
  tl: T([0.35, 0.2396]), tr: T([0.65, 0.2546]),
  bl: T([0.35, 0.8364]), br: T([0.65, 0.7972]),
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1734, height: 868 } });
// accept "D:/path", "D:\\path" or full "file:///D:/path"
const fileUrl = htmlPath.includes("://") ? htmlPath : "file:///" + htmlPath.replace(/\\/g, "/");
await page.goto(fileUrl);
await page.waitForTimeout(300);

const dom = await page.evaluate(() => {
  const q = (s) => { const el = document.querySelector(s); const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  return { sign: q(".sign"), panel: q(".sign-panel") };
});


// Sign transform parameters: rotateY(theta) about origin (50%, 88% of sign),
// plus translateX(-0.35%). NOTE: getBoundingClientRect returns the PROJECTED
// bbox, so use the un-transformed CSS layout position instead.
const signX = 1734 * 0.278, signY = 868 * 0.185;   // .sign left/top (un-transformed)
const signW = 1734 * 0.448, signH = 868 * 0.69;    // .sign size
const cx = signW * 0.5, cy = signH * 0.88;
const txShift = signW * -0.0035;
// Panel local rect inside .sign (un-transformed): padding 8.0% / 7.2% / 5.4%
const padL = signW * 0.08, padT = signW * 0.072, padB = signW * 0.054;
const panelLocal = {
  tl: [padL, padT],
  tr: [padL + (signW - 2 * padL), padT],
  bl: [padL, padT + (signH - padT - padB)],
  br: [padL + (signW - 2 * padL), padT + (signH - padT - padB)],
};
console.log("panel local (un-transformed):", JSON.stringify(panelLocal));

function project(thetaDeg) {
  const th = thetaDeg * Math.PI / 180;
  const ct = Math.cos(th), st = Math.sin(th);
  const out = {};
  for (const [k, [lx, ly]] of Object.entries(panelLocal)) {
    // translate to origin, rotateY, translate back + translateX
    let x = lx - cx, y = ly - cy;
    const x2 = x * ct + txShift;
    // EXPERIMENT-VERIFIED: CSS rotateY(+) puts the LEFT edge nearer the
    // camera. Left x<0 -> z>0 (near). So z' = -x·sin.
    const z2 = -x * st;
    // world coords: sign-local -> stage (add un-transformed sign position)
    const xw = x2 + cx + signX, yw = y + cy + signY, zw = z2;
    // perspective projection about (OX, OY)
    const s = D / (D - zw);
    out[k] = [OX + (xw - OX) * s, OY + (yw - OY) * s];
  }
  return out;
}

// Compare projected corners to the original (translate+scale fit, report residuals)
function fit(proj) {
  // simple alignment: match center of tl/tr/bl/br, then compute deltas
  const cO = { x: (orig.tl[0] + orig.br[0]) / 2, y: (orig.tl[1] + orig.br[1]) / 2 };
  const cP = { x: (proj.tl[0] + proj.br[0]) / 2, y: (proj.tl[1] + proj.br[1]) / 2 };
  const dx = cO.x - cP.x, dy = cO.y - cP.y;
  const p = {};
  for (const k of Object.keys(proj)) p[k] = [proj[k][0] + dx, proj[k][1] + dy];
  let err = 0;
  for (const k of Object.keys(orig)) err += Math.hypot(p[k][0] - orig[k][0], p[k][1] - orig[k][1]);
  // trapezoid metrics
  const topL = p.tl[1], topR = p.tr[1], botL = p.bl[1], botR = p.br[1];
  const hL = botL - topL, hR = botR - topR;
  return { err: +err.toFixed(1), dx: +dx.toFixed(1), dy: +dy.toFixed(1),
           topSlope: +((topR - topL) / (p.tr[0] - p.tl[0])).toFixed(4),
           botSlope: +((botR - botL) / (p.br[0] - p.bl[0])).toFixed(4),
           ratio: +(hL / hR).toFixed(3) };
}

const results = [];
for (let deg = 3; deg <= 16; deg += 0.5) {
  const proj = project(deg);
  const f = fit(proj);
  results.push({ deg, ...f });
}
results.sort((a, b) => a.err - b.err);
console.log("BEST 6:");
for (const r of results.slice(0, 6)) console.log(JSON.stringify(r));
console.log("ORIGINAL target: topSlope=" + (0.015 * 868 / (0.30 * 1734)).toFixed(4) +
            " botSlope=" + (-0.039 * 868 / (0.30 * 1734)).toFixed(4) + " ratio=1.10");
await browser.close();
