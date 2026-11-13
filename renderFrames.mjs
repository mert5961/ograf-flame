#!/usr/bin/env node
/**
 * Renders an OGraf graphic to a transparent PNG image sequence by driving its
 * non-realtime API (setActionsSchedule + goToTime) in headless Chrome.
 *
 * No npm dependencies: it serves the package over localhost and speaks the
 * Chrome DevTools Protocol through Node's built-in WebSocket.
 *
 *   node renderFrames.mjs --input <pkg.ograf.zip | package dir | set.ogs> --out <dir> [options]
 *   node renderFrames.mjs --input <...> --describe        # print fields and defaults as JSON
 *
 * Options:
 *   --template <name>    template inside a .ogs set (default: the set's active template)
 *   --data <json|@file>  field values merged over the manifest defaults
 *   --fps <n>            default: manifest frame rate, else 25
 *   --width/--height     default: manifest resolution, else 1920x1080
 *   --hold <seconds>     time on screen between the end of Play and Stop (default 5)
 *   --no-stop            end on the held pose instead of playing the Stop animation
 *   --start-frame <n>    first frame number in file names (default 1001)
 *   --name <base>        file base name (default: graphic name)
 *   --chrome <path>      Chrome/Chromium executable
 *   --studio <dir>       OGraf Studio checkout, needed only for .ogs input
 *                        (default: $OGRAF_STUDIO_DIR, config.json "studioDir", ~/ograf-studio)
 *
 * Progress lines go to stderr as "PROGRESS <done> <total>"; the final result is one JSON line on stdout.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------- arguments ----------
const args = { hold: 5, startFrame: 1001, stop: true };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const key = argv[i];
  const next = () => {
    const value = argv[++i];
    if (value === undefined) fail(`${key} needs a value`);
    return value;
  };
  switch (key) {
    case '--input':
      args.input = resolve(next());
      break;
    case '--out':
      args.out = resolve(next());
      break;
    case '--template':
      args.template = next();
      break;
    case '--data':
      args.data = next();
      break;
    case '--fps':
      args.fps = Number(next());
      break;
    case '--width':
      args.width = Number(next());
      break;
    case '--height':
      args.height = Number(next());
      break;
    case '--hold':
      args.hold = Number(next());
      break;
    case '--studio':
      args.studio = resolve(next());
      break;
    case '--no-stop':
      args.stop = false;
      break;
    case '--start-frame':
      args.startFrame = Number(next());
      break;
    case '--name':
      args.name = next();
      break;
    case '--chrome':
      args.chrome = next();
      break;
    case '--describe':
      args.describe = true;
      break;
    default:
      fail(`Unknown option ${key}`);
  }
}
if (!args.input) fail('--input is required');
if (!args.describe && !args.out) fail('--out is required');

function fail(message) {
  process.stdout.write(JSON.stringify({ ok: false, error: message }) + '\n');
  process.exit(1);
}

const cleanups = [];
const cleanup = () => {
  while (cleanups.length) {
    try {
      cleanups.pop()();
    } catch {
      /* best effort */
    }
  }
};
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130));

// ---------- resolve the package folder ----------
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function findManifest(dir) {
  const hits = [];
  const walk = (d, depth) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (entry.endsWith('.ograf.json')) hits.push(p);
      else if (depth < 2 && statSync(p).isDirectory() && entry !== '__MACOSX') walk(p, depth + 1);
    }
  };
  walk(dir, 0);
  if (!hits.length) fail(`No .ograf.json manifest found in ${dir}`);
  return hits.sort((a, b) => a.length - b.length)[0];
}

function findStudio() {
  let configured;
  try {
    configured = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8')).studioDir;
  } catch {
    /* no config */
  }
  const candidates = [
    args.studio,
    process.env.OGRAF_STUDIO_DIR,
    configured,
    join(homedir(), 'ograf-studio'),
  ].filter(Boolean);
  const found = candidates.find((dir) =>
    existsSync(join(dir, 'packages/codegen/src/buildExportArtifacts.ts')),
  );
  if (!found)
    fail(
      'Opening .ogs files needs an OGraf Studio checkout (https://github.com/zerodensity/ograf-studio). ' +
        'Run ./install.sh --studio <dir>, or export an .ograf.zip from Studio with the Non-real-time or Dual profile instead.',
    );
  return found;
}

