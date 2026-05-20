// Local UniGeek / Puteros File Manager simulator.
// Mirrors the device API implemented in
//   firmware/src/utils/network/WebFileManager.cpp
// so the interface/ web UI can be developed without flashing a device.
//
// Routes (mounted under /puteros to match interface IS_DEV behaviour):
//   POST /puteros/                 multipart form, "command" param (ls, sysinfo,
//                                  sudo, exit, rm, mv, mkdir, touch, cat,
//                                  echo, pw, saveCrack)
//   GET  /puteros/download?file=…  stream a sandbox file
//   POST /puteros/upload           multipart upload (file + folder fields)
//   GET  /puteros/crack.wasm       serve local crack.wasm if present, else 404
// Plus, served at the root (matching device):
//   GET  /theme.css                returns ":root{--color:#RRGGBB;}"
// Everything else is served as a static file from the interface folder.

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT        = 8080;
const PASSWORD    = process.env.PUTEROS_PASSWORD || 'admin';
const THEME_COLOR = process.env.PUTEROS_THEME    || '#a67f00';
const SANDBOX_DIR = path.join(__dirname, process.env.PUTEROS_SANDBOX || 'sandbox');
const FAKE_TOTAL  = Number(process.env.PUTEROS_FAKE_TOTAL || (2 * 1024 * 1024));

const folderArg = process.argv[2] || 'interface';
if (folderArg === 'puteros') {
  console.error("Error: 'puteros' folder is not allowed as the main folder.");
  process.exit(1);
}
const mainFolderPath = path.join(__dirname, folderArg);
if (!fs.existsSync(mainFolderPath) || !fs.statSync(mainFolderPath).isDirectory()) {
  console.error(`Error: Folder '${folderArg}' does not exist.`);
  process.exit(1);
}

// Ensure sandbox exists and seed the password-list / cracked-password dirs the
// device exposes via the "pw" / "saveCrack" commands.
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
ensureDir(SANDBOX_DIR);
ensureDir(path.join(SANDBOX_DIR, 'unigeek/utility/passwords'));
ensureDir(path.join(SANDBOX_DIR, 'unigeek/wifi/passwords'));

// ── sandbox path helper ─────────────────────────────────────────────────────
// Reject anything that escapes SANDBOX_DIR via "..".
function resolveSandbox(p) {
  const clean = path.posix.normalize('/' + String(p || '/').replace(/^\/+/, ''));
  const abs   = path.join(SANDBOX_DIR, clean);
  const rel   = path.relative(SANDBOX_DIR, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

// ── sessions (Set-Cookie session=<hex>) ─────────────────────────────────────
const sessions = new Set();
function makeToken() { return crypto.randomBytes(16).toString('hex'); }
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const seg of header.split(';')) {
    const i = seg.indexOf('=');
    if (i < 0) continue;
    out[seg.slice(0, i).trim()] = seg.slice(i + 1).trim();
  }
  return out;
}
function getSession(req) {
  const c = parseCookies(req.headers.cookie);
  return c.session && sessions.has(c.session) ? c.session : null;
}

// ── tiny multipart/form-data parser ─────────────────────────────────────────
// Returns { fields: { name: stringValue }, files: [{ name, filename, contentType, data:Buffer }] }
function parseMultipart(buffer, boundary) {
  const fields = {};
  const files  = [];
  const delim = Buffer.from('--' + boundary);
  const crlf  = Buffer.from('\r\n');

  // Find each part between boundary delimiters
  let pos = buffer.indexOf(delim);
  if (pos < 0) return { fields, files };
  pos += delim.length;
  while (pos < buffer.length) {
    // End marker?  "--" after boundary == closing boundary.
    if (buffer[pos] === 0x2d && buffer[pos + 1] === 0x2d) break;
    // Skip the CRLF that follows the boundary line.
    if (buffer[pos] === 0x0d && buffer[pos + 1] === 0x0a) pos += 2;

    // Headers terminate at \r\n\r\n
    const headerEnd = buffer.indexOf('\r\n\r\n', pos);
    if (headerEnd < 0) break;
    const headerStr = buffer.slice(pos, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;

    const nextBoundary = buffer.indexOf(delim, bodyStart);
    if (nextBoundary < 0) break;
    // Body excludes the trailing \r\n that precedes the next boundary marker.
    const bodyEnd = nextBoundary - 2;
    const body = buffer.slice(bodyStart, bodyEnd);

    // Parse Content-Disposition and Content-Type from headers.
    let name = '', filename = null, contentType = null;
    for (const line of headerStr.split('\r\n')) {
      const lower = line.toLowerCase();
      if (lower.startsWith('content-disposition:')) {
        const mName = line.match(/name="([^"]*)"/i);
        if (mName) name = mName[1];
        const mFile = line.match(/filename="([^"]*)"/i);
        if (mFile) filename = mFile[1];
      } else if (lower.startsWith('content-type:')) {
        contentType = line.slice(line.indexOf(':') + 1).trim();
      }
    }

    if (filename !== null) {
      files.push({ name, filename, contentType, data: body });
    } else {
      fields[name] = body.toString('utf8');
    }
    pos = nextBoundary + delim.length;
  }
  return { fields, files };
}

