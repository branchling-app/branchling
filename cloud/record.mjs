#!/usr/bin/env node
// Branchling recorder for Claude Code cloud sessions (claude.ai/code), where plugins do not load.
// Lives in the repository as .claude/branchling/record.mjs, run by the hooks in .claude/settings.json:
//   PostToolUse (Bash)  node .claude/branchling/record.mjs bash   tests, builds, commits and merges become entries
//   Stop                node .claude/branchling/record.mjs push   seals this session's entries, pushes them
// A cloud session may only push to its own repository, so the sealed entries go to this repository's `branchling`
// branch; the person's working branches are never touched and the commit says [skip ci]. On their computer the
// Branchling plugin later copies the sealed files, unopened, into their private `branchling-almanac` repository.
// The entries are sealed with the public key in .claude/branchling/key.json: only the person's own iPhone and Mac
// can open them. On a computer the plugin does the recording, so this stays quiet unless CLAUDE_CODE_REMOTE is true.
// Plain Node, no packages. Sealed format: see plugin/hooks/seal.ts ("BLA1": X25519 + HKDF-SHA256 + ChaCha20-Poly1305).

import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MODE = process.argv[2] ?? ''
if (process.env.CLAUDE_CODE_REMOTE !== 'true' && process.env.BRANCHLING_RECORD !== '1') process.exit(0)

const TEST_S = /^(vitest|jest|mocha|pytest|python3? -m pytest|(npm|yarn|pnpm|bun)( run)? test\b|swift test|go test|cargo test|xcodebuild\b.*\btest\b|playwright test)/
const BUILD_S = /^((npm|yarn|pnpm|bun) run build\b|(yarn|pnpm) build\b|vite build|tsc\b|xcodebuild\b|swift build|cargo build|go build|\.\/gradlew\b|gradle\b|make\b)/
const GIT_ON = String.raw`^git\b(?:\s+(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?))*\s+`
const COMMIT_S = new RegExp(GIT_ON + String.raw`commit\b(?!.*--dry-run)`)
const MERGE_S = new RegExp(GIT_ON + String.raw`merge\s+(?!--(abort|continue|quit|skip))(?:-\S+\s+)*([^\s-]\S*)`)
const PASS_MARK = /Executed \d+ tests?, with 0 failures|Test Suite '.+' passed|Build complete!|\*\* (TEST|BUILD) SUCCEEDED \*\*|\btest result: ok\b|^ok\s+\S+|\bTests?:\s+\d+ passed(?!, \d+ failed)|^=+ \d+ passed\b/m
const FAIL_MARK = /\b[1-9]\d* (failed|failing)\b|\bFAIL\b|error TS\d+|\*\* (BUILD|TEST) FAILED \*\*|BUILD FAILED|npm ERR!|\berror: /
const TASK_TAG = /\[([ta]\d{1,4})\]/
const INFO = Buffer.from('branchling almanac v1')

const git = (root, args, opts = {}) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 60_000, ...opts })
const pad = n => String(n).padStart(2, '0')
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const slug = s => s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 40)
const clip = (s, n = 140) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
  } catch {
    return {}
  }
}

const input = readStdin()
const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()
const top = git(cwd, ['rev-parse', '--show-toplevel'])
if (top.status !== 0) process.exit(0)
const root = top.stdout.trim()

let setup = {}
try {
  setup = JSON.parse(fs.readFileSync(path.join(root, '.claude/branchling/key.json'), 'utf8'))
} catch {
  process.exit(0)
}
if (!/^[A-Za-z0-9+/]{43}=$/.test(String(setup.key ?? ''))) process.exit(0)
const project = slug(String(setup.project || path.basename(root))) || 'project'
const session = String(input.session_id || 'session').replace(/[^\w-]/g, '').slice(0, 12) || 'session'

// This session's entries, kept in the container while it lives: <day>.cloud-<session>.jsonl per day.
const store = path.join(os.homedir(), '.branchling-cloud', project, 'entries')
fs.mkdirSync(store, { recursive: true })
const fileOf = day => path.join(store, `${day}.cloud-${session}.jsonl`)

function mine() {
  const out = []
  for (const f of fs.readdirSync(store)) {
    if (!f.endsWith(`.cloud-${session}.jsonl`)) continue
    for (const line of fs.readFileSync(path.join(store, f), 'utf8').split('\n')) {
      try {
        if (line.trim()) out.push(JSON.parse(line))
      } catch {
        // a torn line: skip it
      }
    }
  }
  return out
}

function add(e) {
  const entry = {
    id: Date.now().toString(36) + crypto.randomBytes(3).toString('hex').slice(0, 4),
    project,
    date: today(),
    time: new Date().toISOString(),
    quote: null,
    ...e,
    text: clip(e.text),
  }
  if (!entry.task) delete entry.task
  fs.appendFileSync(fileOf(entry.date), JSON.stringify(entry) + '\n')
}

const branch = () => git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim() || 'main'

function segments(command) {
  return command
    .split(/\s*(?:&&|\|\||;|\n)\s*/)
    .map(s => s.replace(/^\s*(?:env\s+)?(?:\w+=\S+\s+)*/, '').trim())
    .filter(Boolean)
}

function failureLine(output) {
  const line = output.split('\n').find(l => FAIL_MARK.test(l)) ?? output.trim().split('\n').pop() ?? ''
  return clip(line.trim(), 100)
}