let packageDir;
let templates;
const lower = args.input.toLowerCase();
if (!existsSync(args.input)) fail(`Input not found: ${args.input}`);
if (statSync(args.input).isDirectory()) {
  packageDir = args.input;
} else if (lower.endsWith('.zip')) {
  packageDir = tempDir('ograf-pkg-');
  execFileSync('unzip', ['-q', '-o', args.input, '-d', packageDir]);
} else if (lower.endsWith('.ogs')) {
  packageDir = tempDir('ograf-ogs-');
  // Run tsx with this same Node binary: hosts such as Flame start us with a PATH
  // that has no `node`, so the `#!/usr/bin/env node` shim in node_modules/.bin fails.
  const studio = findStudio();
  const tsxCli = join(studio, 'node_modules/tsx/dist/cli.mjs');
  if (!existsSync(tsxCli)) fail(`Run "npm ci" in ${studio} first (tsx is missing).`);
  const exportArgs = [tsxCli, join(HERE, 'exportPackage.mts'), studio, args.input, packageDir];
  if (args.template) exportArgs.push(args.template);
  let output;
  try {
    output = execFileSync(process.execPath, exportArgs, {
      cwd: studio,
      env: {
        ...process.env,
        PATH: `${dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    fail(
      `Could not export the .ogs template: ${(
        String(error.stderr || error.message)
          .split('\n')
          .map((line) => line.trim())
          .find((line) => /^\w*Error:/.test(line)) ?? String(error.message)
      )
        .replace(/^\w*Error:\s*/, '')
        .slice(0, 400)}`,
    );
  }
  templates = JSON.parse(output.trim().split('\n').at(-1)).templates;
} else {
  fail('Input must be a .ograf.zip, an extracted package folder, or a .ogs template set.');
}

const manifestPath = findManifest(packageDir);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const root = dirname(manifestPath);
const req = manifest.renderRequirements?.[0] ?? {};
const pick = (constraint) => constraint?.exact ?? constraint?.ideal ?? constraint?.max;
const fps = args.fps || pick(req.frameRate) || 25;
const width = args.width || pick(req.resolution?.width) || 1920;
const height = args.height || pick(req.resolution?.height) || 1080;

const properties = manifest.schema?.properties ?? {};
const defaults = Object.fromEntries(
  Object.entries(properties)
    .filter(([, v]) => v && 'default' in v)
    .map(([k, v]) => [k, v.default]),
);

if (args.describe) {
  const fields = Object.entries(properties).map(([id, schema]) => ({
    id,
    label: schema.title || schema.gddOptions?.label || id,
    type: schema.type,
    gddType: schema.gddType,
    default: schema.default,
    enum: schema.enum,
  }));
  process.stdout.write(
    JSON.stringify({
      ok: true,
      name: manifest.name,
      width,
      height,
      fps,
      templates,
      fields,
      supportsNonRealTime: !!manifest.supportsNonRealTime,
    }) + '\n',
  );
  process.exit(0);
}

if (!manifest.supportsNonRealTime)
  fail(
    'This package only supports real-time playout. Export it from Studio with the Non-real-time or Dual profile.',
  );

let overrides = {};
if (args.data) {
  const text = args.data.startsWith('@') ? readFileSync(args.data.slice(1), 'utf8') : args.data;
  try {
    overrides = JSON.parse(text);
  } catch {
    fail('--data is not valid JSON');
  }
}
const data = { ...defaults, ...overrides };

// ---------- timing ----------
const durationOf = (type) => manifest.actionDurations?.find((a) => a.type === type);
const playMs = (() => {
  const play = durationOf('playAction');
  const stepTotal = (play?.steps ?? []).reduce((sum, s) => sum + (s.duration || 0), 0);
  return Math.max(play?.duration || 0, stepTotal);
})();
const stopMs = args.stop ? durationOf('stopAction')?.duration || 0 : 0;
const stopAt = playMs + args.hold * 1000;
const totalMs = stopAt + stopMs;
const frameCount = Math.max(1, Math.ceil((totalMs / 1000) * fps) + (args.stop ? 1 : 0));
const schedule = [
  { timestamp: 0, action: { type: 'updateAction', params: { data } } },
  { timestamp: 0, action: { type: 'playAction', params: {} } },
  ...(args.stop ? [{ timestamp: stopAt, action: { type: 'stopAction', params: {} } }] : []),
];

// ---------- static server ----------
const MIME = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.html': 'text/html',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
  '.wasm': 'application/wasm',
};
const HOST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:transparent;overflow:hidden;width:${width}px;height:${height}px}
#host{position:absolute;inset:0;width:${width}px;height:${height}px}
</style></head><body><div id="host"></div></body></html>`;

const server = createServer(async (request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://x').pathname);
  if (path === '/__host.html') {
    response.writeHead(200, { 'content-type': 'text/html' });
    return response.end(HOST_PAGE);
  }
  const file = normalize(join(root, path));
  if (!file.startsWith(root + sep) || !existsSync(file) || statSync(file).isDirectory()) {
    response.writeHead(404);
    return response.end();
  }
  response.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
  });
  response.end(await readFile(file));
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
cleanups.push(() => server.close());
const origin = `http://127.0.0.1:${server.address().port}`;

// ---------- headless Chrome ----------
const chromePath =
  args.chrome ||
  process.env.OGRAF_CHROME ||
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((p) => existsSync(p));
if (!chromePath) fail('Chrome not found. Pass --chrome <path> or set OGRAF_CHROME.');

const profileDir = tempDir('ograf-chrome-');
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--force-device-scale-factor=1',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    `--window-size=${width},${height}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);
cleanups.push(() => chrome.kill('SIGKILL'));

const portFile = join(profileDir, 'DevToolsActivePort');
for (let i = 0; i < 200 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 50));
if (!existsSync(portFile)) fail('Chrome did not start.');
const [port] = readFileSync(portFile, 'utf8').split('\n');
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const pageTarget = targets.find((t) => t.type === 'page');

const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
await new Promise((ok, ko) => {
  ws.onopen = ok;
  ws.onerror = ko;
});
let nextId = 0;
const pending = new Map();
const consoleErrors = [];
const loadWaiters = [];
ws.onmessage = ({ data: raw }) => {
  const message = JSON.parse(raw);
  if (message.id !== undefined) {
    const p = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) p.ko(new Error(`${p.method}: ${message.error.message}`));
    else p.ok(message.result);
  } else if (message.method === 'Page.loadEventFired') {
    loadWaiters.splice(0).forEach((f) => f());
  } else if (message.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(
      message.params.exceptionDetails?.exception?.description ??
        message.params.exceptionDetails?.text,
    );
  } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args.map((a) => a.value ?? a.description).join(' '));
  }
};
const send = (method, params = {}) =>
  new Promise((ok, ko) => {
    const id = ++nextId;
    pending.set(id, { ok, ko, method });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails)
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width,
  height,
  deviceScaleFactor: 1,
  mobile: false,
});
await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
const loaded = new Promise((ok) => loadWaiters.push(ok));
await send('Page.navigate', { url: `${origin}/__host.html` });
await loaded;