function readBody(req, maxBytes = 256 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) { req.destroy(); reject(new Error('payload too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function getBoundary(req) {
  const ct = req.headers['content-type'] || '';
  const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!m) return null;
  return (m[1] || m[2]).trim();
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, headers));
  res.end(body);
}

// ── command handlers ────────────────────────────────────────────────────────
function cmdLs(fields) {
  let p = fields.path || '/';
  if (!p) p = '/';
  const abs = resolveSandbox(p);
  if (!abs) return { status: 403, body: 'Not a directory.' };
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    return { status: 403, body: 'Not a directory.' };
  }
  let resp = '';
  for (const name of fs.readdirSync(abs)) {
    const full = path.join(abs, name);
    let st;
    try { st = fs.statSync(full); } catch (_) { continue; }
    resp += (st.isDirectory() ? 'DIR:' : 'FILE:') + name + ':' + (st.isDirectory() ? 0 : st.size) + '\n';
  }
  return { status: 200, body: resp };
}

function dirSize(p) {
  let total = 0;
  try {
    for (const name of fs.readdirSync(p)) {
      const full = path.join(p, name);
      const st = fs.statSync(full);
      total += st.isDirectory() ? dirSize(full) : st.size;
    }
  } catch (_) {}
  return total;
}

function cmdSysinfo() {
  const used  = dirSize(SANDBOX_DIR);
  const total = Math.max(FAKE_TOTAL, used);
  const free  = total - used;
  let resp = 'UniGeek File Manager (simulator)\n';
  resp += 'FS:' + free  + '\n';
  resp += 'US:' + used  + '\n';
  resp += 'TS:' + total + '\n';
  return { status: 200, body: resp };
}

function cmdSudo(fields) {
  const pw = fields.param || '';
  if (pw !== PASSWORD) return { status: 403, body: 'forbidden' };
  const token = makeToken();
  sessions.add(token);
  return {
    status: 200,
    body: 'Login successful',
    headers: { 'Set-Cookie': `session=${token}; HttpOnly; Max-Age=86400; Path=/` },
  };
}

function cmdExit(req) {
  const c = parseCookies(req.headers.cookie);
  if (c.session) sessions.delete(c.session);
  return {
    status: 200,
    body: 'Logged out',
    headers: { 'Set-Cookie': 'session=; HttpOnly; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/' },
  };
}

function rmRecursive(p) { fs.rmSync(p, { recursive: true, force: true }); }

function cmdRm(fields) {
  const p = fields.path || '';
  if (!p) return { status: 400, body: 'No file specified.' };
  const abs = resolveSandbox(p);
  if (!abs || !fs.existsSync(abs)) return { status: 404, body: 'File not found.' };
  const isDir = fs.statSync(abs).isDirectory();
  try {
    if (isDir) rmRecursive(abs);
    else fs.unlinkSync(abs);
    return { status: 200, body: isDir ? 'Directory deleted.' : 'File deleted.' };
  } catch (_) {
    return { status: 500, body: 'Failed to delete.' };
  }
}

function cmdMv(fields) {
  const src = fields.src || '', dst = fields.dst || '';
  if (!src || !dst) return { status: 400, body: 'Source or destination not specified.' };
  const a = resolveSandbox(src), b = resolveSandbox(dst);
  if (!a || !b || !fs.existsSync(a)) return { status: 404, body: 'Source not found.' };
  try {
    ensureDir(path.dirname(b));
    fs.renameSync(a, b);
    return { status: 200, body: 'Moved.' };
  } catch (_) {
    return { status: 500, body: 'Failed to move.' };
  }
}

function cmdMkdir(fields) {
  const p = fields.path || '';
  if (!p) return { status: 400, body: 'No directory specified.' };
  const abs = resolveSandbox(p);
  if (!abs) return { status: 500, body: 'Failed to create directory.' };
  try { ensureDir(abs); return { status: 200, body: 'Directory created.' }; }
  catch (_) { return { status: 500, body: 'Failed to create directory.' }; }
}