function recordBash() {
  if (input.tool_name !== 'Bash') return
  const command = String(input.tool_input?.command ?? '').replace(/^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*(&&|;)\s*/, '')
  const r = input.tool_response ?? {}
  const output = [r.stdout, r.stderr, typeof r === 'string' ? r : ''].filter(Boolean).join('\n')
  const exitCode = r.exitCode ?? r.exit_code ?? r.returnCode
  const errored = r.is_error === true || r.interrupted === true || (typeof exitCode === 'number' && exitCode !== 0)
  const segs = segments(command)
  const tag = segs.some(s => TEST_S.test(s)) ? 'test' : segs.some(s => BUILD_S.test(s)) ? 'build' : ''
  const es = mine()
  if (tag) {
    const toolLast = (tag === 'test' ? TEST_S : BUILD_S).test(segs[segs.length - 1] ?? '')
    const failed = FAIL_MARK.test(output) || (errored && (toolLast || !PASS_MARK.test(output)))
    const b = branch()
    const solved = new Set(es.map(x => x.quote).filter(Boolean))
    const open = es.filter(x => x.kind === 'problem' && x.tag === tag && x.branch === b && !solved.has(x.id))
    if (failed && !open.length) add({ branch: b, kind: 'problem', text: `${tag === 'test' ? 'Tests' : 'Build'} broke: ${failureLine(output)}`, source: 'auto', tag })
    else if (!failed && open.length) add({ branch: b, kind: 'solution', text: `${tag === 'test' ? 'Tests pass' : 'Build passes'} again`, quote: open[open.length - 1].id, source: 'auto', tag })
  }
  if (segs.some(s => COMMIT_S.test(s))) {
    const known = new Set(es.map(x => x.tag))
    const since = Math.floor(Date.now() / 1000) - 600
    const g = git(root, ['log', '-n', '20', '--no-merges', '--format=%h%x09%ct%x09%s'])
    if (g.status === 0) {
      const b = branch()
      for (const l of g.stdout.trim().split('\n').reverse()) {
        const [hash, ct, ...rest] = l.split('\t')
        if (!hash || Number(ct) < since || known.has('commit:' + hash)) continue
        const subject = rest.join('\t')
        add({ branch: b, kind: 'progress', text: subject, source: 'commit', tag: 'commit:' + hash, task: TASK_TAG.exec(subject)?.[1] })
      }
    }
  }
  const merge = segs.map(s => MERGE_S.exec(s)?.[2]).find(Boolean)
  if (merge && !errored && !/Already up to date|CONFLICT|Automatic merge failed/i.test(output)) {
    const b = branch()
    add({ branch: b, kind: 'progress', text: `${merge} merged back into ${b}`, source: 'merge', tag: 'merge', meta: { from: merge } })
  }
}

function seal(recipient, plain) {
  const eph = crypto.generateKeyPairSync('x25519')
  const ephPub = Buffer.from(eph.publicKey.export({ format: 'jwk' }).x, 'base64url')
  const to = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: recipient.toString('base64url') }, format: 'jwk' })
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: to })
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([ephPub, recipient]), INFO, 32))
  const nonce = crypto.randomBytes(12)
  const c = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 })
  return Buffer.concat([Buffer.from('BLA1'), ephPub, nonce, c.update(plain), c.final(), c.getAuthTag()])
}

function push() {
  const files = fs.readdirSync(store).filter(f => f.endsWith(`.cloud-${session}.jsonl`))
  if (!files.length) return
  const sentFile = path.join(store, `.sent-${session}.json`)
  let sent = {}
  try {
    sent = JSON.parse(fs.readFileSync(sentFile, 'utf8'))
  } catch {
    // first push of this session
  }
  const changed = files.filter(f => sent[f] !== String(fs.statSync(path.join(store, f)).size))
  if (!changed.length) return
  const recipient = Buffer.from(setup.key, 'base64')
  const env = {
    ...process.env,
    GIT_INDEX_FILE: path.join(os.tmpdir(), `branchling-index-${session}`),
    GIT_AUTHOR_NAME: 'Branchling',
    GIT_AUTHOR_EMAIL: 'almanac@branchling.invalid',
    GIT_COMMITTER_NAME: 'Branchling',
    GIT_COMMITTER_EMAIL: 'almanac@branchling.invalid',
  }
  const blobs = changed.map(f => ({
    f,
    path: `projects/${project}/entries/${f}`,
    body: seal(recipient, fs.readFileSync(path.join(store, f))).toString('base64') + '\n',
  }))
  const LOCAL = 'refs/branchling/almanac'
  for (let attempt = 0; attempt < 3; attempt++) {
    const fetched = git(root, ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/branchling:${LOCAL}`])
    const missing = fetched.status !== 0 && /couldn't find remote ref|could not find remote ref/i.test(fetched.stderr)
    if (fetched.status !== 0 && !missing) return
    const parent = missing ? '' : git(root, ['rev-parse', LOCAL]).stdout.trim()
    git(root, parent ? ['read-tree', parent] : ['read-tree', '--empty'], { env })
    for (const b of blobs) {
      const sha = execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { input: b.body, encoding: 'utf8' }).trim()
      git(root, ['update-index', '--add', '--cacheinfo', `100644,${sha},${b.path}`], { env })
    }
    const tree = git(root, ['write-tree'], { env }).stdout.trim()
    const c = git(root, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'Branchling almanac (sealed) [skip ci]'], { env })
    if (c.status !== 0) return
    const p = git(root, ['push', '--quiet', '--no-verify', 'origin', `${c.stdout.trim()}:refs/heads/branchling`])
    if (p.status === 0) {
      for (const b of blobs) sent[b.f] = String(fs.statSync(path.join(store, b.f)).size)
      fs.writeFileSync(sentFile, JSON.stringify(sent))
      return
    }
    if (!/non-fast-forward|fetch first|rejected/i.test(p.stderr)) return
  }
}

try {
  if (MODE === 'bash') recordBash()
  else if (MODE === 'push') push()
} catch {
  // the recorder never gets in the way of the session
}
process.exit(0)