// ---------- mount and schedule the graphic ----------
const mainUrl = `${origin}/${manifest.main.replace(/^\.?\//, '')}`;
const callGraphic = (method, params) =>
  evaluate(`(async () => {
    const r = await window.__graphic.${method}(${JSON.stringify(params)});
    return r === undefined ? null : JSON.parse(JSON.stringify(r));
  })()`);

try {
  await evaluate(`(async () => {
    const mod = await import(${JSON.stringify(mainUrl)});
    const tag = 'ograf-graphic-render';
    if (!customElements.get(tag)) customElements.define(tag, mod.default);
    const el = document.createElement(tag);
    el.style.cssText = 'position:absolute;inset:0;width:${width}px;height:${height}px;display:block';
    document.getElementById('host').appendChild(el);
    window.__graphic = el;
    await document.fonts.ready;
  })()`);
  await callGraphic('load', { renderType: 'non-realtime', data });
  await callGraphic('setActionsSchedule', { schedule });
} catch (error) {
  fail(
    `Graphic failed to load: ${error.message}${consoleErrors.length ? ` | ${consoleErrors.join(' | ')}` : ''}`,
  );
}

// ---------- render ----------
const base =
  (args.name || manifest.name || 'ograf').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') ||
  'ograf';
await mkdir(args.out, { recursive: true });
const pad = Math.max(4, String(args.startFrame + frameCount - 1).length);
const files = [];
const started = Date.now();
for (let f = 0; f < frameCount; f++) {
  await callGraphic('goToTime', { timestamp: (f * 1000) / fps });
  // Two animation frames so the compositor has the requested pose.
  await evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width, height, scale: 1 },
    captureBeyondViewport: false,
  });
  const fileName = `${base}.${String(args.startFrame + f).padStart(pad, '0')}.png`;
  await writeFile(join(args.out, fileName), Buffer.from(shot.data, 'base64'));
  files.push(fileName);
  process.stderr.write(`PROGRESS ${f + 1} ${frameCount}\n`);
}

try {
  await callGraphic('dispose', {});
} catch {
  /* ignore */
}
ws.close();
process.stdout.write(
  JSON.stringify({
    ok: true,
    name: manifest.name,
    out: args.out,
    pattern: `${base}.[${String(args.startFrame).padStart(pad, '0')}-${String(args.startFrame + frameCount - 1).padStart(pad, '0')}].png`,
    first: join(args.out, files[0]),
    frames: frameCount,
    fps,
    width,
    height,
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    warnings: consoleErrors,
  }) + '\n',
);
process.exit(0);
