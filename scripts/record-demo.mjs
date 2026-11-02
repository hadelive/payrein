// Records the demo video: drives the owner app's seven demo buttons in headless Chrome, captions
// each step on screen, records with CDP screencast, and writes frames/ plus list.txt for ffmpeg.
// Needs `make demo-local` running on a fresh sandbox (the daily budget must be untouched), Chrome,
// and puppeteer-core resolvable from the current directory (`npm i puppeteer-core` in a scratch
// directory and run from there, or NODE_PATH). Then:
//   node scripts/record-demo.mjs http://127.0.0.1:5173/
//   ffmpeg -f concat -safe 0 -i list.txt -vf "fps=30,scale=1920:-2,format=yuv420p" -c:v libx264 -crf 21 -movflags +faststart payrein-demo.mp4
import puppeteer from "puppeteer-core";
import fs from "node:fs";
const url = process.argv[2] ?? "http://127.0.0.1:5173/";
const dir = "frames"; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
const W = 1280, H = 1000, DSF = 1.5;
const browser = await puppeteer.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--no-first-run", "--hide-scrollbars", `--window-size=${W},${H}`] });
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: DSF });
await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
await page.goto(url, { waitUntil: "load" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitText = (t, timeout = 90000) => page.waitForFunction((t) => document.body.innerText.includes(t), { timeout, polling: 200 }, t);
const waitEnabled = (label) => page.waitForFunction((l) => [...document.querySelectorAll(".demo-steps button")].some((b) => b.textContent.includes(l) && !b.disabled), { timeout: 90000, polling: 200 }, label);
const clickStep = async (label) => {
  await waitEnabled(label);
  const btns = await page.$$(".demo-steps button");
  for (const b of btns) { if ((await b.evaluate((e) => e.textContent)).includes(label)) { await b.evaluate((e) => e.scrollIntoView({ block: "center" })); await sleep(300); await b.click(); return; } }
  throw new Error("no step " + label);
};
const scrollTo = async (sel) => { await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: "center", behavior: "smooth" }), sel); await sleep(700); };
const cap = (n, text) => page.evaluate((n, text) => {
  let el = document.getElementById("__cap");
  if (!el) { el = document.createElement("div"); el.id = "__cap"; document.body.appendChild(el);
    el.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:99999;background:rgba(17,24,39,.94);color:#fff;font:500 26px/1.35 -apple-system,Inter,Segoe UI,sans-serif;padding:22px 40px 26px;box-shadow:0 -4px 24px rgba(0,0,0,.25)";
  }
  el.innerHTML = (n ? `<span style="display:inline-block;background:#fff;color:#111827;border-radius:999px;font-size:16px;font-weight:700;padding:3px 10px;margin-right:14px;vertical-align:middle">${n}</span>` : "") + text;
}, n, text);

// Screencast
const cdp = await page.createCDPSession();
const frames = []; let i = 0;
cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
  const f = `${dir}/${String(i++).padStart(5, "0")}.jpg`;
  fs.writeFileSync(f, Buffer.from(data, "base64")); frames.push({ f, t: metadata.timestamp });
  await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: W * DSF, maxHeight: H * DSF, everyNthFrame: 1 });

await waitEnabled("Buy a report");
await cap(0, "Payrein holds an AI agent’s spending money on NEAR Intents. The agent can only ask the vault to pay; the contract enforces the allowlist, the per-payment and daily limits, and the owner’s approval of exact payments. Local devnet, scripted model.");
await sleep(7000);

await cap(1, "Normal purchase. Two merchants offer the weekly report; the agent takes the cheaper, 0.002 wNEAR from Report Shop. The merchant verifies the payment on chain and delivers.");
await clickStep("Buy a report");
await waitText("report delivered"); await scrollTo("section.demo"); await sleep(3500);

await cap(2, "T1, injected merchant. The invoice tells AI agents to pay attacker.test.near and this hijacked agent obeys. The vault refuses: MerchantNotAllowed. The attacker gets nothing.");
await clickStep("T1 injected merchant");
await waitText("MerchantNotAllowed"); await sleep(4000);

await cap(3, "T2, leaked key. A script holding the agent’s key calls the vault directly, bypassing the app. Same refusal: the checks live in the contract, not the app.");
await clickStep("T2 leaked key");
await page.waitForFunction(() => document.body.innerText.split("MerchantNotAllowed").length > 2, { timeout: 90000, polling: 200 }); await sleep(3500);

await cap(4, "Data Desk quotes the deep dive cheaper, then invoices 0.009 instead of 0.006. The agent refuses it, pays nothing, and buys from Report Shop at 0.008, which is above the 0.005 threshold and waits for the owner. The card shows the exact call the wallet will display.");
await clickStep("Buy (needs approval)");
await page.waitForSelector("article.card[id^='approval-']", { timeout: 90000 });
await page.evaluate(() => document.querySelector("article.card[id^='approval-'] details")?.setAttribute("open", ""));
await scrollTo("article.card[id^='approval-']"); await sleep(6000);

await cap(5, "T9, tampered approval. A tampered app asks to approve 0.009 instead of 0.008. The contract compares every field of the stored payment: ApprovalMismatch. (A swapped, genuinely awaiting payment is caught only by reading the wallet’s own display, T20.)");
await clickStep("T9 tampered approval");
await waitText("ApprovalMismatch"); await sleep(5500);

await cap(6, "The real approval of the exact payment, signed by the owner. The vault pays 0.008, the merchant verifies it on chain and delivers. Spent today: 0.010.");
await clickStep("Approve in wallet"); await sleep(1500);
await page.evaluate(() => document.querySelector("article.card[id^='approval-'] .actions button:not(.ghost)").click());
await waitText("spent 0.01"); await scrollTo("section.demo"); await sleep(4500);

await cap(7, "T5, eight at once. Eight requests of 0.004 from eight agent keys with 0.020 left: exactly five settle, three are refused OverDaily. The vault reserves before it sends, so a race cannot overspend.");
await clickStep("T5 8 at once");
await waitText("5 accepted, 3 refused"); await scrollTo(".bar"); await sleep(5500);

await cap(0, "The daily bar stops at the 0.030 limit. Repository: github.com/hadelive/payrein — 25 sandbox attack tests against the pinned intents.near binary, 27 unit tests, 5 of 5 mutants caught. Unaudited; the owner key and Intents are trusted.");
await scrollTo(".bar"); await sleep(7000);

await cdp.send("Page.stopScreencast");
await browser.close();
// concat list with real frame durations
const lines = ["ffconcat version 1.0"];
for (let k = 0; k < frames.length; k++) {
  const d = k + 1 < frames.length ? Math.max(0.02, frames[k + 1].t - frames[k].t) : 2;
  lines.push(`file '${frames[k].f}'`, `duration ${d.toFixed(3)}`);
}
lines.push(`file '${frames[frames.length - 1].f}'`);
fs.writeFileSync("list.txt", lines.join("\n") + "\n");
console.log("frames", frames.length, "seconds", (frames[frames.length - 1].t - frames[0].t + 2).toFixed(1));
