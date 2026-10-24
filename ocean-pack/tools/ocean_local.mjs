#!/usr/bin/env node
// Private Windows runtime for an existing ocean engine. No Docker, tests, public listener or model calls.
// Secrets are kept in <runtime>/private; this file never prints their values.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile, fork, spawn } from 'node:child_process';
import { promisify, parseEnv } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runFile = promisify(execFile);
const SELF = fs.realpathSync(fileURLToPath(import.meta.url));
const MIN_NODE = [24, 22, 1];
const ROLES = { api: 'apps/api/src/main.ts', worker: 'apps/worker/src/main.ts', web: 'apps/web/server.ts' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = name => fs.existsSync(name);
const readJson = name => JSON.parse(fs.readFileSync(name, 'utf8'));
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const nonce = () => randomBytes(32).toString('hex');
const alive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
let redact = value => String(value).replace(/(postgres(?:ql)?:\/\/)[^\s/@]+(?::[^\s/@]+)?@/gi, '$1[redacted]@');
const out = value => console.log(JSON.stringify(value, null, 2));

function argsOf(args) {
  const result = { command: args.shift() ?? 'help' };
  while (args.length) {
    const key = args.shift();
    if (!/^--[a-z][a-z-]*$/.test(key)) throw new Error(`Unknown argument ${key}`);
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    if (key.slice(2) in result) throw new Error(`Repeated argument ${key}`);
    result[key.slice(2)] = value;
  }
  return result;
}

function checkNode() {
  const version = process.versions.node.split('.').map(Number);
  for (let i = 0; i < MIN_NODE.length; i++) {
    if (version[i] > MIN_NODE[i]) return;
    if (version[i] < MIN_NODE[i]) throw new Error('Use Node >=24.22.1; the bundled Codex node.exe is suitable.');
  }
}

function absolute(value, label) {
  if (!value || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return path.resolve(value);
}

function within(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

async function writeJson(name, data) {
  const temp = `${name}.${process.pid}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await fsp.rename(temp, name);
}

async function hidden(exe, args, options = {}) {
  return runFile(exe, args, { windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options });
}

async function protectDirectory(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') return fsp.chmod(dir, 0o700);
  const { stdout } = await hidden('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value']);
  const sid = stdout.trim();
  if (!/^S-1-\d+(?:-\d+)+$/.test(sid)) throw new Error('Could not determine Windows user SID for private runtime permissions');
  await hidden('icacls.exe', [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F']);
}

function layout(runtime) {
  return {
    runtime, private: path.join(runtime, 'private'), config: path.join(runtime, 'private', 'runtime.json'),
    secrets: path.join(runtime, 'private', 'secrets.json'), state: path.join(runtime, 'state.json'),
    pgdata: path.join(runtime, 'pgdata'), data: path.join(runtime, 'content-data'),
    logs: path.join(runtime, 'logs'), lock: path.join(runtime, 'start.lock'),
    pgPassword: path.join(runtime, 'private', 'pg-password.txt'),
  };
}

function rootEnv(config) {
  const file = path.join(config.root, '.env');
  return exists(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {};
}

function setupRedaction(env, secrets) {
  const hiddenValues = [...Object.entries(env).filter(([key]) => /(?:PASSWORD|SECRET|TOKEN|API_KEY|DATABASE_URL)/i.test(key)).map(([, value]) => value), ...Object.values(secrets)]
    .filter(value => typeof value === 'string' && value.length >= 8).sort((a, b) => b.length - a.length);
  redact = value => {
    let text = String(value);
    for (const secret of hiddenValues) text = text.split(secret).join('[redacted]');
    return text.replace(/(postgres(?:ql)?:\/\/)[^\s/@]+(?::[^\s/@]+)?@/gi, '$1[redacted]@');
  };
}

function backendEnv(config, secrets) {
  const original = rootEnv(config);
  const env = { ...process.env, ...original };
  // Parent shells may have testing configuration loaded. Always replace these local-only settings.
  for (const key of Object.keys(env)) if (key.startsWith('DEV_AUTH_')) delete env[key];
  Object.assign(env, {
    NODE_ENV: 'production', AIHOT_ENVIRONMENT: 'production',
    DATABASE_URL: `postgres://ocean_local:${encodeURIComponent(secrets.pgPassword)}@127.0.0.1:${config.pgPort}/ocean_local`,
    AIHOT_DATA_DIR: layout(config.runtime).data, AIHOT_CREDENTIALS_DIR: '',
    API_HOST: '127.0.0.1', API_PORT: String(config.apiPort), API_BASE_URL: `http://127.0.0.1:${config.apiPort}`,
    WEB_HOST: '127.0.0.1', WEB_PORT: String(config.webPort), SITE_URL: `http://127.0.0.1:${config.webPort}`,
    TRUST_PROXY: 'false', ALLOW_PRIVATE_NETWORK_FETCH: 'false',
    SESSION_SECRET: original.SESSION_SECRET || secrets.sessionSecret,
    IMG_PROXY_SIGN_SECRET: original.IMG_PROXY_SIGN_SECRET || secrets.imageSecret,
    ADMIN_PASSWORD: original.ADMIN_PASSWORD?.length >= 12 ? original.ADMIN_PASSWORD : secrets.adminPassword,
    STEPX_TOKEN: original.STEPX_TOKEN || secrets.stepxToken,
    ADMIN_SYNC_TOKEN: original.ADMIN_SYNC_TOKEN || secrets.adminSyncToken,
    // Initial local setup is read-only with respect to external sources and paid providers.
    COLLECT_ENABLED: 'false', MODEL_CALLS_ENABLED: 'false',
    FEISHU_CONTENT_PUSH_ENABLED: 'false', FEISHU_INTERNAL_ENABLED: 'false',
    INDEXNOW_SUBMIT_ENABLED: 'false', STEPX_INCLUDE_BODY: 'false',
    STEPX_WEBHOOK_URL: '', STEPX_WEBHOOK_SECRET: '',
  });
  // Future optional flags also stay closed. Production startup must never inherit a dev bypass.
  for (const key of Object.keys(env)) if (key.endsWith('_ENABLED')) env[key] = 'false';
  for (const key of Object.keys(env)) if (key.startsWith('DB_BACKUP_STORE_')) delete env[key];
  delete env.NODE_OPTIONS;
  env.PATH = `${config.pgBin}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`;
  return env;
}

function webEnv(config, env) {
  const permitted = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'COMSPEC', 'PATHEXT'];
  return {
    ...Object.fromEntries(permitted.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
    NODE_ENV: 'production', API_BASE_URL: env.API_BASE_URL, SITE_URL: env.SITE_URL,
    WEB_HOST: '127.0.0.1', WEB_PORT: String(config.webPort), TRUST_PROXY: 'false',
    ADMIN_SYNC_TOKEN: env.ADMIN_SYNC_TOKEN,
  };
}

function loadRuntime(runtime) {
  const files = layout(runtime);
  if (!exists(files.config) || !exists(files.secrets)) throw new Error('No runtime configured here; run start with --root and --pg-bin first.');
  const config = readJson(files.config);
  if (config.version !== 1 || !same(config.runtime, runtime)) throw new Error('Runtime identity does not match this directory');
  const secrets = readJson(files.secrets);
  if (!secrets.controlToken || !secrets.pgPassword || !config.clusterId) throw new Error('Private runtime configuration is incomplete');
  setupRedaction(rootEnv(config), secrets);
  return { config, secrets, files };
}

async function prepare(options) {
  const runtime = absolute(options.runtime, '--runtime');
  if (/(?:^|[\\/])db-lab(?:[\\/]|$)/i.test(runtime)) throw new Error('Production runtime must be separate from work/db-lab.');
  const files = layout(runtime);
  await fsp.mkdir(runtime, { recursive: true });
  if (!exists(files.config)) {
    const unexpected = fs.readdirSync(runtime).filter(name => !['start.lock', 'private'].includes(name));
    if (unexpected.length) throw new Error('First startup needs an empty dedicated runtime directory; no existing data was changed.');
  }
  await protectDirectory(files.private);
  if (exists(files.config)) {
    const loaded = loadRuntime(runtime);
    for (const [option, field] of [['root', 'root'], ['pg-bin', 'pgBin']]) {
      if (options[option] && !same(absolute(options[option], `--${option}`), loaded.config[field])) throw new Error(`Existing runtime has a different ${option}`);
    }
    return loaded;
  }
  if (exists(files.secrets) || exists(files.pgdata)) throw new Error('Unrecognized existing runtime data; refusing to adopt or overwrite it.');
  const root = fs.realpathSync(absolute(options.root, '--root'));
  const pgBin = fs.realpathSync(absolute(options['pg-bin'], '--pg-bin'));
  if (within(root, runtime) || within(runtime, root) || within(pgBin, runtime) || within(runtime, pgBin)) throw new Error('Keep runtime separate from engine and PostgreSQL binary directories.');
  for (const name of ['package.json', ...Object.values(ROLES), 'scripts/migrate.ts', 'scripts/seed.ts', 'apps/web/build/server/index.js', 'node_modules/postgres/src/index.js']) {
    if (!exists(path.join(root, name))) throw new Error(`Engine prerequisite missing: ${name}`);
  }
  for (const name of ['postgres', 'pg_ctl', 'initdb']) if (!exists(path.join(pgBin, `${name}${process.platform === 'win32' ? '.exe' : ''}`))) throw new Error(`PostgreSQL binary missing: ${name}`);
  const { stdout } = await hidden(path.join(pgBin, `postgres${process.platform === 'win32' ? '.exe' : ''}`), ['--version']);
  if (!/PostgreSQL\) 17\./.test(stdout)) throw new Error('This local runtime requires PostgreSQL 17 binaries.');
  const port = (key, fallback) => {
    const n = Number(options[key] ?? fallback);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error(`Invalid --${key}`);
    return n;
  };
  const config = { version: 1, root, runtime, pgBin, clusterId: nonce(), pgPort: port('pg-port', 55433), apiPort: port('api-port', 3131), webPort: port('web-port', 3130), node: process.execPath, tool: SELF };
  if (new Set([config.pgPort, config.apiPort, config.webPort]).size !== 3) throw new Error('PostgreSQL, API and web ports must be different.');
  // This is a new dedicated directory, so protect the cluster files as well as the private secrets.
  await protectDirectory(runtime);
  const secrets = { pgPassword: nonce(), controlToken: nonce(), sessionSecret: nonce(), imageSecret: nonce(), adminPassword: nonce(), stepxToken: nonce(), adminSyncToken: nonce() };
  await writeJson(files.secrets, secrets);
  await fsp.writeFile(files.pgPassword, secrets.pgPassword + '\n', { mode: 0o600 });
  await writeJson(files.config, config);
  setupRedaction(rootEnv(config), secrets);
  return { config, secrets, files };
}

