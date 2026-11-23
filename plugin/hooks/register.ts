import type { EngineInterface, Register } from 'claude-code'
import { fromBase64, seal, toBase64 } from './seal'

// Branchling: turns what happens in a linked project (.branchling.json) into one-line entries,
// and keeps the project's goal and plan, written by the user's own Claude through the `plan` tool.
// The plugin itself never calls a model. Everything stays on this machine:
//   ~/.branchling/projects/<project>/entries/<YYYY-MM-DD>.jsonl   entries (plugin)
//   ~/.branchling/projects/<project>/entries/<YYYY-MM-DD>.app.jsonl entries (app)
//   ~/.branchling/projects/<project>/plan.json                     goal + tasks (Claude, via the tool)
//   ~/.branchling/projects/<project>/plan.app.jsonl                plan edits (app, /branchling goal)
//   ~/.branchling/projects/<project>/plan-history.jsonl            one line per plan write (for forecasts)
//   ~/.branchling/projects/<project>/labels.json                   { "tr": { "<entry id>": "<text>" } } (Claude, via the tool)
//   ~/.branchling/settings.json                                    { "autoRefresh": true, "language": "tr" } (language: set by the app)

type Kind = 'progress' | 'problem' | 'solution' | 'pause'
type Entry = {
  id: string
  project: string
  branch: string
  date: string
  time: string
  kind: Kind
  text: string
  quote: string | null
  source: string
  tag: string
  task?: string
  meta?: Record<string, string>
}
type Project = { root: string; project: string }
type Size = 'S' | 'M' | 'L'
type Status = 'todo' | 'doing' | 'blocked' | 'done' | 'dropped'
type Task = { id: string; title: string; size: Size; status: Status; branch?: string; blockedBy?: string; doneAt?: string; evidence?: string }
type Estimate = { percent: number; confidence?: string; why?: string }
type Plan = {
  v: 1
  updatedAt: string
  by: string
  goal: string
  goalLocked?: boolean
  summary?: string
  doneWhen?: string[]
  estimate?: Estimate
  tasks: Task[]
  basis?: { entries: number; lastEntry?: string; commit?: string }
  appEventsUpTo?: string
  nextId?: number
}
type PlanEvent = {
  at: string
  source?: string
  goal?: string
  task?: string
  set?: Partial<Pick<Task, 'status' | 'title' | 'size' | 'branch'>>
  add?: { id: string; title: string; size: Size; branch?: string }
}
type Effective = { plan: Plan | null; goal?: string; locked: boolean; tasks: Task[]; lastEventAt?: string }

const POINTS: Record<Kind, number> = { progress: 1, problem: -1, solution: 2, pause: 0 }
const LABEL: Record<Kind, string> = { progress: 'Progress', problem: 'Problem', solution: 'Solved', pause: 'On hold' }
const SIZES: Size[] = ['S', 'M', 'L']
const WEIGHT: Record<Size, number> = { S: 1, M: 2, L: 4 }
const STATUSES: Status[] = ['todo', 'doing', 'blocked', 'done', 'dropped']
// The engine names a plugin tool mcp__<plugin>__plan; a session that first loaded the mod under an older name keeps that one.
const TOOL = 'mcp__branchling__plan'
const isPlanTool = (name: string) => name === TOOL || name === 'mcp__almanak__plan'

const TEST_S = /^(vitest|jest|mocha|pytest|python3? -m pytest|(npm|yarn|pnpm|bun)( run)? test\b|swift test|go test|cargo test|xcodebuild\b.*\btest\b|playwright test)/
const BUILD_S = /^((npm|yarn|pnpm|bun) run build\b|(yarn|pnpm) build\b|vite build|tsc\b|xcodebuild\b|swift build|cargo build|go build|\.\/gradlew\b|gradle\b|make\b)/
const GIT_ON = String.raw`^git\b(?:\s+(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?))*\s+`
const COMMIT_S = new RegExp(GIT_ON + String.raw`commit\b(?!.*--dry-run)`)
const MERGE_S = new RegExp(GIT_ON + String.raw`merge\b(.*)$`)
/** What a test or build prints when it passed: lets a later command in the same line fail without blaming it. */
const PASS_MARK = /Executed \d+ tests?, with 0 failures|Test Suite '.+' passed|Build complete!|\*\* (TEST|BUILD) SUCCEEDED \*\*|\btest result: ok\b|^ok\s+\S+|\bTests?:\s+\d+ passed(?!, \d+ failed)|^=+ \d+ passed\b/m
const FAIL_MARK = /\b[1-9]\d* (failed|failing)\b|\bFAIL\b|error TS\d+|\*\* (BUILD|TEST) FAILED \*\*|BUILD FAILED|npm ERR!|\berror: /
const CD_PREFIX = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*(&&|;)/
const TASK_TAG = /\[([ta]\d{1,4})\]/

let home = ''
let note: string | undefined
let lastUsd: number | undefined

// One line per finished turn (main or subagent) in a linked project:
//   ~/.branchling/projects/<project>/usage/<YYYY-MM-DD>.jsonl
// Token counts are the API's; usd is Claude Code's own /cost estimate (API prices), not a bill.
type UsageLine = {
  at: string
  date: string
  session: string
  branch: string
  agent?: boolean
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  usd?: number
}

const pad = (n: number) => String(n).padStart(2, '0')
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const today = () => localDay(new Date())
const signed = (p: number) => (p > 0 ? `+${p}` : p < 0 ? `−${-p}` : '0')
const clip = (s: string, n = 140) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}
const slug = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)

async function homeDir($: EngineInterface): Promise<string> {
  if (!home) home = (await $.process.run(['printenv', 'HOME'])).stdout.trim()
  return home
}

