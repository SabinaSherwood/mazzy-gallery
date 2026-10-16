#!/usr/bin/env node
// =====================================================================
// MAZZY AUDIO GUIDE BUILDER (macOS)
// Turns the text in index.html into recorded narration: audio/*.m4a
// plus audio/manifest.json, which the page uses to find each recording.
//
// Run it again any time you edit a placard, the essay, the hero text,
// the zine spreads or the shop, then upload the audio/ folder:
//
//   node tools/build-audio.mjs                 (only re-records what changed)
//   node tools/build-audio.mjs --force         (re-records everything)
//   node tools/build-audio.mjs --voice "Daniel" --rate 165
//
// Uses macOS's built-in `say` voice and `afconvert`, so it needs no
// accounts or API keys. Recordings play on every phone and browser.
// =====================================================================
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML_PATH = path.join(ROOT, 'index.html');
const OUT_DIR = path.join(ROOT, 'audio');

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const VOICE = argValue('--voice', 'Daniel');      // calm British "museum docent" voice that ships with macOS
const RATE = String(argValue('--rate', '165'));   // words per minute; macOS default is ~175
const FORCE = args.includes('--force');

const html = fs.readFileSync(HTML_PATH, 'utf8');

// ---------- read the page's text ----------
function extractArray(name) {
  const start = html.indexOf(`const ${name} = [`);
  if (start === -1) throw new Error(`Could not find "const ${name} = [" in index.html`);
  const end = html.indexOf('\n    ];', start);
  if (end === -1) throw new Error(`Could not find the end of ${name} in index.html`);
  const literal = html.slice(html.indexOf('[', start), end + '\n    ]'.length);
  return vm.runInNewContext(`(${literal})`);
}

function extractInner(regex, label) {
  const m = html.match(regex);
  if (!m) throw new Error(`Could not find ${label} in index.html`);
  return m[1];
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…' };
function htmlToText(fragment) {
  return fragment
    .replace(/<\/(p|blockquote|figcaption|h[1-6]|li)>/gi, '. ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/([.!?”"’])\s*\.(\s|$)/g, '$1$2')   // no doubled full stops after block ends
    .trim();
}

// ---------- make the text sound right when spoken ----------
function forSpeech(text) {
  return text
    .replace(/\s*\([^)]*\.(png|jpe?g|webp)\)/gi, '')          // "(image_4.png)" isn't for listeners
    .replace(/\bIMG_(\d+)/g, 'image $1')
    .replace(/\b(?:PLATES?\s+)?CIS-0?(\d+)\b/gi, 'Plate $1')     // "PLATE CIS-03" -> "Plate 3"
    .replace(/\+(\d+)°/g, 'plus $1 degrees')
    .replace(/(\d+(?:\.\d+)?)°C/g, '$1 degrees Celsius')
    .replace(/°/g, ' degrees')
    .replace(/(\d)\s*[×x]\s*(\d)/g, '$1 by $2')
    .replace(/\s*[•·]\s*/g, ', ')
    .replace(/\s+\/\s+/g, ', ')                                // "Nadir / Zenith" -> "Nadir, Zenith"
    .replace(/(\d)\s?mm\b/g, '$1 millimetre')
    .replace(/(\d)\s?cm\b/g, '$1 centimetres')
    .replace(/\s&\s/g, ' and ')
    .replace(/Dąbrowski/g, 'Dombrovski')
    .replace(/\b[A-Z][A-Z'’-]+\b/g, w => (/^[IVXLC]+$/.test(w) ? w : w[0] + w.slice(1).toLowerCase())) // ALL-CAPS read as words, Roman numerals kept
    .replace(/\s+/g, ' ')
    .trim();
}

const endSentence = t => (/[.!?…]["”’)]*$/.test(t.trim()) ? t.trim() : t.trim() + '.');

// ---------- build every narration ----------
const catalogueWorks = extractArray('catalogueWorks');
const zineSpreads = extractArray('zineSpreads');
const scripts = {};

scripts.hero = htmlToText(extractInner(/<p id="heroStatement"[^>]*>([\s\S]*?)<\/p>/, 'the hero statement'));

const essayTitle = htmlToText(extractInner(/<section id="curator-essay"[\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2>/, 'the essay title'));
scripts.essay = `${endSentence(essayTitle)} ${htmlToText(extractInner(/<div id="essayBody"[^>]*>([\s\S]*?)<\/div>/, 'the essay'))}`;

const shopSection = extractInner(/(<section id="gift-shop"[\s\S]*?<\/section>)/, 'the museum shop');
scripts.shop = [...shopSection.matchAll(/<(h2|h3|p)\b[^>]*>([\s\S]*?)<\/\1>/g)]
  .map(m => endSentence(htmlToText(m[2])))
  .join(' ');

zineSpreads.forEach((spread, i) => {
  scripts[`spread-${i + 1}`] = [spread.left, spread.right]
    .map(p => endSentence(p.type === 'image' ? p.caption : `${p.heading}. ${p.body}`))
    .join(' ');
});

catalogueWorks.forEach(w => {
  Object.entries(w.voices).forEach(([voice, placard]) => {
    scripts[`plate-${w.id.toLowerCase()}-${voice}`] = `${w.title}, ${w.year}. ${placard}`;
  });
});

// ---------- record ----------
if (args.includes('--dry')) {  // preview the spoken text without recording anything
  for (const [key, raw] of Object.entries(scripts)) console.log(`[${key}]\n${forSpeech(raw)}\n`);
  process.exit(0);
}
fs.mkdirSync(OUT_DIR, { recursive: true });
const manifestPath = path.join(OUT_DIR, 'manifest.json');
const previous = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')).files || {} : {};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mazzy-audio-'));
const files = {};
let recorded = 0;

for (const [key, raw] of Object.entries(scripts)) {
  const spoken = forSpeech(raw);
  const version = crypto.createHash('sha1').update(`${VOICE}|${RATE}|${spoken}`).digest('hex').slice(0, 10);
  const outFile = path.join(OUT_DIR, `${key}.m4a`);
  files[key] = version;
  if (!FORCE && previous[key] === version && fs.existsSync(outFile)) continue;

  const txt = path.join(tmp, `${key}.txt`);
  const aiff = path.join(tmp, `${key}.aiff`);
  fs.writeFileSync(txt, spoken);
  execFileSync('say', ['-v', VOICE, '-r', RATE, '-f', txt, '-o', aiff]);
  execFileSync('afconvert', [aiff, outFile, '-f', 'm4af', '-d', 'aac', '-b', '64000']);
  recorded++;
  console.log(`  ♪ ${key}`);
}

// Remove recordings that no longer belong to any text (e.g. a deleted plate)
for (const f of fs.readdirSync(OUT_DIR)) {
  if (f.endsWith('.m4a') && !(f.slice(0, -4) in files)) {
    fs.unlinkSync(path.join(OUT_DIR, f));
    console.log(`  ✕ removed old ${f}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });

fs.writeFileSync(manifestPath, JSON.stringify({ voice: VOICE, rate: Number(RATE), files }, null, 2) + '\n');
console.log(`\nAudio guide ready: ${Object.keys(files).length} narrations (${recorded} newly recorded) in audio/`);