async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`Port 127.0.0.1:${port} is occupied; no existing process was stopped.`)));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(resolve));
  });
}

function pgExe(config, name) { return path.join(config.pgBin, `${name}${process.platform === 'win32' ? '.exe' : ''}`); }
async function pgCommand(config, name, args, extra = {}) {
  if (name === 'pg_ctl' && args.includes('start')) {
    // On Windows the server can inherit execFile's pipes after pg_ctl exits. Wait for the launcher
    // with ignored stdio; PostgreSQL writes to the explicit -l file instead of keeping us pending.
    return new Promise((resolve, reject) => {
      const launcher = spawn(pgExe(config, name), args, {
        cwd: config.runtime, env: { ...process.env, PATH: `${config.pgBin}${path.delimiter}${process.env.PATH ?? ''}` },
        windowsHide: true, stdio: 'ignore',
      });
      launcher.once('error', reject);
      launcher.once('exit', code => code === 0 ? resolve({ stdout: '', stderr: '' }) : reject(new Error('PostgreSQL startup failed; see logs/postgres.log.')));
    });
  }
  return hidden(pgExe(config, name), args, { cwd: config.runtime, env: { ...process.env, PATH: `${config.pgBin}${path.delimiter}${process.env.PATH ?? ''}` }, ...extra });
}