function resolvePath(base: string, path: string, h: string): string {
  let p = path.replace(/^["']|["']$/g, '')
  if (p === '~' || p.startsWith('~/')) p = h + p.slice(1)
  if (!p.startsWith('/')) p = base.replace(/\/$/, '') + '/' + p
  const parts: string[] = []
  for (const s of p.split('/')) {
    if (!s || s === '.') continue
    if (s === '..') parts.pop()
    else parts.push(s)
  }
  return '/' + parts.join('/')
}

/** Renames and deletions made in the app: {"old": "new"} or {"gone": null}. Lives beside projects/, never inside it. */
async function readAliases($: EngineInterface, h: string): Promise<Record<string, string | null>> {
  const f = `${h}/.branchling/aliases.json`
  try {
    if (await $.fs.exists(f)) {
      const j = JSON.parse(await $.fs.read(f))
      if (j && typeof j === 'object') return j as Record<string, string | null>
    }
  } catch {
    // unreadable: no aliases
  }
  return {}
}

/** Follows renames; null when the project was deleted in the app (the folder then records nothing). */
function resolveAlias(aliases: Record<string, string | null>, name: string): string | null {
  let n = name
  for (let i = 0; i < 10 && n in aliases; i++) {
    const next = aliases[n]
    if (next === null) return null
    n = next
  }
  return n
}

/** The project a folder records into. An unlinked repository joins only with `join`: when real work happens there
 * (a test, build, commit or merge, or an edited file) or the person names it, never because a session opened in it. */
async function findProject($: EngineInterface, dir: string, join = false): Promise<Project | null> {
  const found = (await findLink($, dir)) ?? (join ? await joinOnce($, dir) : null)
  if (!found) return null
  const h = await homeDir($)
  const project = resolveAlias(await readAliases($, h), found.project)
  if (project === null) return null
  if (project !== found.project) {
    try {
      await $.fs.write(`${found.root}/.branchling.json`, JSON.stringify({ project }, null, 2) + '\n')
    } catch {
      // read-only checkout: the alias keeps working
    }
  }
  return { root: found.root, project }
}

// Sessions often run from the home folder and reach projects with "cd <repo> && …" or by editing files there; the
// project worked in last stands in for the session's own folder in commands and the plan tool.
// Each Claude Code session runs its own copy of this module, so these belong to this session alone.
let lastWorked: Project | null = null
/** Every project this session worked in, by almanac name. */
const workedIn = new Map<string, Project>()

function noteWork(pr: Project) {
  lastWorked = pr
  workedIn.set(pr.project, pr)
}

/** When this session worked in more than one project, naming one is the only safe way: never guess the plan's project. */
function whichOne(): string | null {
  if (workedIn.size < 2) return null
  const names = [...workedIn.values()]
  return 'This session worked in more than one project, so Branchling will not guess. Pick one:\n' +
    names.map(p => `  /branchling plan ${p.project}    (${p.root})`).join('\n')
}

/** The project a command or the plan tool means: a folder or almanac name if given, else this folder, else the last one worked in. */
async function projectFor($: EngineInterface, h: string, cwd: string, given?: string): Promise<Project | null | string> {
  const g = (given ?? '').trim()
  if (g) {
    if (/^[~/.]/.test(g)) return (await findProject($, resolvePath(cwd, g, h), true)) ?? `${g} is not a git repository.`
    const name = slug(g)
    const links = await readLinks($, h)
    const root = Object.keys(links).find(r => links[r] === name)
    if (root) return { root, project: name }
    return `No folder is linked to the "${name}" almanac yet. Link it once with /branchling link ${name} <folder>, for example /branchling link ${name} ~/Projects/my-app`
  }
  return lastWorked ?? (await findProject($, cwd))
}

function notHere(cwd: string): string {
  return `Claude Code is open in ${cwd}, which is not a git repository, and no project was worked on in this session yet. ` +
    'Name the project: /branchling plan <folder or almanac name>, for example /branchling plan ~/Projects/my-app. ' +
    'To record a folder under an almanac you made in the app: /branchling link <name> <folder>.'
}

// Projects join by themselves: the first time Claude Code works in a git repository, it gets an almanac named after
// its folder. ~/.branchling/links.json keeps the choice per repository root ({ "<root>": "<project>" | null });
// null is /branchling off. An older .branchling.json in the repository still wins.
const linksFile = (h: string) => `${h}/.branchling/links.json`
const joined = new Map<string, Project | null>()

async function readLinks($: EngineInterface, h: string): Promise<Record<string, string | null>> {
  try {
    const j = JSON.parse(await $.fs.read(linksFile(h)))
    return j && typeof j === 'object' ? j : {}
  } catch {
    return {}
  }
}

async function setLink($: EngineInterface, h: string, root: string, project: string | null) {
  const links = await readLinks($, h)
  links[root] = project
  await $.fs.write(linksFile(h), JSON.stringify(links, null, 2) + '\n')
  joined.clear()
}

async function gitRoot($: EngineInterface, dir: string): Promise<string | null> {
  const g = await $.process.run(['git', '-C', dir, 'rev-parse', '--show-toplevel'])
  return g.exitCode === 0 && g.stdout.trim() ? g.stdout.trim() : null
}

async function joinOnce($: EngineInterface, dir: string): Promise<Project | null> {
  if (joined.has(dir)) return joined.get(dir) ?? null
  let found: Project | null = null
  try {
    const h = await homeDir($)
    const root = await gitRoot($, dir)
    if (root && root !== h) {
      const links = await readLinks($, h)
      if (root in links) {
        const project = links[root]
        found = project ? { root, project } : null
      } else {
        const taken = new Set(Object.values(links).filter(Boolean))
        const base = slug(root.split('/').pop() ?? '') || 'project'
        let project = base
        for (let i = 2; taken.has(project); i++) project = `${base}-${i}`
        await setLink($, h, root, project)
        found = { root, project }
      }
    }
  } catch {
    // no git or no home: not a project
  }
  joined.set(dir, found)
  return found
}

async function findLink($: EngineInterface, dir: string): Promise<Project | null> {
  let d = dir
  for (let i = 0; i < 40; i++) {
    const f = (d === '/' ? '' : d) + '/.branchling.json'
    if (await $.fs.exists(f)) {
      try {
        const j = JSON.parse(await $.fs.read(f))
        if (j && typeof j.project === 'string' && j.project) return { root: d, project: slug(j.project) || 'project' }
      } catch {
        // unreadable link file: stay quiet
      }
      return null
    }
    if (d === '/') return null
    d = d.slice(0, d.lastIndexOf('/')) || '/'
  }
  return null
}

const projectDir = (h: string, project: string) => `${h}/.branchling/projects/${project}`
const dayFile = (h: string, project: string, date: string) => `${projectDir(h, project)}/entries/${date}.jsonl`

async function readJsonl<T>($: EngineInterface, f: string): Promise<T[]> {
  if (!(await $.fs.exists(f))) return []
  const out: T[] = []
  for (const line of (await $.fs.read(f)).split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // skip a broken line
    }
  }
  return out
}

async function appendLine($: EngineInterface, f: string, obj: unknown) {
  const old = (await $.fs.exists(f)) ? await $.fs.read(f) : ''
  await $.fs.write(f, old + (old && !old.endsWith('\n') ? '\n' : '') + JSON.stringify(obj) + '\n')
}

async function readAll($: EngineInterface, h: string, project: string): Promise<Entry[]> {
  const dir = `${projectDir(h, project)}/entries`
  if (!(await $.fs.exists(dir))) return []
  const out: Entry[] = []
  for (const f of await $.fs.list(dir)) {
    if (f.kind === 'file' && f.name.endsWith('.jsonl')) out.push(...(await readJsonl<Entry>($, `${dir}/${f.name}`)))
  }
  return out.sort((a, b) => (a.time < b.time ? -1 : 1))
}

function openProblems(es: Entry[]): Entry[] {
  const closed = new Set(es.filter(e => e.quote && (e.kind === 'solution' || e.kind === 'problem')).map(e => e.quote))
  return es.filter(e => e.kind === 'problem' && !closed.has(e.id))
}

/** Holds nobody picked up again (no later entry quotes them or follows on their branch), and approvals not yet given. */
function waiting(es: Entry[]): { holds: Entry[]; approvals: Entry[] } {
  const quoted = new Set(es.filter(e => e.quote).map(e => e.quote))
  const sorted = [...es].sort((a, b) => a.time.localeCompare(b.time))
  const holds = sorted.filter((e, i) => e.kind === 'pause' && e.tag !== 'approval' && !quoted.has(e.id) && !sorted.slice(i + 1).some(x => x.branch === e.branch))
  const approvals = sorted.filter(e => e.tag === 'approval' && !quoted.has(e.id))
  return { holds, approvals }
}

/** Momentum v2, the same rules as the app: stumble 0, 3 scored commits per branch per day, +5 for closing a task. */
function scoreAll(es: Entry[]): Map<string, number> {
  const byId = new Map(es.map(e => [e.id, e]))
  const stumble = new Set<string>()
  for (const s of es) {
    const p = s.quote ? byId.get(s.quote) : undefined
    if (s.kind === 'solution' && s.source === 'auto' && p && p.kind === 'problem' && p.source === 'auto' && Date.parse(s.time) - Date.parse(p.time) <= 15 * 60_000) {
      stumble.add(p.id)
      stumble.add(s.id)
    }
  }
  const pts = new Map<string, number>()
  const commits = new Map<string, number>()
  const closed = new Set<string>()
  for (const e of es) {
    if (stumble.has(e.id)) pts.set(e.id, 0)
    else if (e.task && (e.kind === 'progress' || e.kind === 'solution') && !closed.has(e.task)) {
      closed.add(e.task)
      pts.set(e.id, 5)
    } else if (e.source === 'commit') {
      const k = e.branch + '|' + e.date
      const n = (commits.get(k) ?? 0) + 1
      commits.set(k, n)
      pts.set(e.id, n > 3 ? 0 : POINTS[e.kind])
    } else pts.set(e.id, POINTS[e.kind])
  }
  return pts
}

const sumPoints = (pts: Map<string, number>, es: Entry[]) => es.reduce((s, e) => s + (pts.get(e.id) ?? POINTS[e.kind]), 0)

/** Where a commit was made when git didn't print it (commit -q): a branch merged in the same command wins over
 *  the branch it was merged into, since a commit made just now and then merged sits on both. */
async function homeBranch($: EngineInterface, root: string, hash: string, current: string, merged?: string): Promise<string> {
  const r = await $.process.run(['git', '-C', root, 'for-each-ref', '--contains', hash, '--format=%(refname:short)%09%(objectname:short)', 'refs/heads/'])
  if (r.exitCode !== 0) return current
  const refs = r.stdout.trim().split('\n').filter(Boolean).map(l => l.split('\t') as [string, string])
  const on = refs.map(([b]) => b)
  if (merged && on.includes(merged)) return merged
  if (on.length === 1) return on[0] ?? current
  // Branches whose tip is this very commit: it was made on one of them. When several share the tip
  // ("commit, then checkout -b"), the new branch has nothing of its own yet, so the trunk keeps it.
  const tips = refs.filter(([, t]) => hash.startsWith(t) || t.startsWith(hash)).map(([b]) => b)
  if (tips.length === 1) return tips[0] ?? current
  const trunk = tips.find(b => b === 'main' || b === 'master' || b === 'trunk' || b === 'develop')
  if (trunk) return trunk
  return on.includes(current) ? current : (on[0] ?? current)
}

async function currentBranch($: EngineInterface, root: string): Promise<string> {
  try {
    const r = await $.process.run(['git', '-C', root, 'symbolic-ref', '--short', '-q', 'HEAD'])
    const b = r.stdout.trim()
    if (r.exitCode === 0 && b) return b
  } catch {
    // no git
  }
  return 'main'
}

// ---------- Plan ----------

async function readPlan($: EngineInterface, h: string, project: string): Promise<Plan | null> {
  const f = `${projectDir(h, project)}/plan.json`
  if (!(await $.fs.exists(f))) return null
  try {
    const p = JSON.parse(await $.fs.read(f))
    return p && Array.isArray(p.tasks) ? (p as Plan) : null
  } catch {
    return null
  }
}

/** plan.json, then app edits after it, then tasks closed by [tN] commits: the same rule as the app. */
async function effective($: EngineInterface, h: string, project: string, entries: Entry[]): Promise<Effective> {
  const plan = await readPlan($, h, project)
  const events = (await readJsonl<PlanEvent>($, `${projectDir(h, project)}/plan.app.jsonl`)).sort((a, b) => (a.at < b.at ? -1 : 1))
  const cut = plan?.appEventsUpTo ?? ''
  let goal = plan?.goal
  let locked = plan?.goalLocked ?? false
  const tasks: Task[] = (plan?.tasks ?? []).map(t => ({ ...t }))
  for (const ev of events) {
    if (ev.at <= cut) continue
    if (ev.goal) {
      goal = ev.goal
      locked = true
    }
    if (ev.add && !tasks.some(t => t.id === ev.add!.id)) tasks.push({ ...ev.add, status: 'todo' })
    const t = ev.task ? tasks.find(x => x.id === ev.task) : undefined
    if (t && ev.set) {
      Object.assign(t, ev.set)
      if (ev.set.status === 'done' && !t.doneAt) t.doneAt = ev.at.slice(0, 10)
    }
  }
  for (const e of entries) {
    const t = e.task ? tasks.find(x => x.id === e.task) : undefined
    if (t && t.status !== 'done' && t.status !== 'dropped') {
      t.status = 'done'
      t.doneAt = e.date
      t.evidence = t.evidence ?? e.tag
    }
  }
  return { plan, goal, locked, tasks, lastEventAt: events.length ? events[events.length - 1].at : undefined }
}

function percentOf(tasks: Task[]): number | null {
  const live = tasks.filter(t => t.status !== 'dropped')
  const total = live.reduce((s, t) => s + WEIGHT[t.size], 0)
  if (!total) return null
  return Math.round((live.filter(t => t.status === 'done').reduce((s, t) => s + WEIGHT[t.size], 0) / total) * 100)
}

const remaining = (tasks: Task[]) => tasks.filter(t => t.status !== 'done' && t.status !== 'dropped')

/** Refresh is due once a day, and only when something happened since the last plan. */
function refreshDue(plan: Plan | null, entries: Entry[]): number {
  if (!plan) return 0
  if (localDay(new Date(plan.updatedAt)) === today()) return 0
  return entries.filter(e => e.time > plan.updatedAt).length
}

type Settings = { autoRefresh: boolean; language: Lang | null }
type Lang = 'en' | 'tr' | 'de'

async function settings($: EngineInterface, h: string): Promise<Settings> {
  try {
    const f = `${h}/.branchling/settings.json`
    if (!(await $.fs.exists(f))) return { autoRefresh: true, language: null }
    const o = JSON.parse(await $.fs.read(f))
    const language = o.language === 'en' || o.language === 'tr' || o.language === 'de' ? (o.language as Lang) : null
    return { autoRefresh: o.autoRefresh !== false, language }
  } catch {
    return { autoRefresh: true, language: null }
  }
}

async function autoRefresh($: EngineInterface, h: string): Promise<boolean> {
  return (await settings($, h)).autoRefresh
}

const LANG_NAME: Record<Lang, string> = { en: 'English', tr: 'Turkish', de: 'German' }

type Labels = Partial<Record<Lang, Record<string, string>>>
const LABELS_PER_WRITE = 80

async function readLabels($: EngineInterface, h: string, project: string): Promise<Labels> {
  try {
    const f = `${projectDir(h, project)}/labels.json`
    return (await $.fs.exists(f)) ? JSON.parse(await $.fs.read(f)) : {}
  } catch {
    return {}
  }
}

/** Entries the person reads in another language than they were written in: newest first. */
function untranslated(es: Entry[], labels: Labels, lang: Lang | null): Entry[] {
  if (!lang || lang === 'en') return []
  const have = labels[lang] ?? {}
  return es.filter(e => !have[e.id] && e.meta?.lang !== lang).reverse()
}

/** The sentence that tells Claude which language the plan is written in. */
function languageRule(lang: Lang | null): string {
  return lang
    ? `Write the goal, summary and task titles in ${LANG_NAME[lang]}, the language of the user's Branchling app; keep task ids, branch names and code terms as they are. If the current plan is in another language, translate it.`
    : `Write the goal, summary and task titles in the language the user speaks with you; keep task ids, branch names and code terms as they are.`
}

/** The plugin's own entry texts, in the app's language. Commit subjects stay as they were written. */
const AUTO: Record<Lang, { broke: (tag: string, line: string) => string; again: (tag: string) => string; merged: (from: string, into: string) => string }> = {
  en: {
    broke: (t, l) => `${t === 'test' ? 'Tests' : 'Build'} broke: ${l}`,
    again: t => `${t === 'test' ? 'Tests' : 'Build'} pass again`,
    merged: (f, b) => `${f} merged back into ${b}`,
  },
  tr: {
    broke: (t, l) => `${t === 'test' ? 'Testler' : 'Derleme'} bozuldu: ${l}`,
    again: t => `${t === 'test' ? 'Testler' : 'Derleme'} yeniden geçti`,
    merged: (f, b) => `${f}, ${b} dalına geri birleşti`,
  },
  de: {
    broke: (t, l) => `${t === 'test' ? 'Tests' : 'Build'} kaputt: ${l}`,
    again: t => `${t === 'test' ? 'Tests laufen' : 'Build läuft'} wieder`,
    merged: (f, b) => `${f} zurück in ${b} geführt`,
  },
}

/** Rebuilds the status line and the short note Claude reads in this session. */
async function refresh($: EngineInterface) {
  try {
    const h = await homeDir($)
    const pr = lastWorked ?? (await findProject($, await $.session.cwd()))
    if (!pr) {
      note = undefined
      return
    }
    schedulePush($, pr)
    const es = await readAll($, h, pr.project)
    const eff = await effective($, h, pr.project, es)
    const t = today()
    const score = sumPoints(scoreAll(es), es.filter(e => e.date === t))
    const open = openProblems(es).length
    const pct = percentOf(eff.tasks)
    const due = refreshDue(eff.plan, es)
    const auto = await autoRefresh($, h)
    const parts = [`Branchling · ${pr.project}`]
    if (pct !== null) parts.push(`${pct}%`)
    parts.push(`today ${signed(score)}`)
    if (open) parts.push(`${open} open problem${open > 1 ? 's' : ''}`)
    if (!eff.plan && !eff.goal) parts.push('no plan: /branchling plan')
    else if (due && !auto) parts.push('plan old: /branchling plan')
    $.ui.status(parts.join(' · '))

    if (!eff.plan && !eff.goal) {
      note = undefined
      return
    }
    const rest = remaining(eff.tasks).slice(0, 8)
    const lines = [
      `## Branchling`,
      `This repository is tracked by Branchling (project "${pr.project}").${eff.goal ? ` Goal: "${eff.goal}".` : ''}`,
    ]
    if (rest.length) {
      lines.push(`Open planned tasks: ${rest.map(x => `${x.id} ${x.title} (${x.status}${x.branch ? `, ${x.branch}` : ''})`).join('; ')}.`)
      lines.push(`When a commit completes one of these tasks, end its subject with the task tag, e.g. "… [${rest[0].id}]".`)
    }
    if (due && auto && eff.plan) {
      lines.push(
        `The Branchling plan was last written ${localDay(new Date(eff.plan.updatedAt))} and ${due} entr${due > 1 ? 'ies were' : 'y was'} recorded since. ` +
          `When the user's current request is finished (never in the middle of it), refresh the plan once: call the Branchling plan tool (${TOOL}) with action "read", then with action "write", both with project "${pr.root}". ` +
          `${languageRule((await settings($, h)).language)} ` +
          `Afterwards say so in one short line.`,
      )
    }
    note = lines.join('\n')
  } catch {
    // keep the last note
  }
}

async function add(
  $: EngineInterface,
  h: string,
  pr: Project,
  e: Pick<Entry, 'branch' | 'kind' | 'text' | 'quote' | 'source' | 'tag'> & Partial<Pick<Entry, 'task' | 'meta'>>,
): Promise<Entry> {
  const entry: Entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    project: pr.project,
    date: today(),
    time: new Date().toISOString(),
    ...e,
    text: clip(e.text),
  }
  if (!entry.task) delete entry.task
  if (!entry.meta) delete entry.meta
  await appendLine($, dayFile(h, pr.project, entry.date), entry)
  const pts = scoreAll(await readAll($, h, pr.project)).get(entry.id) ?? POINTS[entry.kind]
  $.ui.toast(`Branchling: ${LABEL[entry.kind]} ${signed(pts)}${entry.task ? ` · ${entry.task} done` : ''} · ${entry.text}`)
  await refresh($)
  return entry
}