function cmdTouch(fields) {
  const p = fields.path || '';
  if (!p) return { status: 400, body: 'No file specified.' };
  const abs = resolveSandbox(p);
  if (!abs) return { status: 500, body: 'Failed to create file.' };
  try {
    ensureDir(path.dirname(abs));
    fs.closeSync(fs.openSync(abs, 'w'));
    return { status: 200, body: 'File created.' };
  } catch (_) {
    return { status: 500, body: 'Failed to create file.' };
  }
}

function cmdCat(fields) {
  const p = fields.path || '';
  if (!p) return { status: 400, body: 'No file specified.' };
  const abs = resolveSandbox(p);
  if (!abs || !fs.existsSync(abs)) return { status: 404, body: 'File not found.' };
  try { return { status: 200, body: fs.readFileSync(abs) }; }
  catch (_) { return { status: 500, body: 'Failed to read file.' }; }
}

function cmdEcho(fields) {
  const p = fields.path || '';
  const content = fields.content == null ? '' : fields.content;
  if (!p) return { status: 400, body: 'No file specified.' };
  const abs = resolveSandbox(p);
  if (!abs) return { status: 500, body: 'Failed to open file.' };
  try {
    ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, content);
    return { status: 200, body: 'Content written.' };
  } catch (_) {
    return { status: 500, body: 'Failed to open file.' };
  }
}

function cmdPw(fields) {
  const param = fields.param || '';
  const pwDir = path.join(SANDBOX_DIR, 'unigeek/utility/passwords');
  if (param === 'list') {
    let resp = '';
    if (fs.existsSync(pwDir)) {
      for (const name of fs.readdirSync(pwDir)) {
        const full = path.join(pwDir, name);
        const st = fs.statSync(full);
        if (st.isFile()) resp += name + ':' + st.size + '\n';
      }
    }
    return { status: 200, body: resp };
  }
  if (param === 'get') {
    const name = fields.name || '';
    if (!name) return { status: 400, body: 'No name specified.' };
    const abs = path.join(pwDir, name);
    if (path.relative(pwDir, abs).startsWith('..') || !fs.existsSync(abs)) {
      return { status: 404, body: 'Not found.' };
    }
    return { status: 200, body: fs.readFileSync(abs) };
  }
  return { status: 400, body: 'param must be list or get' };
}

// The device validates the password against the .pcap handshake before
// writing.  For the simulator we just trust the client (the interface only
// hits this after a successful local crack anyway) and persist the password
// using the same naming convention.
function cmdSaveCrack(fields) {
  const pcap = fields.pcap || '', pw = fields.pw || '';
  if (!pcap || !pw) return { status: 400, body: 'pcap and pw required.' };
  const base = path.basename(pcap, path.extname(pcap));   // e.g. "AA:BB_MyAP"
  const safe = base.replace(/[^A-Za-z0-9_.-]/g, '_');
  const outDir = path.join(SANDBOX_DIR, 'unigeek/wifi/passwords');
  ensureDir(outDir);
  try {
    fs.writeFileSync(path.join(outDir, safe + '.pass'), pw);
    return { status: 200, body: 'saved' };
  } catch (_) {
    return { status: 500, body: 'write failed' };
  }
}

// ── handlers ────────────────────────────────────────────────────────────────
async function handleCommandPost(req, res) {
  const boundary = getBoundary(req);
  if (!boundary) return send(res, 400, 'expected multipart/form-data');
  let body;
  try { body = await readBody(req); } catch (e) { return send(res, 413, e.message); }
  const { fields } = parseMultipart(body, boundary);
  const command = fields.command;
  if (!command) return send(res, 404, '404');

  if (command !== 'sudo' && !getSession(req)) {
    return send(res, 401, 'not authenticated.');
  }

  let r;
  switch (command) {
    case 'ls':        r = cmdLs(fields);       break;
    case 'sysinfo':   r = cmdSysinfo();         break;
    case 'sudo':      r = cmdSudo(fields);     break;
    case 'exit':      r = cmdExit(req);         break;
    case 'rm':        r = cmdRm(fields);       break;
    case 'mv':        r = cmdMv(fields);       break;
    case 'mkdir':     r = cmdMkdir(fields);    break;
    case 'touch':     r = cmdTouch(fields);    break;
    case 'cat':       r = cmdCat(fields);      break;
    case 'echo':      r = cmdEcho(fields);     break;
    case 'pw':        r = cmdPw(fields);       break;
    case 'saveCrack': r = cmdSaveCrack(fields);break;
    default:          r = { status: 404, body: 'command not found' };
  }
  send(res, r.status, r.body, r.headers || {});
}