function clusterMarker(config) {
  const file = path.join(layout(config.runtime).pgdata, 'ocean-local-owner.json');
  if (!exists(file)) throw new Error('PostgreSQL data directory has no ocean-local ownership marker; refusing to use it.');
  const marker = readJson(file);
  if (marker.clusterId !== config.clusterId || !same(marker.runtime, config.runtime)) throw new Error('PostgreSQL cluster ownership marker does not match.');
}

async function pgIdentity(config) {
  const files = layout(config.runtime);
  if (!exists(files.pgdata)) return null;
  clusterMarker(config);
  const pidFile = path.join(files.pgdata, 'postmaster.pid');
  if (!exists(pidFile)) return null;
  const lines = fs.readFileSync(pidFile, 'utf8').split(/\r?\n/);
  const pid = Number(lines[0]);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid PostgreSQL postmaster.pid');
  if (!alive(pid)) throw new Error('PostgreSQL has a stale postmaster.pid; inspect the cluster before restarting.');
  if (!same(lines[1], files.pgdata) || Number(lines[3]) !== config.pgPort || lines[5]?.trim() !== '127.0.0.1') throw new Error('Running PostgreSQL directory, port or listener does not match this runtime.');
  if (process.platform === 'win32') {
    const { stdout } = await hidden('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p) { [pscustomobject]@{ pid=$p.ProcessId; exe=$p.ExecutablePath; command=$p.CommandLine; created=([DateTimeOffset]$p.CreationDate).ToUnixTimeSeconds() } | ConvertTo-Json -Compress }`]);
    const processInfo = JSON.parse(stdout || 'null');
    if (!processInfo?.exe || !same(processInfo.exe, pgExe(config, 'postgres'))) throw new Error('PostgreSQL PID executable does not match the configured binary.');
    const command = (processInfo.command?.match(/"[^"\r\n]*"|[^\s]+/g) ?? []).map(part => part.replace(/^"|"$/g, ''));
    const dataOption = command.indexOf('-D');
    if (dataOption < 0 || !command[dataOption + 1] || !same(command[dataOption + 1], files.pgdata)) throw new Error('PostgreSQL PID command does not name this data directory.');
    if (Math.abs(processInfo.created - Number(lines[2])) > 3) throw new Error('PostgreSQL PID creation time does not match postmaster.pid; possible stale or reused PID.');
  }
  await pgCommand(config, 'pg_ctl', ['-D', files.pgdata, 'status']);
  return { pid, start: lines[2] };
}

async function stopPg(config, expected) {
  const current = await pgIdentity(config);
  if (!current) return;
  if (!expected || current.pid !== expected.pid || current.start !== expected.start) throw new Error('PostgreSQL instance changed; refusing to stop it.');
  await pgCommand(config, 'pg_ctl', ['-D', layout(config.runtime).pgdata, '-w', '-t', '60', '-m', 'fast', 'stop']);
}

async function ensurePg(config, secrets) {
  const files = layout(config.runtime);
  if (!exists(files.pgdata)) {
    await pgCommand(config, 'initdb', ['-D', files.pgdata, '-U', 'ocean_local', '--pwfile', files.pgPassword, '--auth=scram-sha-256', '--locale=C', '--encoding=UTF8']);
    await writeJson(path.join(files.pgdata, 'ocean-local-owner.json'), { clusterId: config.clusterId, runtime: config.runtime });
  }
  clusterMarker(config);
  const before = await pgIdentity(config);
  if (!before) {
    await assertPortFree(config.pgPort);
    await pgCommand(config, 'pg_ctl', ['-D', files.pgdata, '-l', path.join(files.logs, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${config.pgPort}`, '-w', '-t', '60', 'start']);
  }
  const identity = await pgIdentity(config);
  const { default: postgres } = await import(pathToFileURL(path.join(config.root, 'node_modules/postgres/src/index.js')).href);
  const db = postgres({ host: '127.0.0.1', port: config.pgPort, username: 'ocean_local', password: secrets.pgPassword, database: 'postgres', max: 1, connect_timeout: 10 });
  try {
    const [info] = await db`SELECT current_setting('data_directory') AS data, current_user AS who, current_setting('listen_addresses') AS listen`;
    if (!same(info.data, files.pgdata) || info.who !== 'ocean_local' || info.listen !== '127.0.0.1') throw new Error('Database identity does not match this runtime.');
    if (!(await db`SELECT 1 FROM pg_database WHERE datname='ocean_local'`).length) await db`CREATE DATABASE ocean_local`;
  } catch (error) {
    await db.end();
    if (!before) await stopPg(config, identity);
    throw error;
  } finally { await db.end(); }
  return { ...identity, startedHere: !before };
}

function safeStatus(config, state, env) {
  return {
    runtime: config.runtime, status: state.status, supervisorPid: state.pid, processes: state.children ?? {},
    postgres: state.postgres ? { pid: state.postgres.pid, port: config.pgPort, database: 'ocean_local' } : null,
    webUrl: `http://127.0.0.1:${config.webPort}`, apiUrl: `http://127.0.0.1:${config.apiPort}`,
    collectEnabled: false, modelCallsEnabled: false, pushEnabled: false,
    modelKeyConfigured: Object.entries(env).some(([key, value]) => /(?:LLM|ZHIPU|DEEPSEEK|DASHSCOPE|XIAOMI_MIMO)_API_KEY$/.test(key) && Boolean(value)),
    backupMode: 'stopped-cluster cold copy', error: state.error ?? null,
  };
}

function appendLog(file, stream) {
  let partial = '';
  stream.setEncoding('utf8');
  stream.on('data', text => {
    partial += text;
    let end;
    while ((end = partial.indexOf('\n')) >= 0) {
      fs.appendFileSync(file, redact(partial.slice(0, end + 1)));
      partial = partial.slice(end + 1);
    }
    // Bound an unexpected enormous single log line while retaining a secret-length tail.
    if (partial.length > 1024 * 1024) { fs.appendFileSync(file, '[oversize log line omitted]\n'); partial = ''; }
  });
  stream.on('end', () => { if (partial) fs.appendFileSync(file, redact(partial) + '\n'); });
}

async function control(loaded, action) {
  const { config, secrets, files } = loaded;
  if (!exists(files.state)) return null;
  const state = readJson(files.state);
  if (state.status === 'stopped' || state.status === 'database_only') return null;
  if (!state.pid || !alive(state.pid) || !state.controlPort) return null;
  const response = await fetch(`http://127.0.0.1:${state.controlPort}/${action}`, {
    method: action === 'status' ? 'GET' : 'POST', redirect: 'error',
    headers: { authorization: `Bearer ${secrets.controlToken}` }, signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Runtime supervisor identity check failed; refusing to control any PID.');
  const body = await response.json();
  if (body.instance !== state.instance || body.pid !== state.pid) throw new Error('Runtime supervisor identity changed; refusing to control any PID.');
  return body;
}

async function stopRuntime(loaded) {
  const { config, files } = loaded;
  const reply = await control(loaded, 'stop');
  if (reply) {
    // A worker may be finishing a paid call or backup from a previous configuration.
    for (let i = 0; i < 110; i++) {
      const state = readJson(files.state);
      if (state.instance === reply.instance && state.status === 'stopped') return safeStatus(config, state, backendEnv(config, loaded.secrets));
      if (state.instance !== reply.instance) throw new Error('Runtime changed while stopping; no further action taken.');
      if (!alive(reply.pid)) throw new Error('Supervisor exited before confirming a clean stop; inspect logs.');
      await delay(5000);
    }
    throw new Error('Graceful stop has not completed; no process was forcibly killed.');
  }
  const state = exists(files.state) ? readJson(files.state) : null;
  const pg = await pgIdentity(config);
  // Recovery after a supervisor crash only stops the exact recorded cluster, never an arbitrary PID.
  if (pg) {
    if (!state?.postgres || pg.pid !== state.postgres.pid || pg.start !== state.postgres.start) throw new Error('Unsupervised PostgreSQL does not match the recorded instance; inspect before stopping.');
    if (Object.values(state.children ?? {}).some(pid => alive(pid))) throw new Error('An unsupervised child is still alive; it was not forcibly stopped.');
    await stopPg(config, pg);
  }
  const stopped = { ...(state ?? {}), status: 'stopped', pid: null, children: {}, postgres: null, stoppedAt: new Date().toISOString() };
  await writeJson(files.state, stopped);
  return safeStatus(config, stopped, backendEnv(config, loaded.secrets));
}

async function supervise(runtime) {
  const loaded = loadRuntime(runtime);
  const { config, secrets, files } = loaded;
  const env = backendEnv(config, secrets);
  await fsp.mkdir(files.logs, { recursive: true });
  await fsp.mkdir(files.data, { recursive: true });
  const state = { pid: process.pid, instance: nonce(), status: 'starting', startedAt: new Date().toISOString(), children: {}, postgres: null, controlPort: null };
  const children = new Map();
  let stopping = null;
  let starting = true;
  let stopRequested = false;
  let finishedStartup = false;
  let pgStarted = false;
  let persistence = Promise.resolve();
  const persist = () => {
    const snapshot = structuredClone(state);
    const write = persistence.then(() => writeJson(files.state, snapshot));
    persistence = write.catch(() => {});
    return write;
  };
  const log = text => fs.appendFileSync(path.join(files.logs, 'supervisor.log'), `${new Date().toISOString()} ${redact(text)}\n`);
  const requestStop = () => {
    stopRequested = true;
    // Never interrupt initdb/pg_ctl between starting PostgreSQL and recording its identity.
    // Startup observes cancellation at its next safe boundary and then uses the same shutdown path.
    return starting ? Promise.resolve() : (stopping ??= shutdown());
  };
  const checkpoint = () => { if (stopRequested) throw new Error('Startup was cancelled; cleaning up owned processes.'); };
  process.on('SIGINT', () => { void requestStop(); });
  process.on('SIGTERM', () => { void requestStop(); });
  const controlServer = http.createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${secrets.controlToken}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(401); return res.end(); }
    if (!['/status', '/stop'].includes(req.url) || (req.url === '/stop' && req.method !== 'POST')) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ instance: state.instance, pid: process.pid, ...safeStatus(config, state, env) }));
    if (req.url === '/stop') setImmediate(() => { void requestStop(); });
  });
  const stopChild = async (role, child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => {
        if (settled) return; settled = true; clearTimeout(limit); child.off('exit', onExit);
        error ? reject(error) : resolve();
      };
      const onExit = () => finish();
      const limit = setTimeout(() => finish(new Error(`${role} did not finish graceful shutdown; no forced kill was sent.`)), 490_000);
      child.once('exit', onExit);
      if (!child.connected) return finish(new Error(`${role} IPC disconnected; cannot safely stop it.`));
      child.send({ action: 'shutdown', instance: state.instance }, error => {
        if (!error) return;
        if (child.exitCode !== null || child.signalCode !== null) finish();
        else finish(new Error(`${role} shutdown IPC failed; no process was forcibly stopped.`));
      });
    });
  };
  async function shutdown() {
    state.status = 'stopping'; await persist(); log('Graceful shutdown requested');
    try {
      for (const role of ['worker', 'web', 'api', 'setup']) {
        const child = children.get(role);
        if (child) await stopChild(role, child);
      }
      // On failed startup only unwind the PostgreSQL instance started by this invocation.
      const retainPg = state.postgres && !finishedStartup && !pgStarted;
      if (state.postgres && !retainPg) await stopPg(config, state.postgres);
      state.status = retainPg ? 'database_only' : 'stopped'; state.children = {};
      if (!retainPg) state.postgres = null;
      state.stoppedAt = new Date().toISOString(); await persist();
      log('All owned processes stopped');
      controlServer.close(() => process.exit(0));
    } catch (error) {
      state.status = 'stop_failed'; state.error = redact(error.message); await persist(); log(state.error);
      // Retain the supervisor and database, so status and a later stop remain possible.
      stopping = null;
    }
  }
  function launch(role, entry, childEnv) {
    const child = fork(SELF, ['__child', '--runtime', runtime, '--role', role, '--instance', state.instance, '--entry', entry], {
      cwd: config.root, execPath: process.execPath, execArgv: [], env: childEnv, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.set(role, child); state.children[role] = child.pid;
    appendLog(path.join(files.logs, `${role}.log`), child.stdout); appendLog(path.join(files.logs, `${role}.log`), child.stderr);
    child.on('error', error => {
      log(`${role} process error: ${error.message}`);
      if (role !== 'setup' && !stopping) void requestStop();
    });
    child.once('exit', (code, signal) => {
      delete state.children[role];
      if (role !== 'setup' && !stopping) { log(`${role} exited unexpectedly (${code ?? signal})`); void requestStop(); }
    });
    return child;
  }
  async function setup(entry) {
    const child = launch('setup', entry, env);
    const completed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Setup ${entry} failed; see logs/setup.log`)));
    });
    await persist();
    await completed;
    children.delete('setup');
  }
  async function imported(child, role) {
    if (child.exitCode !== null) throw new Error(`${role} exited before startup`);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`${role} startup timed out; see logs/${role}.log`)), 90_000);
      const finish = fn => value => { clearTimeout(timeout); child.off('exit', onExit); child.off('message', onMessage); fn(value); };
      const onExit = finish(() => reject(new Error(`${role} exited during startup; see logs/${role}.log`)));
      const onMessage = message => { if (message?.type === 'imported' && message.role === role) finish(resolve)(); };
      child.once('exit', onExit); child.on('message', onMessage);
    });
  }
  async function healthy(url) {
    for (let i = 0; i < 60; i++) {
      checkpoint();
      try {
        const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
        await response.body?.cancel();
        if (response.status === 200) return;
      } catch {}
      await delay(500);
    }
    throw new Error(`Local health check did not pass: ${url}`);
  }
  try {
    await new Promise((resolve, reject) => { controlServer.once('error', reject); controlServer.listen(0, '127.0.0.1', resolve); });
    state.controlPort = controlServer.address().port; await persist();
    await assertPortFree(config.apiPort); await assertPortFree(config.webPort); checkpoint();
    state.postgres = await ensurePg(config, secrets); pgStarted = state.postgres.startedHere; await persist(); checkpoint();
    await setup('scripts/migrate.ts'); checkpoint(); await setup('scripts/seed.ts'); checkpoint();
    const api = launch('api', ROLES.api, env); await imported(api, 'api'); await persist(); checkpoint();
    await healthy(`http://127.0.0.1:${config.apiPort}/api/health`);
    const worker = launch('worker', ROLES.worker, env); await imported(worker, 'worker'); await persist(); checkpoint();
    const web = launch('web', ROLES.web, webEnv(config, env)); await imported(web, 'web'); await persist(); checkpoint();
    await healthy(`http://127.0.0.1:${config.webPort}/api/health`);
    await healthy(`http://127.0.0.1:${config.webPort}/`);
    checkpoint(); starting = false; finishedStartup = true; state.status = 'running'; await persist(); log('Local runtime is healthy; collection/models/push remain disabled');
    if (!stopRequested && process.connected) process.send({ type: 'ready', instance: state.instance, pid: process.pid });
  } catch (error) {
    starting = false;
    state.error = redact(error.message); log(state.error); if (process.connected) process.send({ type: 'failed', error: state.error });
    await requestStop();
  }
}

async function childMain(options) {
  if (!ROLES[options.role] && options.role !== 'setup') throw new Error('Unknown internal child role');
  const runtime = absolute(options.runtime, '--runtime');
  // The web wrapper must not read secrets.json or the engine .env. Its parent supplies a whitelist.
  const config = readJson(layout(runtime).config);
  if (config.version !== 1 || !same(config.runtime, runtime)) throw new Error('Child runtime identity mismatch');
  const allowed = options.role === 'setup' ? ['scripts/migrate.ts', 'scripts/seed.ts'] : [ROLES[options.role]];
  if (!allowed.includes(options.entry)) throw new Error('Internal child entry is not allowed');
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (process.listenerCount('SIGTERM')) process.emit('SIGTERM');
    else process.exit(1);
  };
  process.on('message', message => { if (message?.action === 'shutdown' && message.instance === options.instance) shutdown(); });
  process.on('disconnect', shutdown);
  const imported = await import(pathToFileURL(path.join(config.root, options.entry)).href);
  if (options.entry === 'scripts/migrate.ts') {
    // migrate.ts only invokes itself for import.meta.main; this IPC wrapper must call its export.
    const { sql, closeDb } = await import(pathToFileURL(path.join(config.root, 'packages/backend/src/db.ts')).href);
    try { await imported.runMigrations(sql, config.root, { backupWaitMs: 470_000 }); }
    finally { await closeDb(); }
  }
  process.send?.({ type: 'imported', role: options.role });
  if (options.role === 'setup') { process.disconnect?.(); process.exit(0); }
}