function segments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||\n/)
    .map(s =>
      s
        .trim()
        .replace(/^(\w+=\S*\s+)+/, '')
        .replace(/^(time|npx|bunx|exec)\s+/, '')
        .trim(),
    )
    .filter(Boolean)
}

/** Splits a command's arguments like a shell would, quotes included; an unclosed quote runs to the end. */
function shellWords(s: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"?|'([^']*)'?|(\S+)/g
  for (let m = re.exec(s); m; m = re.exec(s)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

/** The branch a `git merge` segment merges in, skipping flags and their values; undefined for --abort and friends. */
function mergeSource(seg: string): string | undefined {
  const m = seg.match(MERGE_S)
  if (!m) return undefined
  const words = shellWords(m[1])
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (/^--(abort|continue|quit|skip)$/.test(w)) return undefined
    if (/^(-m|--message|-s|--strategy|-X|--strategy-option|-F|--file|--into-name)$/.test(w)) {
      i++
      continue
    }
    if (w.startsWith('-')) continue
    return w
  }
  return undefined
}

function failureLine(output: string): string {
  const lines = output.split('\n').map(s => s.trim()).filter(Boolean)
  const l =
    lines.find(x => /error TS\d+|\berror: /.test(x)) ??
    lines.find(x => /\bFAIL\b|✗|×/.test(x)) ??
    lines.find(x => /failed|failing|Error/.test(x)) ??
    lines.find(x => /Exit code/.test(x)) ??
    'non-zero exit'
  return l.replace(/\/(Users|home)\/[^\s:()]+\/([^/\s:()]+)/g, '$2')
}

// ---------- Claude usage ----------

async function sessionUsd($: EngineInterface): Promise<number | undefined> {
  try {
    return (await $.session.usage()).cost?.usd
  } catch {
    return undefined
  }
}

async function recordUsage($: EngineInterface, u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; model: string }, agent: boolean) {
  const h = await homeDir($)
  const pr = lastWorked ?? (await findProject($, await $.session.cwd()))
  const usd = await sessionUsd($)
  const delta = usd !== undefined && lastUsd !== undefined ? Math.max(0, usd - lastUsd) : undefined
  if (usd !== undefined) lastUsd = usd
  if (!pr) return
  const line: UsageLine = {
    at: new Date().toISOString(),
    date: today(),
    session: await $.session.id(),
    branch: await currentBranch($, pr.root),
    model: u.model,
    input: u.input_tokens,
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens,
    cacheWrite: u.cache_creation_input_tokens,
  }
  if (agent) line.agent = true
  if (delta !== undefined) line.usd = Math.round(delta * 10000) / 10000
  await appendLine($, `${projectDir(h, pr.project)}/usage/${line.date}.jsonl`, line)
}

async function readUsage($: EngineInterface, h: string, project: string): Promise<UsageLine[]> {
  const dir = `${projectDir(h, project)}/usage`
  if (!(await $.fs.exists(dir))) return []
  const out: UsageLine[] = []
  for (const f of await $.fs.list(dir)) if (f.kind === 'file' && f.name.endsWith('.jsonl')) out.push(...(await readJsonl<UsageLine>($, `${dir}/${f.name}`)))
  return out
}

const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))

function usageSum(ls: UsageLine[]) {
  return {
    turns: ls.length,
    sessions: new Set(ls.map(l => l.session)).size,
    fresh: ls.reduce((s, l) => s + l.input + l.cacheWrite, 0),
    read: ls.reduce((s, l) => s + l.cacheRead, 0),
    output: ls.reduce((s, l) => s + l.output, 0),
    usd: ls.reduce((s, l) => s + (l.usd ?? 0), 0),
  }
}