function handleDownload(req, res, urlObj) {
  if (!getSession(req)) return send(res, 401, 'not authenticated.');
  const file = urlObj.searchParams.get('file');
  if (!file) return send(res, 400, 'No file specified.');
  const abs = resolveSandbox(file);
  if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return send(res, 404, 'File not found.');
  }
  const name = path.basename(abs);
  res.writeHead(200, {
    'Content-Type': mimeFor(name),
    'Content-Length': fs.statSync(abs).size,
    'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
  });
  fs.createReadStream(abs).pipe(res);
}

async function handleUpload(req, res) {
  if (!getSession(req)) return send(res, 401, 'not authenticated.');
  const boundary = getBoundary(req);
  if (!boundary) return send(res, 400, 'expected multipart/form-data');
  let body;
  try { body = await readBody(req); } catch (e) { return send(res, 413, e.message); }
  const { fields, files } = parseMultipart(body, boundary);
  const file = files.find((f) => f.name === 'file');
  if (!file) return send(res, 400, 'no file field');
  let folder = fields.folder || '/';
  if (!folder.startsWith('/')) folder = '/' + folder;
  if (!folder.endsWith('/'))   folder += '/';

  // Filenames from the browser may include the relative path when uploading a
  // directory (webkitdirectory).  Preserve that hierarchy.
  const target = resolveSandbox(folder + file.filename);
  if (!target) return send(res, 400, 'bad path');
  ensureDir(path.dirname(target));
  try {
    fs.writeFileSync(target, file.data);
    send(res, 200, 'ok.');
  } catch (e) {
    send(res, 500, 'write failed: ' + e.message);
  }
}

function handleCrackWasm(req, res) {
  // Optional: drop a real crack.wasm next to server.js to test the SIMD path.
  // Otherwise return 404 so the interface falls back to its pure-JS cracker.
  const local = path.join(__dirname, 'crack.wasm');
  if (fs.existsSync(local) && fs.statSync(local).isFile()) {
    res.writeHead(200, {
      'Content-Type': 'application/wasm',
      'Content-Length': fs.statSync(local).size,
    });
    fs.createReadStream(local).pipe(res);
    return;
  }
  send(res, 404, 'crack.wasm not bundled in simulator');
}

function handleThemeCss(res) {
  res.writeHead(200, { 'Content-Type': 'text/css' });
  res.end(`:root{--color:${THEME_COLOR};}`);
}

// ── static UI ───────────────────────────────────────────────────────────────
function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.htm':  'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.wasm': 'application/wasm',
    '.pcap': 'application/vnd.tcpdump.pcap',
    '.txt':  'text/plain; charset=utf-8',
  }[ext] || 'application/octet-stream';
}

function serveStatic(req, res, urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const bases = [mainFolderPath, __dirname];
  for (const base of bases) {
    let p = path.join(base, decoded);
    if (p.endsWith(path.sep)) p += 'index.html';
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      res.writeHead(200, { 'Content-Type': mimeFor(p) });
      fs.createReadStream(p).pipe(res);
      return;
    }
  }
  send(res, 404, '404 Not Found');
}

// ── router ──────────────────────────────────────────────────────────────────
//
// The real device serves the API at the root (POST /, POST /upload,
// GET /download, GET /crack.wasm, GET /theme.css).  The interface's IS_DEV
// shim re-prefixes those with /puteros when the page is loaded from
// 127.0.0.1:8080 — so we accept BOTH the root paths (matching the device
// exactly) and the /puteros/* aliases (matching IS_DEV).  Any other host
// (localhost, LAN IP) falls back to root and still works.
http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  let pathname = urlObj.pathname;
  console.log(`[req] ${req.method} ${req.url}`);

  // Normalize /puteros[/...] → /...  so both surfaces hit the same handlers.
  if (pathname === '/puteros' || pathname.startsWith('/puteros/')) {
    pathname = pathname.slice('/puteros'.length) || '/';
  }

  // API routes (match device).
  if (req.method === 'GET'  && pathname === '/theme.css')  return handleThemeCss(res);
  if (req.method === 'POST' && pathname === '/')           return handleCommandPost(req, res);
  if (req.method === 'POST' && pathname === '/upload')     return handleUpload(req, res);
  if (req.method === 'GET'  && pathname === '/download')   return handleDownload(req, res, urlObj);
  if (req.method === 'GET'  && pathname === '/crack.wasm') return handleCrackWasm(req, res);

  // Anything else: serve from the interface folder.
  if (req.method !== 'GET') return send(res, 405, 'method not allowed');
  serveStatic(req, res, pathname);
}).listen(PORT, () => {
  console.log(`Simulator listening on http://127.0.0.1:${PORT}/`);
  console.log(`UI folder:    ${mainFolderPath}`);
  console.log(`Sandbox root: ${SANDBOX_DIR}`);
  console.log(`Password:     ${PASSWORD}  (override with PUTEROS_PASSWORD env)`);
});