async function start(options) {
  const runtime = absolute(options.runtime, '--runtime');
  const files = layout(runtime);
  await fsp.mkdir(runtime, { recursive: true });
  let lock;
  try { lock = await fsp.open(files.lock, 'wx', 0o600); await lock.writeFile(String(process.pid)); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Another start or backup holds start.lock. Inspect it before retrying.'); throw error; }
  try {
    const loaded = await prepare(options);
    const { config, secrets } = loaded;
    const status = await control(loaded, 'status');
    if (status) { out(status); return; }
    if (exists(files.state)) {
      const old = readJson(files.state);
      if (old.pid && alive(old.pid)) throw new Error('A recorded supervisor PID is alive but cannot be authenticated; refusing a second start.');
      if (Object.values(old.children ?? {}).some(pid => alive(pid))) throw new Error('Recorded child processes are still alive; inspect runtime before restarting.');
    }
    const manager = fork(SELF, ['__supervise', '--runtime', config.runtime], {
      cwd: config.root, execPath: process.execPath, execArgv: [], detached: true, windowsHide: true,
      // Initial connection reports a clean startup; after ready the manager lives independently.
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: webEnv(config, backendEnv(config, secrets)),
    });
    try { await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Startup is still pending; inspect status and logs before another start.')), 240_000);
      manager.once('error', error => { clearTimeout(timeout); reject(error); });
      manager.once('exit', code => { clearTimeout(timeout); reject(new Error(`Supervisor exited during startup (${code}); inspect logs/supervisor.log`)); });
      manager.on('message', message => {
        if (message?.type === 'ready') { clearTimeout(timeout); resolve(); }
        if (message?.type === 'failed') { clearTimeout(timeout); reject(new Error(message.error)); }
      });
    }); } finally { if (manager.connected) manager.disconnect(); manager.unref(); }
    out((await control(loaded, 'status')) ?? { status: 'unknown', runtime: config.runtime });
  } finally { await lock.close(); await fsp.unlink(files.lock).catch(() => {}); }
}