/** The ask tool: approvals Claude is waiting on, kept as entries tagged "approval". */
async function handleAsk($: EngineInterface, e: object): Promise<{ result: string } | { deny: string }> {
  const input = e as unknown as { action?: unknown; text?: unknown; id?: unknown }
  try {
    const h = await homeDir($)
    const pr = lastWorked ?? (await findProject($, await $.session.cwd()))
    if (!pr) return { deny: 'This folder is not linked to a Branchling project.' }
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    const pending = waiting(await readAll($, h, pr.project)).approvals
    if (input.action === 'list') {
      return { result: pending.length ? pending.map(x => `${x.id} · ${x.date} · ${x.text}`).join('\n') : 'Nothing is waiting for approval.' }
    }
    if (input.action === 'ask') {
      if (!text) return { deny: 'text is required: one short line saying what needs approving.' }
      const x = await add($, h, pr, { branch: await currentBranch($, pr.root), kind: 'pause', text, quote: null, source: 'claude', tag: 'approval' })
      return { result: `Waiting for approval, id ${x.id}. Resolve it with this id once the user answers.` }
    }
    if (input.action === 'resolve') {
      const a = pending.find(x => x.id === input.id)
      if (!a) return { deny: 'No approval with that id is waiting. Call list for the ids.' }
      await add($, h, pr, { branch: a.branch, kind: 'progress', text: text || `Approved: ${a.text}`, quote: a.id, source: 'claude', tag: 'approved' })
      return { result: 'Resolved.' }
    }
    return { deny: 'action must be "ask", "resolve" or "list".' }
  } catch (err) {
    return { deny: `Branchling could not handle that: ${String(err)}` }
  }
}

// ---------- The plan tool ----------

const PLAN_TOOL_DESC = `Reads or writes this project's Branchling plan: one punchy goal sentence, a short summary of where the project stands, and the planned tasks in the order they will be done. The Branchling app shows it at the top of the project, computes progress from the tasks and forecasts the finish from the pace of work.
Always call it with action "read" first: it returns the current plan, what happened since (entries, open problems, commits) and the writing rules. Then call it with action "write" and the whole plan.`

const ASK_TOOL_DESC = `Keeps the Branchling list of things waiting on the user's approval, shown under Waiting in the Branchling app.
Call it with action "ask" when you stop and need the user's OK or decision before going on (deploy, delete, spend, pick an option); text is one short line saying what needs approving.
Call it with action "resolve" and the id when the user has answered, with text saying what they decided. Action "list" returns what is still waiting.`

const ASK_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['ask', 'resolve', 'list'] },
    text: { type: 'string', description: 'ask: what needs the OK, under 90 characters. resolve: what was decided.' },
    id: { type: 'string', description: 'resolve: the id that ask or list returned.' },
  },
  required: ['action'],
} as const

const isAskTool = (name: string) => name === 'mcp__branchling__ask' || name === 'mcp__almanak__ask'

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['read', 'write'] },
    project: {
      type: 'string',
      description: 'The project folder (absolute path) or almanac name. Leave out to use the session folder or the project worked on last.',
    },
    goal: { type: 'string', description: 'One punchy sentence, at most 90 characters: what done looks like.' },
    summary: { type: 'string', description: 'At most 320 characters: where the project stands now.' },
    doneWhen: { type: 'array', items: { type: 'string' }, description: 'Up to 5 observable criteria for "done".' },
    labels: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Only when "read" lists entries to translate: entry id to its text in the user\'s language.',
    },
    estimate: {
      type: 'object',
      properties: {
        percent: { type: 'number', description: 'Your own judgement, 0-100, of how complete the whole goal is.' },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        why: { type: 'string', description: 'At most 140 characters.' },
      },
      required: ['percent'],
    },
    tasks: {
      type: 'array',
      description: 'All tasks, in the order they will be done. Keep the id of existing tasks; leave id out for new ones.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string', description: 'At most 80 characters.' },
          size: { type: 'string', enum: SIZES, description: 'S: under half a day. M: one or two days. L: three days or more.' },
          status: { type: 'string', enum: STATUSES },
          branch: { type: 'string', description: 'Git branch the work happens on, if known.' },
          blockedBy: { type: 'string', description: 'Id of the open problem entry that blocks it.' },
          evidence: { type: 'string', description: 'What proves it is done, e.g. commit:abc1234.' },
        },
        required: ['title', 'size', 'status'],
      },
    },
  },
  required: ['action'],
}

async function planDigest($: EngineInterface, h: string, pr: Project): Promise<string> {
  const es = await readAll($, h, pr.project)
  const eff = await effective($, h, pr.project, es)
  const lang = (await settings($, h)).language
  const todo = untranslated(es, await readLabels($, h, pr.project), lang)
  const since = eff.plan ? es.filter(e => e.time > eff.plan!.updatedAt) : es
  const open = openProblems(es)
  const branches = [...new Set(es.map(e => e.branch))]
  let log = ''
  try {
    const g = await $.process.run(['git', '-C', pr.root, 'log', '--oneline', '-15'])
    if (g.exitCode === 0) log = g.stdout.trim()
  } catch {
    // no git
  }
  const current =
    eff.plan || eff.goal
      ? JSON.stringify({ goal: eff.goal, goalLocked: eff.locked, summary: eff.plan?.summary, doneWhen: eff.plan?.doneWhen, estimate: eff.plan?.estimate, tasks: eff.tasks }, null, 1)
      : 'none yet'
  const out = [
    `Project: ${pr.project} (folder ${pr.root})`,
    `Current plan${eff.plan ? ` (written ${eff.plan.updatedAt}; app edits and [tN] commits already folded in)` : ''}:\n${current}`,
    `Entries since the last plan (${since.length}, newest last${since.length > 40 ? ', last 40 shown' : ''}):\n${since.slice(-40).map(e => `${e.date} · ${LABEL[e.kind]} · ${e.branch} · ${e.text}${e.task ? ` [${e.task}]` : ''}`).join('\n') || '(none)'}`,
    `Open problems:\n${open.map(e => `${e.id} · ${e.date} · ${e.branch} · ${e.text}`).join('\n') || '(none)'}`,
    `Branches seen: ${branches.join(', ') || '(none)'}`,
    `Recent commits:\n${log || '(no git history)'}`,
    `Rules for "write":`,
    `- goal: one punchy sentence, at most 90 characters, about the outcome, not the activity.${eff.locked ? ' The user set the goal by hand: it stays as it is, send it unchanged.' : ''}`,
    `- summary: at most 320 characters, where the project stands now and what is in the way.`,
    `- tasks: the whole road to the goal in the order it will be done; keep ids of existing tasks, leave id out for new ones; at most 25 open tasks; mark finished ones done and abandoned ones dropped instead of deleting them; blockedBy is the id of an open problem above.`,
    `- estimate.percent: your own judgement of how complete the goal is; the app also computes a % from task sizes and shows both.`,
    `- Do not write dates or deadlines: the app forecasts them from the pace of work.`,
    `- Language: ${languageRule(lang)}`,
  ]
  if (todo.length && lang) {
    const batch = todo.slice(0, LABELS_PER_WRITE)
    out.push(
      `Entries to translate (${batch.length}${todo.length > batch.length ? ` of ${todo.length}; the rest come with the next write` : ''}):\n` +
        batch.map(e => `${e.id} · ${e.text}`).join('\n'),
    )
    out.push(
      `- labels: the user reads the almanac in ${LANG_NAME[lang]}, but the entries above were written in another language (mostly commit subjects). ` +
        `Send labels: {"<id>": "<${LANG_NAME[lang]} text>"} for every one of them: same meaning, at most 140 characters; keep code terms, file names, error text and branch names as they are. Git and the entries themselves stay unchanged.`,
    )
  }
  if (!eff.plan && !eff.goal) {
    out.push(`There is no plan yet. Infer the goal from README, CLAUDE.md, package metadata and recent commits; ask the user only if the goal is truly unclear.`)
  }
  return out.join('\n\n')
}

type WriteInput = {
  labels?: unknown
  goal?: unknown
  summary?: unknown
  doneWhen?: unknown
  estimate?: unknown
  tasks?: unknown
}

async function planWrite($: EngineInterface, h: string, pr: Project, input: WriteInput): Promise<{ ok: string } | { error: string }> {
  const es = await readAll($, h, pr.project)
  const eff = await effective($, h, pr.project, es)
  const str = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')

  const goal = eff.locked && eff.goal ? eff.goal : str(input.goal) || eff.goal || ''
  if (!goal) return { error: 'goal is missing: one punchy sentence, at most 90 characters.' }
  if (goal.length > 90) return { error: `goal is ${goal.length} characters; shorten it to at most 90.` }
  const summary = str(input.summary) || eff.plan?.summary || ''
  if (summary.length > 320) return { error: `summary is ${summary.length} characters; shorten it to at most 320.` }
  const doneWhen = Array.isArray(input.doneWhen) ? input.doneWhen.map(str).filter(Boolean).slice(0, 5) : eff.plan?.doneWhen

  let estimate: Estimate | undefined = eff.plan?.estimate
  if (input.estimate && typeof input.estimate === 'object') {
    const e = input.estimate as Record<string, unknown>
    const p = Number(e.percent)
    if (!Number.isFinite(p) || p < 0 || p > 100) return { error: 'estimate.percent must be a number from 0 to 100.' }
    estimate = { percent: Math.round(p), confidence: str(e.confidence) || undefined, why: str(e.why).slice(0, 140) || undefined }
  }

  if (!Array.isArray(input.tasks)) return { error: 'tasks must be an array (send every task, in order).' }
  const known = new Map(eff.tasks.map(t => [t.id, t]))
  let nextId = Math.max(eff.plan?.nextId ?? 1, ...eff.tasks.map(t => (/^t(\d+)$/.exec(t.id) ? Number(t.id.slice(1)) + 1 : 1)))
  const seen = new Set<string>()
  const tasks: Task[] = []
  for (const [i, raw] of input.tasks.entries()) {
    if (!raw || typeof raw !== 'object') return { error: `tasks[${i}] is not an object.` }
    const r = raw as Record<string, unknown>
    const title = str(r.title)
    if (!title) return { error: `tasks[${i}] has no title.` }
    if (title.length > 80) return { error: `tasks[${i}].title is ${title.length} characters; at most 80.` }
    const size = str(r.size).toUpperCase() as Size
    if (!SIZES.includes(size)) return { error: `tasks[${i}].size must be S, M or L.` }
    const status = str(r.status).toLowerCase() as Status
    if (!STATUSES.includes(status)) return { error: `tasks[${i}].status must be one of ${STATUSES.join(', ')}.` }
    let id = str(r.id)
    if (!id || !known.has(id) || seen.has(id)) id = `t${nextId++}`
    seen.add(id)
    const prev = known.get(id)
    const t: Task = { id, title, size, status }
    const branch = str(r.branch)
    if (branch) t.branch = branch
    const blockedBy = str(r.blockedBy)
    if (blockedBy && status === 'blocked') t.blockedBy = blockedBy
    const evidence = str(r.evidence) || prev?.evidence
    if (evidence) t.evidence = evidence
    if (status === 'done') t.doneAt = prev?.doneAt ?? today()
    tasks.push(t)
  }
  // Tasks Claude left out are kept as they were: removing work happens by marking it dropped.
  for (const t of eff.tasks) if (!seen.has(t.id)) tasks.push(t)
  const open = remaining(tasks).length
  if (open > 25) return { error: `${open} open tasks; keep at most 25 by merging small ones.` }

  let commit: string | undefined
  try {
    const g = await $.process.run(['git', '-C', pr.root, 'rev-parse', '--short', 'HEAD'])
    if (g.exitCode === 0) commit = g.stdout.trim() || undefined
  } catch {
    // no git
  }
  const now = new Date().toISOString()
  const plan: Plan = {
    v: 1,
    updatedAt: now,
    by: 'claude-code',
    goal,
    goalLocked: eff.locked || undefined,
    summary: summary || undefined,
    doneWhen: doneWhen?.length ? doneWhen : undefined,
    estimate,
    tasks,
    basis: { entries: es.length, lastEntry: es.length ? es[es.length - 1].id : undefined, commit },
    appEventsUpTo: eff.lastEventAt && eff.lastEventAt > now ? eff.lastEventAt : now,
    nextId,
  }
  const dir = projectDir(h, pr.project)
  await $.fs.write(`${dir}/plan.json`, JSON.stringify(plan, null, 2) + '\n')
  const live = tasks.filter(t => t.status !== 'dropped')
  await appendLine($, `${dir}/plan-history.jsonl`, {
    at: now,
    percentClaude: estimate?.percent ?? null,
    doneWeight: live.filter(t => t.status === 'done').reduce((s, t) => s + WEIGHT[t.size], 0),
    totalWeight: live.reduce((s, t) => s + WEIGHT[t.size], 0),
    tasks: tasks.length,
  })
  const labelled = await saveLabels($, h, pr.project, es, input.labels)
  await refresh($)
  const pct = percentOf(tasks)
  return {
    ok: `Plan saved for "${pr.project}": ${pct ?? 0}% by task size (${tasks.filter(t => t.status === 'done').length}/${live.length} tasks done)${estimate ? `, your estimate ${estimate.percent}%` : ''}. Goal: "${goal}"${eff.locked ? ' (kept: the user set it by hand)' : ''}.${labelled}`,
  }
}

/** Keeps Claude's translations of entry texts; returns a short note for the tool answer. */
async function saveLabels($: EngineInterface, h: string, project: string, es: Entry[], raw: unknown): Promise<string> {
  const lang = (await settings($, h)).language
  if (!lang || lang === 'en' || !raw || typeof raw !== 'object' || Array.isArray(raw)) return ''
  const ids = new Set(es.map(e => e.id))
  const labels = await readLabels($, h, project)
  const mine = (labels[lang] ??= {})
  let n = 0
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!ids.has(id) || typeof v !== 'string') continue
    const t = v.replace(/\s+/g, ' ').trim()
    if (!t) continue
    mine[id] = clip(t)
    n++
  }
  if (!n) return ''
  await $.fs.write(`${projectDir(h, project)}/labels.json`, JSON.stringify(labels, null, 1) + '\n')
  const left = untranslated(es, labels, lang).length
  return ` ${n} entr${n === 1 ? 'y' : 'ies'} translated${left ? `; ${left} left for the next write` : ''}.`
}

/** Whether `from` was merged into HEAD since `started`, from git's reflog: a later command in the same line may
 *  fail and still leave the merge done. Falls back to what the output said when the reflog can't be read. */
async function mergedNow($: EngineInterface, root: string, from: string, started: number, fallback: boolean): Promise<boolean> {
  try {
    const r = await $.process.run(['git', '-C', root, 'reflog', '-n', '15', '--date=unix', '--format=%gd%x09%gs'])
    if (r.exitCode !== 0) return fallback
    return r.stdout.split('\n').some(l => {
      const [ref = '', subject = ''] = l.split('\t')
      const at = Number(/@\{(\d+)\}/.exec(ref)?.[1] ?? 0)
      return at >= started - 2 && subject.startsWith(`merge ${from}:`)
    })
  } catch {
    return fallback
  }
}

// ---------- iPhone (through the person's own iCloud) ----------
// Two ways, chosen on the iPhone under Connect; neither needs a Branchling server or any account but iCloud:
//
// 1. A Mac with the Branchling app: the app reads ~/.branchling and puts it into the person's private CloudKit
//    database itself. The plugin has nothing to send.
// 2. Any other computer (Windows, Linux, a Mac without the app): the iPhone shows a sentence with a web token for
//    Branchling's own part of the person's iCloud (container iCloud.app.branchling, nothing else) and the public half
//    of the almanac key. Claude writes them to ~/.branchling/cloud.json. After each change the plugin seals the
//    changed files with the key and writes them as "AlmanacFile" records, the same records the Mac app writes. The
//    token may end up in chat history; it opens nothing, because only the person's devices hold the private key.
//
// Claude Code in the cloud cannot reach iCloud. There the recorder (cloud/record.mjs, committed as
// .claude/branchling/record.mjs) keeps sealed entries on the repository's own `branchling` branch. When the person
// next works on the project on a computer, the plugin fetches that branch with the person's own git and drops the
// sealed files, unopened, into ~/.branchling/projects/<project>/entries/*.sealed. The Mac app opens them with the
// key from iCloud Keychain; on the other way they travel sealed and the iPhone opens them.

type Cloud = { env: 'production' | 'development'; api: string; web: string; key: string; device?: string; broken?: boolean }

const BRANCH = 'branchling'
const KEY_RE = /^[A-Za-z0-9+/]{43}=$/
const GIT_REMOTE = /^(https:\/\/|git@|ssh:\/\/)/
const CLOUD_CONTAINER = 'iCloud.app.branchling'
const CLOUD_INLINE = 600_000
const SYNC_AFTER_MS = 5_000
let syncGen = 0
let zoneMade = false
let cloudWarned = false

const cloudFile = (h: string) => `${h}/.branchling/cloud.json`
const sentFile = (h: string) => `${h}/.branchling/cloud-sent.json`
const carriedFile = (h: string) => `${h}/.branchling/cloud-carried.json`
const fetchGit = (h: string) => `${h}/.branchling/cloud.git`

async function readCloud($: EngineInterface, h: string): Promise<Cloud | undefined> {
  let c: Cloud
  try {
    c = JSON.parse(await $.fs.read(cloudFile(h)))
  } catch {
    return undefined
  }
  if (!c || !/^[0-9a-f]{64}$/.test(String(c.api)) || String(c.web ?? '').length < 20 || !KEY_RE.test(String(c.key))) return undefined
  if (c.env !== 'development') c.env = 'production'
  if (!/^[a-z0-9]{6,12}$/.test(String(c.device ?? ''))) {
    c.device = Array.from(crypto.getRandomValues(new Uint8Array(5)), b => (b % 36).toString(36)).join('') + 'pc'
    await writeCloud($, h, c)
  }
  return c
}

async function writeCloud($: EngineInterface, h: string, c: Cloud) {
  await $.fs.write(cloudFile(h), JSON.stringify(c, null, 2) + '\n')
  await $.process.run(['chmod', '600', cloudFile(h)])
}

/** The record name the Mac app uses too: "f-" + the path's UTF-8 bytes in hex. */
const recordName = (path: string) => 'f-' + Array.from(new TextEncoder().encode(path), b => b.toString(16).padStart(2, '0')).join('')

const WEB_OFF =
  'Your iCloud keeps its data off the web (Advanced Data Protection), so Claude Code cannot write into it. ' +
  'On the iPhone: Settings › your name › iCloud › turn on "Access iCloud Data on the Web", then copy a new sentence ' +
  'in Branchling › Connect and paste it here. With a Mac, the Branchling Mac app needs no such setting.'

async function cloudCall($: EngineInterface, h: string, c: Cloud, op: string, body: unknown): Promise<any> {
  const url =
    `https://api.apple-cloudkit.com/database/1/${CLOUD_CONTAINER}/${c.env}/private/${op}` +
    `?ckAPIToken=${encodeURIComponent(c.api)}&ckWebAuthToken=${encodeURIComponent(c.web)}`
  const r = await $.http.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  // CloudKit may hand back a renewed web token; keep the newest one.
  for (const [k, v] of Object.entries(r.headers)) {
    if (/web-?auth-?token/i.test(k) && v && v !== c.web) {
      c.web = v
      await writeCloud($, h, c)
    }
  }
  let j: any = {}
  try {
    j = JSON.parse(r.text || '{}')
  } catch {
    // not JSON: judged by the status below
  }
  const code = j.serverErrorCode as string | undefined
  if (r.status === 401 || r.status === 421 || code === 'AUTHENTICATION_REQUIRED' || code === 'AUTHENTICATION_FAILED') {
    throw Object.assign(new Error('auth'), { auth: true })
  }
  if (code === 'ACCESS_DENIED' && /private db access disabled/i.test(String(j.reason ?? ''))) {
    throw Object.assign(new Error('web access off'), { webOff: true })
  }
  if (!r.ok) throw new Error(`${r.status} ${code ?? ''} ${j.reason ?? ''}`.trim())
  return j
}

const git = (dollar: EngineInterface, root: string, args: string[], init: { env?: Record<string, string>; stdin?: string } = {}) =>
  dollar.process.run(['git', '-C', root, ...args], { timeoutMs: 60_000, ...init })