async function backup(loaded) {
  const { config, files } = loaded;
  const lock = await fsp.open(files.lock, 'wx', 0o600).catch(() => { throw new Error('Another start or backup is running.'); });
  const destination = path.join(config.runtime, 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
  try {
    const stopped = await stopRuntime(loaded);
    if (stopped.status !== 'stopped' || await pgIdentity(config)) throw new Error('A cold backup requires a confirmed stopped PostgreSQL cluster.');
    if (!exists(path.join(files.pgdata, 'PG_VERSION'))) throw new Error('No initialized PostgreSQL cluster exists to back up.');
    await protectDirectory(destination);
    for (const [source, name] of [[files.pgdata, 'pgdata'], [files.data, 'content-data'], [files.private, 'private']]) {
      if (exists(source)) await fsp.cp(source, path.join(destination, name), { recursive: true, errorOnExist: true, force: false, dereference: false });
    }
    await writeJson(path.join(destination, 'BACKUP.json'), { version: 1, at: new Date().toISOString(), source: config.runtime, database: 'ocean_local', postgresMajor: 17, cleanlyStopped: true, containsSecrets: true, note: 'Stopped-cluster cold copy. Restore only with PostgreSQL 17 and matching private configuration; keep it private.' });
    out({ status: 'backed_up', destination, containsSecrets: true, runtimeRemainsStopped: true, health: stopped });
  } finally { await lock.close(); await fsp.unlink(files.lock).catch(() => {}); }
}

async function main() {
  checkNode();
  const options = argsOf(process.argv.slice(2));
  if (options.command === 'help') return out({
    usage: 'node ocean_local.mjs start --root ABS_ENGINE --runtime ABS_RUNTIME --pg-bin ABS_POSTGRES17_BIN',
    commands: ['start', 'status --runtime ABS_RUNTIME', 'stop --runtime ABS_RUNTIME', 'backup --runtime ABS_RUNTIME'],
    defaults: { postgres: 55433, api: 3131, web: 3130 },
    note: 'Windows hidden processes; separate ocean_local database; model calls/collection/push disabled; no original .env edits. Backup stops this runtime and keeps it stopped.',
  });
  if (options.command === '__child') return childMain(options);
  if (options.command === '__supervise') return supervise(absolute(options.runtime, '--runtime'));
  if (!['start', 'status', 'stop', 'backup'].includes(options.command)) throw new Error('Unknown command; use help');
  const accepted = new Set(options.command === 'start' ? ['command', 'root', 'runtime', 'pg-bin', 'pg-port', 'api-port', 'web-port'] : ['command', 'runtime']);
  for (const key of Object.keys(options)) if (!accepted.has(key)) throw new Error(`Unknown option --${key}`);
  if (options.command === 'start') return start(options);
  const loaded = loadRuntime(absolute(options.runtime, '--runtime'));
  if (options.command === 'stop') return out(await stopRuntime(loaded));
  if (options.command === 'backup') return backup(loaded);
  const status = await control(loaded, 'status');
  if (status) return out(status);
  const state = exists(loaded.files.state) ? readJson(loaded.files.state) : { status: 'not_started' };
  const pg = await pgIdentity(loaded.config);
  return out(safeStatus(loaded.config, { ...state, status: pg ? 'unsupervised_database' : (state.status === 'running' ? 'not_running' : state.status), postgres: pg }, backendEnv(loaded.config, loaded.secrets)));
}

main().catch(error => {
  console.error(redact(error?.message ?? error));
  // An internal wrapper has an IPC listener; an import failure must not leave it alive indefinitely.
  if (process.argv[2] === '__child' || process.argv[2] === '__supervise') process.exit(1);
  process.exitCode = 1;
});