/** Every file of one project, by path relative to ~/.branchling, with a stamp that changes when the file does. */
async function scanProject($: EngineInterface, h: string, project: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (dir: string, rel: string) => {
    let list: Awaited<ReturnType<EngineInterface['fs']['list']>> = []
    try {
      list = await $.fs.list(dir)
    } catch {
      return
    }
    for (const f of list) {
      if (f.name.startsWith('.') || f.isLink) continue
      if (f.kind === 'dir') await walk(`${dir}/${f.name}`, `${rel}/${f.name}`)
      else if (f.kind === 'file') out[`${rel}/${f.name}`] = `${f.size}-${Math.round(f.mtimeMs)}`
    }
  }
  await walk(projectDir(h, project), `projects/${project}`)
  return out
}

/**
 * Brings the sealed entries cloud sessions left on the project repository's `branchling` branch into
 * ~/.branchling/projects/<project>/entries/<file>.sealed, unopened. Only for a repository that carries the recorder;
 * the project's repository itself is only read. Returns how many files came in.
 */
async function carryCloud($: EngineInterface, h: string, pr: Project): Promise<number> {
  const recorder = await $.fs.read(`${pr.root}/.claude/branchling/record.mjs`).then(() => true, () => false)
  if (!recorder) return 0
  const origin = (await git($, pr.root, ['config', '--get', 'remote.origin.url'])).stdout.trim()
  if (!GIT_REMOTE.test(origin)) return 0
  const bare = fetchGit(h)
  try {
    await $.fs.read(`${bare}/HEAD`)
  } catch {
    const init = await $.process.run(['git', 'init', '--quiet', '--bare', bare], { timeoutMs: 30_000 })
    if (init.exitCode !== 0) return 0
  }
  const ref = `refs/cloud/${pr.project}`
  const f = await git($, bare, ['fetch', '--quiet', '--no-tags', origin, `+refs/heads/${BRANCH}:${ref}`])
  if (f.exitCode !== 0) return 0
  let carried: Record<string, string> = {}
  try {
    carried = JSON.parse(await $.fs.read(carriedFile(h)))
  } catch {
    // first time
  }
  let n = 0
  const ls = await git($, bare, ['ls-tree', '-r', ref])
  for (const line of ls.stdout.split('\n')) {
    const m = /^100644 blob ([0-9a-f]{40})\tprojects\/[^/]+\/entries\/([\w.-]+\.cloud-[\w-]+\.jsonl)$/.exec(line)
    if (!m) continue
    const slot = `${pr.project}/${m[2]}`
    if (carried[slot] === m[1]) continue
    const body = await git($, bare, ['cat-file', 'blob', m[1]!])
    if (body.exitCode !== 0) continue
    await $.fs.write(`${projectDir(h, pr.project)}/entries/${m[2]}.sealed`, body.stdout)
    carried[slot] = m[1]!
    n++
  }
  if (n) await $.fs.write(carriedFile(h), JSON.stringify(carried) + '\n')
  return n
}

/**
 * The other way (no Mac app): seals what changed in this project since the last send and writes it into the person's
 * iCloud; deletes the records of files that are gone. Files already sealed (from cloud sessions) go as they are.
 * Entry files carry this computer's id, so two computers never overwrite each other's day.
 */
async function sendProject($: EngineInterface, h: string, c: Cloud, project: string): Promise<number> {
  let sentAll: Record<string, string> = {}
  try {
    sentAll = JSON.parse(await $.fs.read(sentFile(h)))
  } catch {
    // first send
  }
  const target = (path: string) =>
    path.endsWith('.sealed') ? path : path.replace(/(\/entries\/\d{4}-\d{2}-\d{2})\.jsonl$/, `$1.${c.device}.jsonl`) + '.sealed'
  const now = await scanProject($, h, project)
  const prefix = `projects/${project}/`
  const ops: { op: unknown; path: string; stamp?: string }[] = []
  for (const [path, stamp] of Object.entries(now)) {
    if (sentAll[path] === stamp || Number(stamp.split('-')[0]) > CLOUD_INLINE) continue
    const raw = await $.fs.read(`${h}/.branchling/${path}`, { as: 'bytes' })
    const bytes = fromBase64(typeof raw === 'string' ? raw : raw.base64)
    const body = path.endsWith('.sealed') ? bytes : new TextEncoder().encode(toBase64(await seal(fromBase64(c.key), bytes)) + '\n')
    const fields = {
      path: { value: target(path), type: 'STRING' },
      body: { value: toBase64(body), type: 'BYTES' },
      modified: { value: Number(stamp.split('-')[1]) || Date.now(), type: 'TIMESTAMP' },
    }
    ops.push({ op: { operationType: 'forceReplace', record: { recordName: recordName(target(path)), recordType: 'AlmanacFile', fields } }, path, stamp })
  }
  for (const path of Object.keys(sentAll)) {
    if (path.startsWith(prefix) && !(path in now)) ops.push({ op: { operationType: 'forceDelete', record: { recordName: recordName(target(path)) } }, path })
  }
  if (!ops.length) return 0
  if (!zoneMade) {
    await cloudCall($, h, c, 'zones/modify', { operations: [{ operationType: 'create', zone: { zoneID: { zoneName: 'Almanac' } } }] })
    zoneMade = true
  }
  let count = 0
  for (let i = 0; i < ops.length; i += 100) {
    const chunk = ops.slice(i, i + 100)
    const j = await cloudCall($, h, c, 'records/modify', { zoneID: { zoneName: 'Almanac' }, atomic: false, operations: chunk.map(o => o.op) })
    const failed = new Set<string>((j.records ?? []).filter((r: any) => r.serverErrorCode && r.serverErrorCode !== 'NOT_FOUND').map((r: any) => r.recordName))
    for (const o of chunk) {
      if (failed.has(recordName(target(o.path)))) continue
      if (o.stamp) sentAll[o.path] = o.stamp
      else delete sentAll[o.path]
      count++
    }
  }
  await $.fs.write(sentFile(h), JSON.stringify(sentAll) + '\n')
  return count
}

/** Carries cloud-session entries in, then (on the other way) sends the project to iCloud. Returns files sent. */
let deletesAsked = 0

/**
 * Projects deleted on the iPhone (no Mac app here): the iPhone leaves their names in iCloud. A project on this computer
 * is deleted as the Mac's Delete does: its folder goes to the Trash, its folders stop recording, its records leave
 * iCloud. Names this computer does not have stay for another one. Looked at every few minutes at most.
 */
async function takeDeleteRequests($: EngineInterface, h: string, c: Cloud) {
  if (Date.now() - deletesAsked < 3 * 60_000) return
  deletesAsked = Date.now()
  const name = recordName('requests/delete')
  const j = await cloudCall($, h, c, 'records/lookup', { zoneID: { zoneName: 'Almanac' }, records: [{ recordName: name }] })
  const rec = (j.records ?? [])[0]
  if (!rec || rec.serverErrorCode) return
  let names: string[] = []
  try {
    names = JSON.parse(new TextDecoder().decode(fromBase64(rec.fields?.body?.value ?? '')))
  } catch {
    return
  }
  if (!Array.isArray(names) || !names.length) return
  const done: string[] = []
  for (const n of names) {
    if (typeof n !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(n) || !(await $.fs.exists(projectDir(h, n)))) continue
    const trash = (await $.fs.exists(`${h}/.Trash`)) ? `${h}/.Trash` : `${h}/.branchling/trash`
    await $.process.run(['mkdir', '-p', trash])
    const mv = await $.process.run(['mv', projectDir(h, n), `${trash}/${n} ${new Date().toISOString().slice(0, 16).replace(':', '.')}`])
    if (mv.exitCode !== 0) continue
    const aliases = await readAliases($, h)
    for (const [k, v] of Object.entries(aliases)) if (v === n) aliases[k] = null
    aliases[n] = null
    await $.fs.write(`${h}/.branchling/aliases.json`, JSON.stringify(aliases, null, 2) + '\n')
    const links = await readLinks($, h)
    for (const [root, p] of Object.entries(links)) if (p === n) await setLink($, h, root, null)
    for (const [k, p] of workedIn) if (p.project === n) workedIn.delete(k)
    if (lastWorked?.project === n) lastWorked = null
    await sendProject($, h, c, n)
    done.push(n)
  }
  if (!done.length) return
  const rest = names.filter(n => !done.includes(n))
  const op = rest.length
    ? { operationType: 'update', record: { recordName: name, recordType: 'AlmanacFile', recordChangeTag: rec.recordChangeTag,
        fields: { path: { value: 'requests/delete', type: 'STRING' }, body: { value: toBase64(new TextEncoder().encode(JSON.stringify(rest))), type: 'BYTES' } } } }
    : { operationType: 'forceDelete', record: { recordName: name } }
  await cloudCall($, h, c, 'records/modify', { zoneID: { zoneName: 'Almanac' }, atomic: false, operations: [op] })
}

async function syncProject($: EngineInterface, pr: Project): Promise<number> {
  const h = await homeDir($)
  await carryCloud($, h, pr)
  const c = await readCloud($, h)
  if (!c || c.broken) return 0
  try {
    await takeDeleteRequests($, h, c).catch(() => undefined)
    if (!(await $.fs.exists(projectDir(h, pr.project)))) return 0
    return await sendProject($, h, c, pr.project)
  } catch (err: any) {
    if (err?.auth || err?.webOff) {
      c.broken = true
      await writeCloud($, h, c)
    }
    throw err
  }
}

/** A few seconds after the last change, syncs this project. */
function schedulePush($: EngineInterface, pr: Project) {
  const gen = ++syncGen
  $.clock.after(SYNC_AFTER_MS, async () => {
    if (gen !== syncGen) return
    try {
      await syncProject($, pr)
      cloudWarned = false
    } catch (err: any) {
      if (cloudWarned) return
      cloudWarned = true
      $.ui.toast(
        err?.webOff
          ? `Branchling: ${WEB_OFF}`
          : err?.auth
            ? 'Branchling: the iPhone connection has expired. In Branchling › Connect on the iPhone, copy the sentence again and paste it here.'
            : `Branchling could not reach iCloud (${String(err?.message ?? err)}). It tries again after the next change.`,
      )
    }
  })
}

async function phoneCommand($: EngineInterface, h: string, rest: string): Promise<string> {
  const arg = rest.split(/\s+/)[0] ?? ''
  if (arg === 'off') {
    await $.fs.write(cloudFile(h), '{}\n')
    await $.fs.write(sentFile(h), '{}\n')
    return 'This computer no longer writes the almanac into your iCloud. What is already there stays; to remove it, on the iPhone open Settings › your name › iCloud › Manage Account Storage › Branchling › Delete Data. (With a Mac, the Branchling Mac app sends it while it is open.)'
  }
  const c = await readCloud($, h)
  if (!c) {
    return 'This computer does not write into iCloud itself. With a Mac, the Branchling Mac app sends the almanac to your iPhone. Without one, open Branchling › Connect on the iPhone, choose "Another computer" and paste the sentence it shows here.'
  }
  if (c.broken) return 'The iPhone connection has expired or iCloud refused it. In Branchling › Connect on the iPhone, copy the sentence again and paste it here.'
  const pr = lastWorked ?? (await findProject($, await $.session.cwd()))
  if (pr && arg === 'now') {
    try {
      const n = await syncProject($, pr)
      return n ? `Sent ${n} sealed file${n === 1 ? '' : 's'} of "${pr.project}" to your iCloud.` : `"${pr.project}" is up to date in your iCloud.`
    } catch (err: any) {
      return err?.webOff ? WEB_OFF : `Sending failed: ${String(err?.message ?? err)}`
    }
  }
  return 'Connected: a few seconds after each change, the almanac is sealed with your key and written into your own iCloud. Send now: /branchling phone now · stop: /branchling phone off'
}

// ---------- Hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'branchling',
      description: "This project's almanac: today, goal and plan, open problems, manual entries, linking",
      argumentHint: '[plan | phone [now | off] | off | goal <sentence> | tasks | usage | link <name> | progress|problem|hold <text> | ask <text> | approve <no> | solve <no> <text> | open]',
    })
    try {
      await $.tool.register({ name: 'plan', description: PLAN_TOOL_DESC, inputSchema: PLAN_SCHEMA })
      await $.tool.register({ name: 'ask', description: ASK_TOOL_DESC, inputSchema: ASK_SCHEMA })
    } catch {
      // the almanac still works without the tool
    }
    lastUsd = await sessionUsd($)
    await refresh($)
    return next(e)
  })

  // Measures Claude Code's own work in a linked project; never changes the turn.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    try {
      if (e.usage) await recordUsage($, e.usage, e.agentId !== undefined)
    } catch {
      // measuring must never break a turn
    }
    return r
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!note) return r
    return { ...r, sections: [...r.sections, { id: 'branchling:plan', text: note, scope: 'session' as const }] }
  })

  // Answered at tool.call: the tool only reads and writes Branchling's own files under ~/.branchling.
  on('tool.call', async ($, e, next) => {
    if (isAskTool(e.tool)) return handleAsk($, e)
    if (!isPlanTool(e.tool)) {
      const file = (e as unknown as { file_path?: unknown }).file_path
      if ((e.tool === 'Edit' || e.tool === 'Write') && typeof file === 'string' && file.startsWith('/')) {
        findProject($, file.replace(/\/[^/]*$/, ''), true).then(p => { if (p) noteWork(p) }).catch(() => {})
      }
      return next(e)
    }
    const input = e as unknown as WriteInput & { action?: unknown; project?: unknown }
    try {
      const h = await homeDir($)
      const cwd = await $.session.cwd()
      const named = typeof input.project === 'string' && input.project.trim() ? input.project : undefined
      const many = named ? null : whichOne()
      if (many) return { deny: many.replace('Pick one:', 'Ask the user which one, then call again with "project" set to its folder:') }
      const pr = await projectFor($, h, cwd, named)
      if (typeof pr === 'string') return { deny: pr }
      if (!pr) return { deny: notHere(cwd) + ' Ask the user which folder, then call again with "project".' }
      if (input.action === 'read') return { result: await planDigest($, h, pr) }
      if (input.action === 'write') {
        const r = await planWrite($, h, pr, input)
        return 'ok' in r ? { result: r.ok } : { deny: `Plan not saved: ${r.error} Fix it and call write again.` }
      }
      return { deny: 'action must be "read" or "write".' }
    } catch (err) {
      return { deny: `Branchling could not handle the plan: ${String(err)}` }
    }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const started = Math.floor(Date.now() / 1000)
    const ran = await next(e)
    try {
      if (ran.deny !== undefined) return ran
      const h = await homeDir($)
      const cd = e.command.match(CD_PREFIX)
      const cwd = await $.session.cwd()
      const work = segments(e.command.replace(CD_PREFIX, '')).some(s => TEST_S.test(s) || BUILD_S.test(s) || COMMIT_S.test(s) || !!mergeSource(s))
      const pr = await findProject($, cd ? resolvePath(cwd, cd[1], h) : cwd, work)
      if (!pr) return ran
      if (lastWorked?.project !== pr.project) {
        noteWork(pr)
        refresh($).catch(() => {})
      }
      const segs = segments(e.command.replace(CD_PREFIX, ''))
      const output = String(ran.text ?? '')
      const tag = segs.some(s => TEST_S.test(s)) ? 'test' : segs.some(s => BUILD_S.test(s)) ? 'build' : ''
      // A non-zero exit belongs to the test or build only when nothing after it could have failed, or when it
      // printed no sign of passing: "swift test && cat missing.txt" is a passing test and a missing file.
      const toolLast = (tag === 'test' ? TEST_S : BUILD_S).test(segs[segs.length - 1] ?? '')
      const failed = FAIL_MARK.test(output) || (ran.isError === true && (toolLast || !PASS_MARK.test(output)))
      if (tag) {
        const branch = await currentBranch($, pr.root)
        const open = openProblems(await readAll($, h, pr.project)).filter(x => x.tag === tag && x.branch === branch)
        const lang = (await settings($, h)).language ?? 'en'
        const say = AUTO[lang]
        if (failed && !open.length) {
          await add($, h, pr, { branch, kind: 'problem', text: say.broke(tag, failureLine(output)), quote: null, source: 'auto', tag, meta: { lang } })
        } else if (!failed && open.length) {
          await add($, h, pr, { branch, kind: 'solution', text: say.again(tag), quote: open[open.length - 1].id, source: 'auto', tag, meta: { lang } })
        }
        // No return: "swift test && git commit" also commits, read on.
      }

      // Commits and merges are read back from git, not from the output: a word like "error:" printed by
      // something else in the same command must not hide them, and one command may commit several times.
      const commits = segs.some(s => COMMIT_S.test(s))
      const mergeFrom = segs.map(mergeSource).find(Boolean)
      if (commits || mergeFrom) {
        const known = new Set((await readAll($, h, pr.project)).map(x => x.tag))
        const branch = await currentBranch($, pr.root)
        if (commits) {
          // Branch names as git printed them, "[feature/x 1a2b3c4] subject", for commits made before a checkout.
          const printed = [...output.matchAll(/\[([^\]\s]+)(?: \(root-commit\))? ([0-9a-f]{7,})\]/g)].map(m => ({ branch: m[1], hash: m[2] }))
          const g = await $.process.run(['git', '-C', pr.root, 'log', '-n', '20', '--no-merges', '--format=%h%x09%ct%x09%s'])
          if (g.exitCode === 0) {
            const fresh = g.stdout
              .trim()
              .split('\n')
              .map(l => l.split('\t'))
              .filter(([hash, ct]) => hash && Number(ct) >= started - 2 && !known.has('commit:' + hash))
              .reverse()
            for (const [hash, , ...rest] of fresh) {
              const subject = rest.join('\t')
              const onBranch = printed.find(p => p.hash.startsWith(hash) || hash.startsWith(p.hash))?.branch ?? (await homeBranch($, pr.root, hash ?? "", branch, mergeFrom))
              const task = TASK_TAG.exec(subject)?.[1]
              await add($, h, pr, { branch: onBranch, kind: 'progress', text: subject, quote: null, source: 'commit', tag: 'commit:' + hash, task })
            }
          }
        }
        if (mergeFrom && (await mergedNow($, pr.root, mergeFrom, started, ran.isError !== true && !/Already up to date|CONFLICT|Automatic merge failed|not something we can merge/i.test(output)))) {
          const mergeLang = (await settings($, h)).language ?? 'en'
          await add($, h, pr, { branch, kind: 'progress', text: AUTO[mergeLang].merged(mergeFrom, branch), quote: null, source: 'merge', tag: 'merge', meta: { from: mergeFrom, lang: mergeLang } })
        }
        return ran
      }
    } catch {
      // Branchling never changes a tool's result
    }
    return ran
  })

  on('command.run', { command: 'branchling' }, async ($, e) => {
    const h = await homeDir($)
    const cwd = await $.session.cwd()
    const [sub = '', ...restParts] = (e.args ?? '').trim().split(/\s+/)
    const rest = restParts.join(' ').trim()

    if (sub === 'link') {
      if (!rest) return { text: 'Usage: /branchling link <project name> [folder]' }
      // "/branchling link Ortak Masa ~/Projects/katilim-app": a last word that is a path names the folder.
      const words = rest.split(/\s+/)
      const dirWord = words.length > 1 && /^[~/.]/.test(words[words.length - 1] ?? "") ? words.pop() : undefined
      const dir = dirWord ? resolvePath(cwd, dirWord, h) : cwd
      if (dirWord && !(await $.fs.exists(dir))) return { text: `${dir} does not exist.` }
      const g = await $.process.run(['git', '-C', dir, 'rev-parse', '--show-toplevel'])
      const root = g.exitCode === 0 && g.stdout.trim() ? g.stdout.trim() : dir
      if (root === h) return { text: 'This is your home folder. Name the project folder: /branchling link <name> <folder>' }
      const project = slug(words.join(' ')) || 'project'
      const aliases = await readAliases($, h)
      if (project in aliases) {
        delete aliases[project]
        await $.fs.write(`${h}/.branchling/aliases.json`, JSON.stringify(aliases, null, 2) + '\n')
      }
      if (await $.fs.exists(`${root}/.branchling.json`)) {
        await $.fs.write(`${root}/.branchling.json`, JSON.stringify({ project }, null, 2) + '\n')
      } else {
        await setLink($, h, root, project)
      }
      await refresh($)
      return { text: `${root} is now linked to the "${project}" almanac. Tests, builds, commits and merges there are recorded automatically. Next: /branchling plan ${dirWord ? project : ''}`.trimEnd() }
    }

    if (sub === 'phone') return { text: await phoneCommand($, h, rest) }

    if (sub === 'off') {
      // "/branchling off" (this folder), "/branchling off ~/Projects/app" (a folder) or "/branchling off ortak-masa" (every folder of a project).
      let roots: string[]
      if (rest && !/^[~/.]/.test(rest)) {
        const name = slug(rest)
        const links = await readLinks($, h)
        roots = Object.keys(links).filter(r => links[r] === name)
        if (!roots.length) return { text: `No folder records into "${name}".` }
      } else {
        const dir = rest ? resolvePath(cwd, rest, h) : cwd
        const root = (await gitRoot($, dir)) ?? dir
        if (root === h) return { text: 'This is your home folder. Name what to stop: /branchling off <folder> or /branchling off <project name>' }
        roots = [root]
      }
      for (const root of roots) {
        if (await $.fs.exists(`${root}/.branchling.json`)) return { text: `${root} is linked by ${root}/.branchling.json; delete that file to leave Branchling.` }
        await setLink($, h, root, null)
        for (const [k, p] of workedIn) if (p.root === root) workedIn.delete(k)
        if (lastWorked?.root === root) lastWorked = null
      }
      await refresh($)
      return { text: `${roots.join(', ')} no longer recorded. What was recorded stays in the app; to record again: /branchling link <name> <folder>` }
    }

    if (sub === 'plan' && !rest) {
      const many = whichOne()
      if (many) return { text: many }
    }
    let found = await projectFor($, h, cwd, sub === 'plan' ? rest : undefined)
    if (typeof found === 'string') return { text: found }
    let guessed = false
    if (!found && sub === 'plan') {
      const root = await gitRoot($, cwd)
      if (root && root !== h) {
        found = { root, project: slug(root.split('/').pop() ?? '') || 'project' }
        guessed = true
      }
    }
    if (!found) return { text: notHere(cwd) }
    const pr = found
    const es = await readAll($, h, pr.project)
    const open = openProblems(es)

    if (sub === 'plan') {
      // A command can't submit while it holds the turn: queue the prompt just after it answers.
      const ask = {
        text:
          `Write the Branchling plan for the project "${pr.project}" in ${pr.root}. Call the Branchling plan tool (mcp__…__plan, load it with ToolSearch \"branchling plan\" if it is not loaded) with action "read" and project "${pr.root}", ` +
          `look at that repository only as much as you need, then call it with action "write", project "${pr.root}" and the whole plan. ` +
          (await (async () => {
            const links = await readLinks($, h)
            const others = Object.keys(links).filter(r => links[r] === pr.project && r !== pr.root)
            return others.length ? `The project spans more folders, all one plan: ${others.join(', ')}; look at them too as far as the plan needs. ` : ''
          })()) +
          (rest
            ? ''
            : `Branchling chose ${pr.root} ${guessed ? 'only because this session was opened there' : 'because it is the only project this session worked in'}. ` +
              `If this conversation is working on a different project, use that project's folder as "project" instead; ` +
              `if that project has no git repository yet, write nothing and tell the user to run "git init" in its folder, then /branchling plan <folder>. `) +
          `${languageRule((await settings($, h)).language)} ` +
          `Finish with the goal sentence and the progress in one line.`,
      }
      $.clock.after(50, () => {
        $.prompt.submit(ask).catch(() => $.ui.toast('Branchling could not ask Claude for the plan; ask it to call the Branchling plan tool.'))
      })
      return { text: 'Asking Claude to write the plan with your own session…' }
    }

    if (sub === 'goal') {
      if (!rest) return { text: 'Usage: /branchling goal <one punchy sentence, at most 90 characters>' }
      if (rest.length > 90) return { text: `That is ${rest.length} characters; keep the goal to 90.` }
      await appendLine($, `${projectDir(h, pr.project)}/plan.app.jsonl`, { at: new Date().toISOString(), source: 'command', goal: rest })
      await refresh($)
      return { text: `Goal set and locked: "${rest}". Claude keeps it when refreshing the plan.` }
    }

    const eff = await effective($, h, pr.project, es)
    const pct = percentOf(eff.tasks)

    if (sub === 'usage') {
      const us = await readUsage($, h, pr.project)
      if (!us.length) return { text: 'No Claude usage measured here yet. Every Claude Code turn in this folder is counted from now on.' }
      const t = today()
      const weekAgo = localDay(new Date(Date.now() - 6 * 86_400_000))
      const row = (name: string, ls: UsageLine[]) => {
        const x = usageSum(ls)
        return `  ${name.padEnd(10)} ${String(x.turns).padStart(5)} turns · ${tokens(x.fresh).padStart(6)} new in · ${tokens(x.read).padStart(6)} cached in · ${tokens(x.output).padStart(6)} out`
      }
      const all = usageSum(us)
      const done = eff.tasks.filter(x => x.status === 'done' && x.doneAt && x.doneAt >= us.map(u => u.date).sort()[0]).length
      const byBranch = [...new Set(us.map(u => u.branch))].map(b => row(b, us.filter(u => u.branch === b)))
      return {
        text: [
          `Claude Code usage in ${pr.project} (measured since ${us.map(u => u.date).sort()[0]}, ${all.sessions} session${all.sessions > 1 ? 's' : ''})`,
          row('today', us.filter(u => u.date === t)),
          row('7 days', us.filter(u => u.date >= weekAgo)),
          row('all', us),
          `By branch:`,
          ...byBranch,
          done ? `Per finished task: ~${tokens(Math.round((all.fresh + all.read + all.output) / done))} tokens (${done} task${done > 1 ? 's' : ''} done since measuring began)` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      }
    }

    if (sub === 'tasks') {
      if (!eff.tasks.length) return { text: 'No planned tasks yet. Run /branchling plan.' }
      const mark: Record<Status, string> = { todo: '▢', doing: '▶', blocked: '⛔', done: '✓', dropped: '–' }
      return {
        text: `${eff.goal ?? pr.project} · ${pct ?? 0}%\n${eff.tasks.map(t => `  ${mark[t.status]} ${t.id} ${t.title} (${t.size}${t.branch ? `, ${t.branch}` : ''})`).join('\n')}\n\nA commit whose subject ends with [t3] closes task t3.`,
      }
    }

    if (sub === 'progress' || sub === 'problem' || sub === 'pause' || sub === 'hold') {
      const kind: Kind = sub === 'hold' ? 'pause' : sub
      if (!rest) return { text: `Usage: /branchling ${sub} <one line>` }
      const x = await add($, h, pr, { branch: await currentBranch($, pr.root), kind, text: rest, quote: null, source: 'manual', tag: 'manual', task: TASK_TAG.exec(rest)?.[1] })
      return { text: `Recorded: ${LABEL[x.kind]} ${signed(POINTS[x.kind])} · ${x.text}` }
    }

    if (sub === 'solve') {
      const [no, ...comment] = restParts
      const p = open[Number(no) - 1]
      if (!p || !comment.length) return { text: 'Usage: /branchling solve <open problem no> <one line>. Numbers: /branchling open' }
      const x = await add($, h, pr, { branch: p.branch, kind: 'solution', text: comment.join(' '), quote: p.id, source: 'manual', tag: p.tag })
      return { text: `Solved (+2): "${p.text}" → ${x.text}` }
    }

    const wait = waiting(es)

    if (sub === 'ask') {
      if (!rest) return { text: 'Usage: /branchling ask <what needs approving>' }
      const x = await add($, h, pr, { branch: await currentBranch($, pr.root), kind: 'pause', text: rest, quote: null, source: 'manual', tag: 'approval' })
      return { text: `Waiting for approval: ${x.text}` }
    }

    if (sub === 'approve') {
      const [no, ...comment] = restParts
      const a = wait.approvals[Number(no) - 1]
      if (!a) return { text: 'Usage: /branchling approve <no> [what was decided]. Numbers: /branchling open' }
      await add($, h, pr, { branch: a.branch, kind: 'progress', text: comment.join(' ') || `Approved: ${a.text}`, quote: a.id, source: 'manual', tag: 'approved' })
      return { text: `Approved: ${a.text}` }
    }

    const openText = open.length ? open.map((x, i) => `  ${i + 1}. ${x.date} · ${x.branch} · ${x.text}`).join('\n') : '  No open problems.'
    if (sub === 'open') {
      const list = (xs: Entry[]) => xs.map((x, i) => `  ${i + 1}. ${x.date} · ${x.branch} · ${x.text}`).join('\n')
      return {
        text: [
          `Open problems (${pr.project}):\n${openText}`,
          wait.approvals.length ? `Waiting for approval (/branchling approve <no>):\n${list(wait.approvals)}` : '',
          wait.holds.length ? `On hold:\n${list(wait.holds)}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      }
    }

    const t = today()
    const todays = es.filter(x => x.date === t)
    const pts = scoreAll(es)
    const total = sumPoints(pts, es)
    const day = sumPoints(pts, todays)
    const list = todays.length
      ? todays.map(x => `  ${signed(pts.get(x.id) ?? POINTS[x.kind]).padStart(2)} ${LABEL[x.kind]} · ${x.branch} · ${x.text}`).join('\n')
      : '  Nothing recorded today yet.'
    const nextUp = remaining(eff.tasks).slice(0, 3)
    const head = eff.goal
      ? `${eff.goal}\n${pct ?? 0}% done${nextUp.length ? ` · next: ${nextUp.map(x => `${x.id} ${x.title}`).join(' · ')}` : ''}\n\n`
      : 'No goal yet: /branchling plan\n\n'
    return {
      text: `${head}Branchling · ${pr.project}: today ${signed(day)}, momentum ${signed(total)} (${es.length} entries)\n${list}\nOpen problems:\n${openText}\n\nPlan: /branchling plan · Tasks: /branchling tasks · Claude usage: /branchling usage · Manual: /branchling progress|problem|hold <text> · Solve: /branchling solve <no> <text>`,
    }
  })
}
