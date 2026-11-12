/**
 * Finder - search, organise, and manage Projects & Sessions, as a dock TAB.
 *
 * Docks in the Sessions strip (SESSIONS | BOTS | FINDER). Tabs:
 *   - All      : collections of projects (incl. the project-less bucket), expandable.
 *   - Projects : collections of real projects, each expandable to its sessions.
 *   - Sessions : a FLAT list of every session (project shown as a tag).
 *
 * Search matches project names (core can't) + session text, bridged by project.
 * Collections (groups): every project lives in a group; the default is
 *   "General projects". Add, rename, recolour, delete groups; move projects
 *   between them. Pins, a sort toggle, a privacy (blur) mode, and multi-select
 *   bulk actions (archive / colour / move) are all available.
 *
 * Data: `projects.tree` RPC (session.list fallback). Live refresh on
 * `projects.changed` / `sessions.changed`. State persists in ctx.storage.
 *
 * Install: $HERMES_HOME/desktop-plugins/finder/plugin.js  (folder name == id).
 * Reload with Cmd/Ctrl+K -> "Reload desktop plugins".
 * Plain ESM, loaded uncompiled - UI is jsx() calls, not JSX syntax.
 */

import {
  Badge,
  Codicon,
  cn,
  compactNumber,
  EmptyState,
  host,
  KEYBINDS_AREA,
  PALETTE_AREA,
  ScrollArea,
  SearchField,
  Tip,
  useQuery,
  useQueryClient,
  useValue,
  writeClipboardText
} from '@hermes/plugin-sdk'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'finder'
const PANE_ID = `${ID}:pane`
const PREVIEW_LIMIT = 2000
const SESSION_LIMIT = 5000
const FLAT_CAP = 600
const PROJECT_SESSION_PREVIEW = 3
const GROUP_PROJECT_PREVIEW = 3

const ORDER_KEY = 'projectOrder'
const STATS_KEY = 'showStats'
const SCOLORS_KEY = 'sessionColors'
const PINP_KEY = 'pinnedProjects'
const PINS_KEY = 'pinnedSessions'
const UNREAD_KEY = 'unreadSessions'
const SORT_KEY = 'sortKey'
const PRIVACY_KEY = 'privacy'
const BLURP_KEY = 'blurProjects'
const BLURG_KEY = 'blurGroups'
const GROUPS_KEY = 'groups'
const GROUPOF_KEY = 'groupOf'
const COLLAPSED_KEY = 'collapsedGroups'


const DEFAULT_GROUP_ID = 'general'
const DEFAULT_GROUP_NAME = 'General projects'

const SORTS = [
  ['manual', 'Custom order'],
  ['recent', 'Last active'],
  ['name', 'Name (A to Z)'],
  ['tokens', 'Token use'],
  ['cost', 'Cost']
]
const SORT_LABEL = Object.fromEntries(SORTS)

const COLOR_PRESETS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6',
  '#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#64748b'
]

const BLUR = 'finder-blur'
const BLUR_STYLE_ID = 'finder-blur-style'

// The app ships only the Tailwind classes its OWN source uses, so a runtime
// plugin's `blur-sm`/`hover:blur-none` never land in the compiled CSS. Inject
// our own class (filter + hover-reveal) once so privacy blur actually renders.
function ensureBlurStyle() {
  try {
    if (typeof document === 'undefined' || document.getElementById(BLUR_STYLE_ID)) return
    const el = document.createElement('style')
    el.id = BLUR_STYLE_ID
    el.textContent = [
      '.finder-blur{filter:blur(6px);transition:filter .15s ease}.finder-blur:hover{filter:none}'
    ].join('')
    document.head.appendChild(el)
  } catch {}
}

let storage = null
let pluginOs = null
let pluginFiles = null

// The palette command and keybind run OUTSIDE the React tree, so a direct
// storage write would not update the mounted pane (usePersisted only reads on
// mount). Notify live panes through this tiny bus.
const privacyListeners = new Set()
function broadcastPrivacy(val) {
  privacyListeners.forEach(fn => {
    try {
      fn(val)
    } catch {}
  })
}

// -- hyperscript: key -> 3rd jsx arg; jsxs for an array child. -------------------
function h(type, props, ...kids) {
  const p = props ? { ...props } : {}
  let key
  if (p.key !== undefined) {
    key = p.key
    delete p.key
  }
  if (kids.length) {
    p.children = kids.length === 1 ? kids[0] : kids
  }
  return Array.isArray(p.children) ? jsxs(type, p, key) : jsx(type, p, key)
}

// -- formatting ------------------------------------------------------------------
function relativeTime(tsSeconds) {
  if (!tsSeconds) return ''
  const sec = Math.max(0, Date.now() / 1000 - tsSeconds)
  if (sec < 45) return 'just now'
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m ago`
  const hr = Math.floor(m / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  if (d < 7) return `${d}d ago`
  const w = Math.floor(d / 7)
  if (w < 5) return `${w}w ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(d / 365)}y ago`
}

function basename(p) {
  if (!p) return ''
  const parts = String(p).replace(/[/\\]+$/, '').split(/[/\\]/)
  return parts[parts.length - 1] || p
}

function fmtTokens(n) {
  if (!n) return ''
  try {
    return `${compactNumber(n)} tok`
  } catch {
    return `${n} tok`
  }
}

function fmtCost(n) {
  if (!n || n <= 0) return ''
  return `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`
}

function highlight(text, needle) {
  const value = text == null ? '' : String(text)
  if (!needle) return value
  const lower = value.toLowerCase()
  const out = []
  let i = 0
  let k = 0
  let idx = lower.indexOf(needle, i)
  while (idx !== -1) {
    if (idx > i) out.push(value.slice(i, idx))
    out.push(
      h('span', {
        key: `m${k++}`,
        className: 'rounded-[2px] px-[1px] text-foreground',
        style: { backgroundColor: 'color-mix(in srgb, var(--ui-accent) 28%, transparent)' },
        children: value.slice(idx, idx + needle.length)
      })
    )
    i = idx + needle.length
    idx = lower.indexOf(needle, i)
  }
  if (i < value.length) out.push(value.slice(i))
  return out.length ? out : value
}

function intentFromEvent(e) {
  if (e && e.shiftKey) return 'window'
  if (e && (e.metaKey || e.ctrlKey)) return 'tab'
  return 'stack'
}

function openSession(id, intent) {
  if (!id) return
  Promise.resolve(host.openSession(id, { intent: intent || 'stack', expectHistory: true })).catch(err => {
    host.notify({ kind: 'error', message: `Could not open session: ${err?.message || err}` })
  })
}

function copyText(text, okMsg) {
  if (!text) return
  const ok = () => host.notify({ kind: 'success', message: okMsg || 'Copied' })
  const fail = () => host.notify({ kind: 'error', message: 'Could not copy to clipboard' })
  try {
    Promise.resolve(writeClipboardText(text))
      .then(res => (res === false ? fail() : ok()))
      .catch(() => {
        try {
          navigator.clipboard.writeText(text).then(ok, fail)
        } catch {
          fail()
        }
      })
  } catch {
    try {
      navigator.clipboard.writeText(text).then(ok, fail)
    } catch {
      fail()
    }
  }
}

function copyId(id) {
  if (id) copyText(id, 'Session id copied')
}

function openSessionInTerminal(sessionId, cwd) {
  // The public plugin SDK currently exposes no terminal-session door. Use the
  // same host capability as Hermes' built-in session menu when available.
  const opener = globalThis.hermesDesktop?.openSessionInTerminal
  if (typeof opener !== 'function') {
    host.notify({ kind: 'warning', message: 'Opening a session in the terminal is unavailable in this desktop build.' })
    return
  }
  Promise.resolve(opener(sessionId, { cwd: cwd || undefined }))
    .then(result => {
      if (result && result.ok === false) host.notify({ kind: 'error', message: result.error || 'Could not open the session in the terminal.' })
    })
    .catch(err => host.notify({ kind: 'error', message: `Could not open terminal: ${err?.message || err}` }))
}

function relativeFolderPath(root, folder) {
  const clean = value => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  const base = clean(root)
  const target = clean(folder)
  if (target === base) return ''
  const prefix = base === '/' ? '/' : `${base}/`
  return target.startsWith(prefix) ? target.slice(prefix.length) : null
}

async function writeProjectIdeaFile(folderPath, projectName, idea) {
  const goal = String(idea || '').trim()
  const folder = String(folderPath || '').trim()
  if (!goal || !folder || !pluginFiles || typeof pluginFiles.folders !== 'function') return false
  try {
    let grant = (await pluginFiles.folders()).find(item => relativeFolderPath(item.path, folder) !== null)
    if (!grant && typeof pluginFiles.requestFolder === 'function') {
      const picked = await pluginFiles.requestFolder()
      if (picked && picked.ok && picked.folder && relativeFolderPath(picked.folder.path, folder) !== null) grant = picked.folder
    }
    if (!grant || typeof pluginFiles.writeText !== 'function') {
      host.notify({ kind: 'warning', message: 'Grant Finder access to the project folder to create idea.md.' })
      return false
    }
    const relative = relativeFolderPath(grant.path, folder)
    const file = relative ? `${relative}/idea.md` : 'idea.md'
    const title = String(projectName || 'Project').trim() || 'Project'
    const result = await pluginFiles.writeText(grant.id, file, `# ${title}\n\n${goal}\n`)
    if (!result || result.ok === false) throw new Error(result?.message || result?.error || 'folder access denied')
    return true
  } catch (err) {
    host.notify({ kind: 'warning', message: `Could not write idea.md: ${err?.message || err}` })
    return false
  }
}

// -- persisted plugin state (ctx.storage is sync) --------------------------------
function usePersisted(key, fallback) {
  const [value, setValue] = useState(() => {
    try {
      return storage ? storage.get(key, fallback) : fallback
    } catch {
      return fallback
    }
  })
  const set = useCallback(
    next => {
      setValue(prev => {
        const resolved = typeof next === 'function' ? next(prev) : next
        try {
          storage && storage.set(key, resolved)
        } catch {}
        return resolved
      })
    },
    [key]
  )
  return [value, set]
}

// -- groups helpers --------------------------------------------------------------
function ensureGroups(list) {
  const arr = Array.isArray(list) ? list.filter(g => g && g.id && g.name) : []
  if (!arr.some(g => g.id === DEFAULT_GROUP_ID)) {
    arr.unshift({ id: DEFAULT_GROUP_ID, name: DEFAULT_GROUP_NAME })
  }
  return arr
}

function newGroupId() {
  return `g_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

// -- data ----------------------------------------------------------------------
function normalizeNode(node) {
  return {
    id: node.id,
    name: node.label || '(unnamed project)',
    path: node.path || null,
    color: node.color || null,
    icon: node.icon || null,
    isAuto: Boolean(node.isAuto),
    isNoProject: Boolean(node.isNoProject),
    editable: typeof node.id === 'string' && node.id.startsWith('p_'),
    sessionCount: typeof node.sessionCount === 'number' ? node.sessionCount : (node.previewSessions || []).length,
    lastActive: node.lastActive || 0,
    totalTokens: node.totalTokens || 0,
    totalCostUsd: node.totalCostUsd || 0,
    sessions: (node.previewSessions || []).map(s => ({
      id: s.id,
      title: s.title || '',
      preview: s.preview || '',
      cwd: s.cwd || '',
      gitBranch: s.git_branch || '',
      gitRepoRoot: s.git_repo_root || '',
      source: s.source || '',
      model: s.model || '',
      messageCount: s.message_count || 0,
      tokens: (s.input_tokens || 0) + (s.output_tokens || 0),
      pinned: Boolean(s.pinned),
      unread: Boolean(s.unread),
      lastActive: s.last_active || s.started_at || 0
    })),
    idea: node.idea || node.description || ''
  }
}

function useProjectTree(profile) {
  return useQuery({
    queryKey: ['finder', 'tree', profile || 'default'],
    staleTime: 4000,
    refetchInterval: 20000,
    queryFn: async () => {
      try {
        const res = await host.request('projects.tree', { preview_limit: PREVIEW_LIMIT, session_limit: SESSION_LIMIT })
        return { mode: 'tree', projects: (res?.projects || []).map(normalizeNode) }
      } catch (treeErr) {
        const res = await host.request('session.list', { limit: PREVIEW_LIMIT, include_hidden: false })
        const rows = res?.sessions || []
        return {
          mode: 'flat',
          treeError: treeErr?.message || String(treeErr),
          projects: [
            normalizeNode({
              id: '__all__',
              label: 'All sessions',
              isNoProject: true,
              sessionCount: rows.length,
              lastActive: rows.reduce((m, r) => Math.max(m, r.started_at || 0), 0),
              previewSessions: rows
            })
          ]
        }
      }
    }
  })
}

// -- matching ------------------------------------------------------------------
function projectMatches(proj, needle) {
  if (!needle) return true
  return proj.name.toLowerCase().includes(needle) || (proj.path || '').toLowerCase().includes(needle)
}

function sessionText(s) {
  return [s.title, s.preview, s.cwd, s.gitBranch, s.gitRepoRoot, s.source, s.model, s.ownerName]
    .filter(Boolean)
    .join(' \u0001 ')
    .toLowerCase()
}

// -- sorting -------------------------------------------------------------------
function sortProjects(list, sortKey, order, pinned) {
  const manual = p => {
    const i = order.indexOf(p.id)
    return i === -1 ? [1, -(p.lastActive || 0)] : [0, i]
  }
  return list.slice().sort((a, b) => {
    const pa = pinned[a.id] ? 0 : 1
    const pb = pinned[b.id] ? 0 : 1
    if (pa !== pb) return pa - pb
    switch (sortKey) {
      case 'name':
        return a.name.localeCompare(b.name)
      case 'tokens':
        return (b.totalTokens || 0) - (a.totalTokens || 0)
      case 'cost':
        return (b.totalCostUsd || 0) - (a.totalCostUsd || 0)
      case 'recent':
        return (b.lastActive || 0) - (a.lastActive || 0)
      default: {
        const ra = manual(a)
        const rb = manual(b)
        return ra[0] - rb[0] || ra[1] - rb[1]
      }
    }
  })
}

function sortSessions(list, sortKey, pinned) {
  return list.slice().sort((a, b) => {
    const pa = pinned[a.id] || a.pinned ? 0 : 1
    const pb = pinned[b.id] || b.pinned ? 0 : 1
    if (pa !== pb) return pa - pb
    switch (sortKey) {
      case 'name':
        return (a.title || '').localeCompare(b.title || '')
      case 'tokens':
      case 'cost':
        return (b.tokens || 0) - (a.tokens || 0)
      default:
        return (b.lastActive || 0) - (a.lastActive || 0)
    }
  })
}

// -- live context meter for the open chat ----------------------------------------
function ActiveContextChip() {
  const usage = useValue(host.state.focusedUsage)
  const focusedId = useValue(host.state.focusedStoredSessionId)
  const pct =
    usage && typeof usage.context_percent === 'number' ? Math.max(0, Math.min(100, usage.context_percent)) : null
  if (!focusedId || pct == null) return null
  const tone = pct >= 85 ? '#ef4444' : pct >= 60 ? '#eab308' : 'var(--ui-accent)'
  return h(
    Tip,
    { label: `Open chat context: ${pct.toFixed(0)}% of window used${usage.cost_usd ? ` · ${fmtCost(usage.cost_usd)}` : ''}` },
    h(
      'div',
      { className: 'flex items-center gap-1 rounded-md border border-(--ui-stroke-secondary) px-1.5 py-0.5' },
      h(Codicon, { name: 'dashboard', size: '0.75rem', className: 'text-(--ui-text-tertiary)' }),
      h('span', { className: 'text-[0.625rem] tabular-nums text-(--ui-text-secondary)' }, `${pct.toFixed(0)}%`),
      h(
        'span',
        { className: 'h-1 w-8 overflow-hidden rounded-full bg-(--ui-stroke-secondary)' },
        h('span', { className: 'block h-full rounded-full', style: { width: `${pct}%`, backgroundColor: tone } })
      )
    )
  )
}

// -- session row -----------------------------------------------------------------
function renderSession(s, ops, blur) {
  const { needle, showStats, focusedId, focusedBusy, flat, sessionColors, unreadSessions, selectMode, selected } = ops
  const active = s.id === focusedId
  const running = active && focusedBusy
  const isSel = selectMode && selected && selected.has(s.id)
  const unread = unreadSessions && Object.prototype.hasOwnProperty.call(unreadSessions, s.id)
    ? Boolean(unreadSessions[s.id])
    : Boolean(s.unread)
  const pinnedHere = (ops.pinnedSessions && ops.pinnedSessions[s.id]) || s.pinned
  const customColor = sessionColors && sessionColors[s.id]
  const title = s.title || '(untitled)'
  const metaBits = []
  if (flat && s.ownerName) metaBits.push(s.ownerName)
  if (s.lastActive) metaBits.push(relativeTime(s.lastActive))
  if (s.messageCount) metaBits.push(`${s.messageCount} msg${s.messageCount === 1 ? '' : 's'}`)
  if (showStats && s.tokens) metaBits.push(fmtTokens(s.tokens))
  if (s.gitBranch) metaBits.push(s.gitBranch)
  else if (!flat && s.cwd) metaBits.push(basename(s.cwd))
  if (active) metaBits.push('open now')

  const dotStyle = customColor ? { backgroundColor: customColor } : undefined
  const lead = selectMode
    ? h(
        'span',
        {
          className: cn(
            'mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded border',
            isSel ? 'border-(--ui-accent) bg-(--ui-accent)' : 'border-(--ui-stroke-secondary)'
          )
        },
        isSel ? h(Codicon, { name: 'check', size: '0.6875rem', className: 'text-white' }) : null
      )
    : h('span', {
        className: cn(
          'mt-1.5 size-1.5 shrink-0 rounded-full',
          !customColor && (active || unread) ? 'bg-(--ui-accent)' : '',
          !customColor && !active && !unread ? 'bg-(--ui-text-quaternary) opacity-50' : ''
        ),
        style: dotStyle
      })

  return h(
    'button',
    {
      key: s.id,
      type: 'button',
      title: s.title || s.cwd || title,
      onClick: e => {
        if (selectMode) ops.onToggleSelect(s.id)
        else openSession(s.id, intentFromEvent(e))
      },
      onContextMenu: e => {
        e.preventDefault()
        e.stopPropagation()
        ops.onSessionMenu(e.clientX, e.clientY, s)
      },
      className: cn(
        'group/sess relative flex w-full items-start gap-2 overflow-hidden rounded-md py-1.5 text-left transition-[background-color,box-shadow,transform] duration-200 ease-out hover:translate-x-0.5 hover:shadow-[inset_2px_0_0_var(--ui-accent)]',
        flat ? 'px-2' : 'pl-6 pr-2',
        isSel ? 'bg-(--chrome-action-hover)' : active ? 'bg-(--ui-row-active-background)' : 'hover:bg-(--chrome-action-hover)'
      )
    },
    running ? h('span', { 'aria-hidden': 'true', className: 'arc-border arc-row' }) : null,
    lead,
    h(
      'span',
      { className: 'flex min-w-0 flex-1 flex-col' },
      h(
        'span',
        { className: 'flex items-center gap-1.5' },
        pinnedHere ? h(Codicon, { name: 'pinned', size: '0.75rem', className: 'shrink-0 text-(--ui-text-quaternary)' }) : null,
        h(
          'span',
          {
            className: cn(
              'min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[0.8125rem] leading-tight',
              s.title ? 'text-(--ui-text-secondary)' : 'text-(--ui-text-quaternary) italic',
              blur && BLUR
            ),
            title
          },
          highlight(title, needle)
        )
      ),
      s.preview
        ? h('span', { className: cn('min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[0.6875rem] leading-tight text-(--ui-text-quaternary)', blur && BLUR), title: s.preview }, highlight(s.preview, needle))
        : null,
      metaBits.length
        ? h(
            'span',
            { className: 'mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.625rem] leading-tight text-(--ui-text-quaternary)' },
            ...metaBits.map((bit, index) => h('span', { key: `meta-${index}`, className: 'min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap', title: bit }, bit))
          )
        : null
    )
  )
}

// -- project node ----------------------------------------------------------------
function renderGroup(group, ops) {
  const { needle, showStats, dragOverId, canOrder } = ops
  const expanded = ops.isExpanded(group.id)
  const blur = ops.isBlurred ? ops.isBlurred(group.id) : false
  const pinnedHere = ops.pinnedProjects && ops.pinnedProjects[group.id]
  const dotStyle = group.color ? { backgroundColor: group.color } : undefined
  const chevron = expanded ? 'chevron-down' : 'chevron-right'
  const iconName = group.isNoProject ? 'inbox' : group.isAuto ? 'git-branch' : 'folder'
  const draggable = canOrder && !group.isNoProject

  const statsParts = showStats ? [fmtTokens(group.totalTokens), fmtCost(group.totalCostUsd)].filter(Boolean) : []

  const header = h(
    'div',
    {
      className: cn(
        'flex items-center gap-0.5 rounded-md pr-1 transition-[background-color,box-shadow,transform] duration-200 ease-out hover:translate-x-0.5 hover:shadow-[inset_2px_0_0_var(--ui-accent)]',
        dragOverId === group.id && 'ring-1 ring-(--ui-accent)'
      ),
      onContextMenu: group.isNoProject
        ? undefined
        : e => {
            e.preventDefault()
            e.stopPropagation()
            ops.onProjectMenu(e.clientX, e.clientY, group)
          },
      onDragOver: draggable
        ? e => {
            e.preventDefault()
            try {
              e.dataTransfer.dropEffect = 'move'
            } catch {}
            ops.onDragOver(group.id)
          }
        : undefined,
      onDrop: draggable
        ? e => {
            e.preventDefault()
            ops.onDrop(group.id)
          }
        : undefined,
      onDragEnd: canOrder ? () => ops.onDragOver(null) : undefined
    },
    draggable
      ? h(
          'span',
          {
            draggable: true,
            title: 'Drag to reorder',
            onDragStart: e => {
              ops.onDragStart(group.id)
              try {
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', group.id)
              } catch {}
            },
            className: 'flex cursor-grab items-center px-0.5 text-(--ui-text-quaternary) active:cursor-grabbing'
          },
          h(Codicon, { name: 'gripper', size: '0.8125rem' })
        )
      : null,
    h(
      'button',
      {
        type: 'button',
        onClick: () => ops.onToggle(group.id),
        title: group.name || group.path,
        className: cn(
          'flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden rounded-md px-1 py-1.5 text-left transition-colors',
          'hover:bg-(--chrome-action-hover)'
        )
      },
      h(Codicon, { name: chevron, size: '0.875rem', className: 'shrink-0 text-(--ui-text-quaternary)' }),
      group.color
        ? h('span', { className: 'size-2.5 shrink-0 rounded-full', style: dotStyle })
        : h(Codicon, { name: iconName, size: '0.875rem', className: 'shrink-0 text-(--ui-text-tertiary)' }),
      pinnedHere ? h(Codicon, { name: 'pinned', size: '0.75rem', className: 'shrink-0 text-(--ui-text-quaternary)' }) : null,
      h('span', { className: cn('min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[0.8125rem] font-medium text-foreground', blur && BLUR), title: group.name }, highlight(group.name, needle)),
      h(Badge, { className: 'shrink-0' }, String(group.sessionCount))
    ),
    group.isNoProject
      ? null
      : h(
          'button',
          {
            type: 'button',
            title: 'Project options (or right-click)',
            onClick: e => {
              e.stopPropagation()
              ops.onProjectMenu(e.clientX, e.clientY, group)
            },
            className: 'shrink-0 rounded-md p-1 text-(--ui-text-quaternary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground'
          },
          h(Codicon, { name: 'kebab-vertical', size: '0.8125rem' })
        )
  )

  const statsLine = statsParts.length
    ? h(
        'div',
        { className: 'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 pb-0.5 pl-8 text-[0.625rem] text-(--ui-text-quaternary)' },
        h(Codicon, { name: 'graph', size: '0.6875rem' }),
        ...statsParts.map((part, index) => h('span', { key: `stat-${index}`, className: 'truncate' }, part))
      )
    : null

  const body =
    expanded && group.sessions.length
      ? (() => {
          // Keep the project overview compact like Hermes' built-in sidebar.
          // Searching is an explicit request for matching rows, so it bypasses
          // the preview cap; otherwise only the three most recent rows mount.
          const showAll = Boolean(needle) || ops.isShowingAllSessions(group.id)
          const sessions = showAll ? group.sessions : group.sessions.slice(0, PROJECT_SESSION_PREVIEW)
          const showAllButton = !showAll && group.sessionCount > sessions.length
            ? h(
                'button',
                {
                  type: 'button',
                  onClick: () => ops.onShowAllSessions(group.id),
                  className: 'mx-6 mt-0.5 rounded-md px-2 py-1 text-left text-[0.6875rem] text-(--ui-accent) hover:bg-(--chrome-action-hover)'
                },
                `Show all ${group.sessionCount} sessions`
              )
            : null
          return h('div', { className: 'flex flex-col pb-1' }, ...sessions.map(s => renderSession(s, ops, blur)), showAllButton)
        })()
      : expanded && !group.sessions.length
        ? h('div', { className: 'py-1 pl-8 text-[0.6875rem] text-(--ui-text-quaternary)' }, needle ? 'No matching sessions.' : 'No sessions yet.')
        : null

  return h('div', { key: group.id, className: 'select-none' }, header, statsLine, body)
}

// -- collection (user group) ------------------------------------------------------
function renderCollection(coll, ops) {
  const expanded = ops.isCollExpanded(coll.id)
  const chevron = expanded ? 'chevron-down' : 'chevron-right'
  const dotStyle = coll.color ? { backgroundColor: coll.color } : undefined
  const collBlur = ops.isCollBlurred ? ops.isCollBlurred(coll.id) : false

  const header = h(
    'div',
    {
      className: 'flex items-center gap-0.5 rounded-md transition-[background-color,box-shadow,transform] duration-200 ease-out hover:translate-x-0.5 hover:shadow-[inset_2px_0_0_var(--ui-accent)]',
      onContextMenu: e => {
        e.preventDefault()
        e.stopPropagation()
        ops.onCollectionMenu(e.clientX, e.clientY, coll)
      }
    },
    h(
      'button',
      {
        type: 'button',
        onClick: () => ops.onToggleColl(coll.id),
        className: 'flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden rounded-md px-1 py-1 text-left transition-colors hover:bg-(--chrome-action-hover)'
      },
      h(Codicon, { name: chevron, size: '0.8125rem', className: 'shrink-0 text-(--ui-text-quaternary)' }),
      coll.color
        ? h('span', { className: 'size-2 shrink-0 rounded-full', style: dotStyle })
        : h(Codicon, { name: 'layers', size: '0.8125rem', className: 'shrink-0 text-(--ui-text-tertiary)' }),
      h('span', { className: cn('min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[0.6875rem] font-semibold uppercase tracking-wide text-(--ui-text-tertiary)', collBlur && BLUR), title: coll.name }, highlight(coll.name, ops.needle)),
      h(
        'span',
        { className: 'flex shrink-0 items-center gap-2 text-[0.625rem] text-(--ui-text-quaternary)' },
        h('span', {}, `${coll.projects.length}p`),
        h('span', {}, `${coll.sessionCount}s`)
      )
    ),
    h(
      'button',
      {
        type: 'button',
        title: 'Group options (or right-click)',
        onClick: e => {
          e.stopPropagation()
          ops.onCollectionMenu(e.clientX, e.clientY, coll)
        },
        className: 'shrink-0 rounded-md p-1 text-(--ui-text-quaternary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground'
      },
      h(Codicon, { name: 'kebab-vertical', size: '0.75rem' })
    )
  )

  const body =
    expanded
      ? coll.projects.length
        ? (() => {
            // Keep groups compact like project nodes: show the three most
            // relevant projects first, while search and the explicit reveal
            // action keep every matching project discoverable.
            const showAll = Boolean(ops.needle) || ops.isShowingAllProjects(coll.id)
            const projects = showAll ? coll.projects : coll.projects.slice(0, GROUP_PROJECT_PREVIEW)
            const showAllButton = !showAll && coll.projects.length > projects.length
              ? h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => ops.onShowAllProjects(coll.id),
                    className: 'mx-6 mt-0.5 rounded-md px-2 py-1 text-left text-[0.6875rem] text-(--ui-accent) hover:bg-(--chrome-action-hover)'
                  },
                  `Show all ${coll.projects.length} projects`
                )
              : null
            return h('div', { className: 'flex flex-col gap-0.5 pl-2' }, ...projects.map(p => renderGroup(p, ops)), showAllButton)
          })()
        : h('div', { className: 'py-1 pl-6 text-[0.6875rem] text-(--ui-text-quaternary)' }, 'No projects in this group. Right-click a project to move it here.')
      : null

  return h('div', { key: `coll-${coll.id}`, className: 'select-none' }, header, body)
}

// -- colour swatch row (shared) --------------------------------------------------
function colorSwatches(current, onPick, onClear) {
  return h(
    'div',
    { className: 'flex flex-wrap items-center gap-1.5' },
    ...COLOR_PRESETS.map(c =>
      h('button', {
        key: c,
        type: 'button',
        title: c,
        onClick: () => onPick(c),
        className: cn('size-5 rounded-full border transition-transform hover:scale-110', current === c ? 'border-foreground' : 'border-(--ui-stroke-secondary)'),
        style: { backgroundColor: c }
      })
    ),
    h(
      'button',
      {
        type: 'button',
        title: 'Clear colour',
        onClick: () => onClear(),
        className: cn('flex size-5 items-center justify-center rounded-full border', !current ? 'border-foreground' : 'border-(--ui-stroke-secondary)')
      },
      h(Codicon, { name: 'circle-slash', size: '0.75rem', className: 'text-(--ui-text-quaternary)' })
    ),
    h(
      'label',
      {
        title: 'Custom colour',
        className: 'relative size-5 cursor-pointer overflow-hidden rounded-full border border-(--ui-stroke-secondary)',
        style: { background: 'conic-gradient(red, orange, yellow, lime, cyan, blue, magenta, red)' }
      },
      h('input', { type: 'color', value: current || '#3b82f6', onChange: e => onPick(e.target.value), className: 'absolute inset-0 cursor-pointer opacity-0' })
    )
  )
}

// -- context menu (projects + sessions + collections) ----------------------------
function ContextMenu({ menu, ops }) {
  if (!menu) return null
  const MW = 244
  const MH = 380
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - MW - 8))
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - MH - 8))

  const item = (icon, label, run, danger) =>
    h(
      'button',
      {
        type: 'button',
        onClick: () => run(),
        className: cn(
          'flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[0.75rem] transition-colors hover:bg-(--chrome-action-hover)',
          danger ? 'text-(--ui-danger,#ef4444)' : 'text-(--ui-text-secondary)'
        )
      },
      h(Codicon, { name: icon, size: '0.8125rem', className: danger ? '' : 'text-(--ui-text-tertiary)' }),
      label
    )

  const sep = () => h('div', { className: 'my-1 border-t border-(--ui-stroke-secondary)' })
  const heading = label => h('div', { className: 'px-1.5 pb-0.5 pt-1 text-[0.625rem] uppercase tracking-wide text-(--ui-text-quaternary)' }, label)

  let content
  if (menu.mode === 'rename') {
    let el = null
    const commit = () => ops.commitRename(el ? el.value : '')
    const current = menu.kind === 'collection' ? menu.coll?.name : menu.kind === 'session' ? menu.session?.title : menu.group?.name
    content = h(
      'div',
      { className: 'flex flex-col gap-2 p-1' },
      heading(menu.kind === 'collection' ? 'Rename group' : menu.kind === 'session' ? 'Rename session' : 'Rename project'),
      h('input', {
        autoFocus: true,
        defaultValue: current || '',
        onKeyDown: e => {
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') ops.setMenuMode('root')
        },
        ref: node => {
          el = node
          if (node) node.focus()
        },
        className: 'w-full rounded-md border border-(--ui-stroke-secondary) bg-transparent px-2 py-1 text-[0.8125rem] text-foreground outline-none focus:border-(--ui-accent)'
      }),
      h(
        'div',
        { className: 'flex justify-end gap-1' },
        h('button', { type: 'button', onClick: () => ops.setMenuMode('root'), className: 'rounded-md px-2 py-0.5 text-[0.75rem] text-(--ui-text-tertiary) hover:text-foreground' }, 'Cancel'),
        h('button', { type: 'button', onClick: commit, className: 'rounded-md px-2 py-0.5 text-[0.75rem] text-(--ui-accent) hover:bg-(--chrome-action-hover)' }, 'Save')
      )
    )
  } else if (menu.mode === 'newgroup') {
    let el = null
    const commit = () => ops.commitNewGroup(el ? el.value : '')
    content = h(
      'div',
      { className: 'flex flex-col gap-2 p-1' },
      heading('New group'),
      h('input', {
        autoFocus: true,
        placeholder: 'Group name',
        onKeyDown: e => {
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') ops.setMenuMode(menu.kind === 'project' ? 'movegroup' : 'root')
        },
        ref: node => {
          el = node
          if (node) node.focus()
        },
        className: 'w-full rounded-md border border-(--ui-stroke-secondary) bg-transparent px-2 py-1 text-[0.8125rem] text-foreground outline-none focus:border-(--ui-accent)'
      }),
      h(
        'div',
        { className: 'flex justify-end gap-1' },
        h('button', { type: 'button', onClick: () => ops.setMenuMode(menu.kind === 'project' ? 'movegroup' : 'root'), className: 'rounded-md px-2 py-0.5 text-[0.75rem] text-(--ui-text-tertiary) hover:text-foreground' }, 'Cancel'),
        h('button', { type: 'button', onClick: commit, className: 'rounded-md px-2 py-0.5 text-[0.75rem] text-(--ui-accent) hover:bg-(--chrome-action-hover)' }, 'Create')
      )
    )
  } else if (menu.mode === 'newproject') {
    let nameEl = null
    let ideaEl = null
    const folder = String(menu.folderPath || host.state.cwd.get() || '').trim()
    const commit = () => ops.commitNewProject(nameEl ? nameEl.value : '', ideaEl ? ideaEl.value : '')
    content = h(
      'div',
      { className: 'flex flex-col gap-2 p-1' },
      heading('New project in this group'),
      h('input', {
        autoFocus: true,
        placeholder: 'Project name',
        onKeyDown: e => {
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') ops.setMenuMode('root')
        },
        ref: node => {
          nameEl = node
          if (node) node.focus()
        },
        className: 'w-full rounded-md border border-(--ui-stroke-secondary) bg-transparent px-2 py-1 text-[0.8125rem] text-foreground outline-none focus:border-(--ui-accent)'
      }),
      h('textarea', {
        ref: node => { ideaEl = node },
        placeholder: 'What is the goal of this project? (optional)',
        rows: 3,
        className: 'w-full resize-y rounded-md border border-(--ui-stroke-secondary) bg-transparent px-2 py-1 text-[0.75rem] text-foreground outline-none focus:border-(--ui-accent)'
      }),
      h('div', { className: 'text-[0.6875rem] text-(--ui-text-quaternary)' }, 'The project goal is saved as idea.md in the project folder.'),
      h('div', { className: 'text-[0.6875rem] text-(--ui-text-quaternary)' }, 'Project folder'),
      h(
        'div',
        { className: 'flex gap-1' },
        h('input', {
          value: folder,
          placeholder: '/path/to/project',
          onChange: e => ops.setNewProjectFolder(e.target.value),
          className: 'min-w-0 flex-1 rounded-md border border-(--ui-stroke-secondary) bg-transparent px-2 py-1 text-[0.6875rem] text-foreground outline-none focus:border-(--ui-accent)'
        }),
        h('button', {
          type: 'button',
          title: 'Choose folder',
          onClick: () => ops.pickProjectFolder(),
          className: 'shrink-0 rounded-md border border-(--ui-stroke-secondary) px-2 text-(--ui-text-secondary) hover:bg-(--chrome-action-hover) hover:text-foreground'
        }, h(Codicon, { name: 'folder', size: '0.8125rem' }))
      ),
      h('div', { className: 'max-w-[220px] text-[0.6875rem] text-(--ui-text-quaternary)' }, folder ? 'This folder becomes the project workspace.' : 'Choose a folder before creating the project.'),
      h(
        'div',
        { className: 'flex justify-end gap-1' },
        h('button', { type: 'button', onClick: () => ops.setMenuMode('root'), className: 'rounded-md px-2 py-0.5 text-[0.75rem] text-(--ui-text-tertiary) hover:text-foreground' }, 'Cancel'),
        h('button', { type: 'button', onClick: commit, className: 'rounded-md px-2 py-0.5 text-[0.75rem] text-(--ui-accent) hover:bg-(--chrome-action-hover)' }, 'Create')
      )
    )
  } else if (menu.mode === 'movegroup') {
    const curGid = (ops.groupOf && ops.groupOf[menu.group.id]) || DEFAULT_GROUP_ID
    content = h(
      'div',
      { className: 'flex max-h-[300px] flex-col overflow-auto' },
      heading('Move to group'),
      ...(ops.groups || []).map(g =>
        h(
          'button',
          {
            key: g.id,
            type: 'button',
            onClick: () => ops.moveProjectToGroup(menu.group.id, g.id),
            className: cn(
              'flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[0.75rem] transition-colors hover:bg-(--chrome-action-hover)',
              g.id === curGid ? 'text-foreground' : 'text-(--ui-text-secondary)'
            )
          },
          h(Codicon, { name: g.id === curGid ? 'check' : 'layers', size: '0.8125rem', className: g.id === curGid ? 'text-(--ui-accent)' : 'text-(--ui-text-tertiary)' }),
          g.name
        )
      ),
      sep(),
      item('add', 'New group…', () => ops.setMenuMode('newgroup'))
    )
  } else if (menu.mode === 'movesession') {
    const currentCwd = String(menu.session?.cwd || '').trim()
    const needle = String(menu.moveNeedle || '').trim().toLowerCase()
    const allTargets = (ops.projects || []).filter(p => p && !p.isNoProject && p.path && p.path !== currentCwd)
    const targets = needle ? allTargets.filter(p => String(p.name || '').toLowerCase().includes(needle)) : allTargets
    content = h(
      'div',
      { className: 'flex max-h-[300px] flex-col overflow-auto' },
      heading('Move session to project'),
      h('input', {
        autoFocus: true,
        value: menu.moveNeedle || '',
        placeholder: 'Search projects',
        onChange: e => ops.setMoveProjectNeedle(e.target.value),
        onKeyDown: e => {
          if (e.key === 'Escape') ops.setMenuMode('root')
        },
        className: 'mb-1 w-full rounded-md border border-(--ui-stroke-secondary) bg-transparent px-2 py-1 text-[0.75rem] text-foreground outline-none focus:border-(--ui-accent)'
      }),
      targets.length
        ? targets.map(p =>
            h(
              'button',
              {
                key: p.id,
                type: 'button',
                onClick: () => ops.moveSessionToProject(menu.session.id, p),
                className: 'flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[0.75rem] text-(--ui-text-secondary) transition-colors hover:bg-(--chrome-action-hover)'
              },
              h(Codicon, { name: 'folder', size: '0.8125rem', className: 'text-(--ui-text-tertiary)' }),
              p.name
            )
          )
        : h('div', { className: 'px-1.5 py-1 text-[0.75rem] text-(--ui-text-quaternary)' }, needle ? 'No matching projects' : 'No other folder-backed projects'),
      sep(),
      item('arrow-left', 'Back', () => ops.setMenuMode('root'))
    )
  } else if (menu.mode === 'confirm' || menu.mode === 'deleteconfirm') {
    let msg
    const deletingSession = menu.kind === 'session' && menu.mode === 'deleteconfirm'
    if (deletingSession) msg = `Delete "${menu.session?.title || 'this session'}" permanently? Its transcript cannot be recovered.`
    else if (menu.kind === 'project') msg = `Delete project "${menu.group?.name}"? Its sessions are kept (they just lose this grouping).`
    else if (menu.kind === 'collection') msg = `Delete group "${menu.coll?.name}"? Its projects move back to ${DEFAULT_GROUP_NAME}.`
    else msg = `Archive "${menu.session?.title || 'this session'}"? Its transcript will be kept.`
    content = h(
      'div',
      { className: 'flex flex-col gap-2 p-1' },
      h('div', { className: 'px-1 text-[0.75rem] text-(--ui-text-secondary)' }, msg),
      h(
        'div',
        { className: 'flex justify-end gap-1' },
        h('button', { type: 'button', onClick: () => ops.setMenuMode('root'), className: 'rounded-md px-2 py-0.5 text-[0.75rem] text-(--ui-text-tertiary) hover:text-foreground' }, 'Cancel'),
        h('button', { type: 'button', onClick: () => ops.commitDelete(), className: cn('rounded-md px-2 py-0.5 text-[0.75rem] hover:bg-(--chrome-action-hover)', deletingSession ? 'text-(--ui-danger,#ef4444)' : 'text-(--ui-accent)') }, deletingSession ? 'Delete' : 'Archive')
      )
    )
  } else if (menu.kind === 'empty') {
    content = h(
      'div',
      { className: 'flex flex-col' },
      item('add', 'New session', () => { ops.newSession(); ops.closeMenu() }),
      item('new-folder', 'New project', () => ops.setMenuMode('newproject')),
      item('layers', 'New group', () => ops.setMenuMode('newgroup')),
      sep(),
      item(ops.privacyOn ? 'eye-closed' : 'eye', ops.privacyOn ? 'Unblur all' : 'Blur all', () => { ops.toggleBlurAll(); ops.closeMenu() })
    )
  } else if (menu.kind === 'collection') {
    const c = menu.coll
    content = h(
      'div',
      { className: 'flex flex-col' },
      item('new-folder', 'New project here', () => ops.setMenuMode('newproject')),
      item('add', 'New group…', () => ops.setMenuMode('newgroup')),
      item('edit', 'Rename group…', () => ops.setMenuMode('rename')),
      item(ops.blurGroups && ops.blurGroups[c.id] ? 'eye-closed' : 'eye', ops.blurGroups && ops.blurGroups[c.id] ? 'Unblur group' : 'Blur group', () => ops.toggleBlurGroup(c.id)),
      h('div', { className: 'px-1 pt-1' }, heading('Group colour'), colorSwatches(c.color, col => ops.setCollectionColor(c.id, col), () => ops.setCollectionColor(c.id, ''))),
      c.id === DEFAULT_GROUP_ID ? null : sep(),
      c.id === DEFAULT_GROUP_ID ? null : item('trash', 'Delete group', () => ops.setMenuMode('confirm'), true)
    )
  } else if (menu.kind === 'project') {
    const g = menu.group
    const pinned = ops.pinnedProjects && ops.pinnedProjects[g.id]
    const colorRow = g.editable
      ? h('div', { className: 'px-1 pt-1' }, heading('Colour'), colorSwatches(g.color, c => ops.setProjectColor(g.id, c), () => ops.setProjectColor(g.id, '')))
      : null
    content = h(
      'div',
      { className: 'flex flex-col' },
      item('add', 'Create session here', () => ops.newSessionInProject(g)),
      g.path ? item('copy', 'Copy folder path', () => { copyText(g.path, 'Folder path copied'); ops.closeMenu() }) : null,
      item(pinned ? 'pinned' : 'pin', pinned ? 'Unpin project' : 'Pin project', () => ops.togglePinProject(g.id)),
      item(ops.blurProjects && ops.blurProjects[g.id] ? 'eye-closed' : 'eye', ops.blurProjects && ops.blurProjects[g.id] ? 'Unblur name' : 'Blur name', () => ops.toggleBlurProject(g.id)),
      item('layers', 'Move to group…', () => ops.setMenuMode('movegroup')),
      g.editable ? item('edit', 'Rename…', () => ops.setMenuMode('rename')) : null,
      colorRow,
      sep(),
      ops.canOrder ? item('fold-up', 'Move to top', () => ops.moveTop(g.id)) : null,
      ops.canOrder ? item('fold-down', 'Move to bottom', () => ops.moveBottom(g.id)) : null,
      g.editable ? sep() : null,
      g.editable ? item('trash', 'Delete project', () => ops.setMenuMode('confirm'), true) : null
    )
  } else {
    const s = menu.session
    const curColor = ops.sessionColors && ops.sessionColors[s.id]
    const pinned = ops.pinnedSessions && ops.pinnedSessions[s.id]
    const unread = ops.unreadSessions && Object.prototype.hasOwnProperty.call(ops.unreadSessions, s.id)
      ? Boolean(ops.unreadSessions[s.id])
      : Boolean(s.unread)
    content = h(
      'div',
      { className: 'flex flex-col' },
      item('comment-discussion', 'Open', () => { openSession(s.id, 'stack'); ops.closeMenu() }),
      item('split-horizontal', 'Open in new tab', () => { openSession(s.id, 'tab'); ops.closeMenu() }),
      item('multiple-windows', 'Open in new window', () => { openSession(s.id, 'window'); ops.closeMenu() }),
      item('terminal', 'Open in terminal', () => { openSessionInTerminal(s.id, s.cwd); ops.closeMenu() }),
      item('copy', 'Copy session id', () => { copyId(s.id); ops.closeMenu() }),
      item('edit', 'Rename…', () => ops.setMenuMode('rename')),
      item('folder', 'Move to project…', () => ops.setMenuMode('movesession')),
      item(pinned ? 'pinned' : 'pin', pinned ? 'Unpin' : 'Pin', () => ops.togglePinSession(s.id)),
      item(unread ? 'mail-read' : 'mail', unread ? 'Mark as read' : 'Mark as unread', () => ops.toggleUnread(s.id, !unread)),
      h('div', { className: 'px-1 pt-1' }, heading('Tag colour'), colorSwatches(curColor, c => ops.setSessionColor(s.id, c), () => ops.setSessionColor(s.id, ''))),
      sep(),
      item('repo-forked', 'Branch from…', () => ops.branchSession(s.id)),
      item('cloud-download', 'Export session', () => ops.exportSession(s.id)),
      item('archive', 'Archive…', () => ops.setMenuMode('confirm')),
      item('trash', 'Delete session…', () => ops.setMenuMode('deleteconfirm'), true)
    )
  }

  return h(
    'div',
    null,
    h('div', { className: 'fixed inset-0 z-40', onClick: () => ops.closeMenu(), onContextMenu: e => { e.preventDefault(); ops.closeMenu() } }),
    h(
      'div',
      {
        className: 'fixed z-50 w-[244px] rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) p-1 shadow-md backdrop-blur-md',
        style: { left: `${left}px`, top: `${top}px` },
        onClick: e => e.stopPropagation(),
        onContextMenu: e => e.preventDefault()
      },
      content
    )
  )
}

// -- sort menu -------------------------------------------------------------------
function SortMenu({ at, sortKey, order, ops }) {
  if (!at) return null
  const MW = 200
  const left = Math.max(8, Math.min(at.x, window.innerWidth - MW - 8))
  const top = Math.max(8, Math.min(at.y, window.innerHeight - 260))
  return h(
    'div',
    null,
    h('div', { className: 'fixed inset-0 z-40', onClick: () => ops.close(), onContextMenu: e => { e.preventDefault(); ops.close() } }),
    h(
      'div',
      {
        className: 'fixed z-50 w-[200px] rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) p-1 shadow-md backdrop-blur-md',
        style: { left: `${left}px`, top: `${top}px` },
        onClick: e => e.stopPropagation()
      },
      h('div', { className: 'px-1.5 pb-0.5 pt-1 text-[0.625rem] uppercase tracking-wide text-(--ui-text-quaternary)' }, 'Sort by'),
      ...SORTS.map(([key, label]) =>
        h(
          'button',
          {
            key,
            type: 'button',
            onClick: () => ops.setSort(key),
            className: cn(
              'flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[0.75rem] transition-colors hover:bg-(--chrome-action-hover)',
              key === sortKey ? 'text-foreground' : 'text-(--ui-text-secondary)'
            )
          },
          h(Codicon, { name: key === sortKey ? 'check' : 'blank', size: '0.8125rem', className: key === sortKey ? 'text-(--ui-accent)' : 'text-(--ui-text-tertiary)' }),
          label
        )
      ),
      order && order.length
        ? h(
            'div',
            null,
            h('div', { className: 'my-1 border-t border-(--ui-stroke-secondary)' }),
            h('button', { type: 'button', onClick: () => ops.resetOrder(), className: 'flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[0.75rem] text-(--ui-text-secondary) hover:bg-(--chrome-action-hover)' }, h(Codicon, { name: 'clear-all', size: '0.8125rem', className: 'text-(--ui-text-tertiary)' }), 'Reset custom order')
          )
        : null
    )
  )
}

// -- bulk action bar -------------------------------------------------------------
function BulkBar({ count, targets, ops }) {
  const [mode, setMode] = useState(null)
  const btn = (icon, label, onClick, danger) =>
    h(
      Tip,
      { label },
      h(
        'button',
        {
          type: 'button',
          onClick,
          className: cn('rounded-md p-1 transition-colors hover:bg-(--chrome-action-hover)', danger ? 'text-(--ui-danger,#ef4444)' : 'text-(--ui-text-secondary) hover:text-foreground')
        },
        h(Codicon, { name: icon, size: '0.8125rem' })
      )
    )
  return h(
    'div',
    { className: 'flex flex-col gap-1 border-b border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) px-2.5 py-1.5' },
    h(
      'div',
      { className: 'flex items-center gap-1' },
      h('span', { className: 'text-[0.75rem] font-medium text-foreground' }, `${count} selected`),
      h('div', { className: 'flex-1' }),
      btn('archive', 'Archive selected', () => ops.bulkArchive()),
      btn('symbol-color', 'Colour selected', () => setMode(m => (m === 'color' ? null : 'color'))),
      targets.length ? btn('folder', 'Move selected to a project', () => setMode(m => (m === 'move' ? null : 'move'))) : null,
      btn('archive', 'Archive selected', () => setMode('confirm')),
      btn('close', 'Clear selection', () => ops.clearSelection())
    ),
    mode === 'color'
      ? h('div', { className: 'pb-0.5' }, colorSwatches(null, c => { ops.bulkColor(c); setMode(null) }, () => { ops.bulkColor(''); setMode(null) }))
      : null,
    mode === 'move'
      ? h(
          'select',
          {
            className: 'w-full rounded-md border border-(--ui-stroke-secondary) bg-transparent px-2 py-1 text-[0.75rem] text-foreground outline-none',
            defaultValue: '',
            onChange: e => {
              const v = e.target.value
              if (v) {
                ops.bulkMove(v)
                setMode(null)
              }
            }
          },
          h('option', { value: '', disabled: true }, 'Move to project…'),
          ...targets.map(t => h('option', { key: t.id, value: t.path }, t.name))
        )
      : null,
    mode === 'confirm'
      ? h(
          'div',
          { className: 'flex items-center gap-1' },
          h('span', { className: 'flex-1 text-[0.6875rem] text-(--ui-text-secondary)' }, `Archive ${count} session${count === 1 ? '' : 's'}? Transcripts will be kept.`),
          h('button', { type: 'button', onClick: () => setMode(null), className: 'rounded-md px-2 py-0.5 text-[0.75rem] text-(--ui-text-tertiary) hover:text-foreground' }, 'Cancel'),
          h('button', { type: 'button', onClick: () => { ops.bulkDelete(); setMode(null) }, className: 'rounded-md px-2 py-0.5 text-[0.75rem] text-(--ui-accent) hover:bg-(--chrome-action-hover)' }, 'Archive')
        )
      : null
  )
}

// -- scope tabs ------------------------------------------------------------------
function ScopeTabs({ scope, setScope }) {
  const tabs = [
    ['all', 'All'],
    ['groups', 'Groups'],
    ['projects', 'Projects'],
    ['sessions', 'Sessions']
  ]
  return h(
    'div',
    { className: 'inline-flex items-center gap-0.5 rounded-md border border-(--ui-stroke-secondary) p-0.5' },
    ...tabs.map(([key, label]) =>
      h(
        'button',
        {
          key,
          type: 'button',
          onClick: () => setScope(key),
          className: cn(
            'rounded-[5px] px-1.5 py-0.5 text-[0.6875rem] transition-colors',
            scope === key ? 'bg-(--chrome-action-hover) text-foreground' : 'text-(--ui-text-tertiary) hover:text-foreground'
          )
        },
        label
      )
    )
  )
}

// -- pane ----------------------------------------------------------------------
function FinderPane() {
  const profile = useValue(host.state.profile)
  const focusedId = useValue(host.state.focusedStoredSessionId)
  const focusedBusy = useValue(host.state.busy)
  const qc = useQueryClient()
  const inputRef = useRef(null)
  const dragId = useRef(null)
  const newProjRef = useRef(null)
  const newProjIdeaRef = useRef(null)

  const [query, setQuery] = useState('')
  const [scope, setScope] = useState('all')
  const [expanded, setExpanded] = useState(() => new Set())
  const [revealedSessions, setRevealedSessions] = useState(() => new Set())
  const [revealedProjects, setRevealedProjects] = useState(() => new Set())
  const [dragOverId, setDragOverId] = useState(null)
  const [creating, setCreating] = useState(false)
  const [menu, setMenu] = useState(null)
  const [sortAt, setSortAt] = useState(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState(() => new Set())

  const [order, setOrder] = usePersisted(ORDER_KEY, [])
  const [showStats, setShowStats] = usePersisted(STATS_KEY, true)
  const [sessionColors, setSessionColors] = usePersisted(SCOLORS_KEY, {})
  const [pinnedProjects, setPinnedProjects] = usePersisted(PINP_KEY, {})
  const [pinnedSessions, setPinnedSessions] = usePersisted(PINS_KEY, {})
  const [unreadSessions, setUnreadSessions] = usePersisted(UNREAD_KEY, {})
  const [sortKey, setSortKey] = usePersisted(SORT_KEY, 'manual')
  const [privacy, setPrivacy] = usePersisted(PRIVACY_KEY, false)
  const [blurProjects, setBlurProjects] = usePersisted(BLURP_KEY, {})
  const [blurGroups, setBlurGroups] = usePersisted(BLURG_KEY, {})
  const [groupsRaw, setGroupsRaw] = usePersisted(GROUPS_KEY, [])
  const [groupOf, setGroupOf] = usePersisted(GROUPOF_KEY, {})
  const [collapsed, setCollapsed] = usePersisted(COLLAPSED_KEY, {})


  const groupsDef = useMemo(() => ensureGroups(groupsRaw), [groupsRaw])

  const { data, isLoading, isError, error, isFetching, refetch } = useProjectTree(profile)

  useEffect(() => {
    const invalidate = () => qc.invalidateQueries({ queryKey: ['finder', 'tree'] })
    const disposers = [host.onEvent('projects.changed', invalidate), host.onEvent('sessions.changed', invalidate)]
    return () => disposers.forEach(d => typeof d === 'function' && d())
  }, [qc])

  useEffect(() => {
    const fn = val => setPrivacy(() => val)
    privacyListeners.add(fn)
    return () => privacyListeners.delete(fn)
  }, [setPrivacy])

  const needle = query.trim().toLowerCase()
  const grouped = scope !== 'sessions'
  const canOrder = !needle && grouped && sortKey === 'manual'

  const view = useMemo(() => {
    const projects = data?.projects || []

    if (scope === 'sessions') {
      const seen = new Set()
      const flat = []
      for (const p of projects) {
        for (const s of p.sessions) {
          if (seen.has(s.id)) continue
          seen.add(s.id)
          flat.push({ ...s, ownerName: p.isNoProject ? '' : p.name, ownerId: p.id })
        }
      }
      const filtered = flat.filter(s => !needle || sessionText(s).includes(needle))
      const sorted = sortSessions(filtered, sortKey, pinnedSessions)
      return { flat: sorted.slice(0, FLAT_CAP), flatTotal: sorted.length, projectCount: 0, sessionCount: sorted.length, totalTokens: 0, totalCost: 0 }
    }

    const shown = []
    let sCount = 0
    let tTok = 0
    let tCost = 0
    let homeBucket = null
    for (const proj of projects) {
      if ((scope === 'projects' || scope === 'groups') && proj.isNoProject) continue
      const nameMatched = projectMatches(proj, needle)
      const matchedSessions = needle ? proj.sessions.filter(s => nameMatched || sessionText(s).includes(needle)) : proj.sessions
      const show = !needle ? true : nameMatched || matchedSessions.length > 0
      if (!show) continue
      const sessions = sortSessions(matchedSessions, sortKey, pinnedSessions)
      const node = { ...proj, sessions }
      sCount += sessions.length
      tTok += proj.totalTokens || 0
      tCost += proj.totalCostUsd || 0
      if (proj.isNoProject) homeBucket = node
      else shown.push(node)
    }

    const sortedProjects = sortProjects(shown, sortKey, order, pinnedProjects)
    const byColl = {}
    for (const g of groupsDef) byColl[g.id] = []
    for (const p of sortedProjects) {
      let gid = groupOf[p.id] || DEFAULT_GROUP_ID
      if (!byColl[gid]) gid = DEFAULT_GROUP_ID
      byColl[gid].push(p)
    }
    const collections = groupsDef
      .map(g => {
        const projs = byColl[g.id] || []
        return {
          ...g,
          projects: projs,
          sessionCount: projs.reduce((n, p) => n + p.sessions.length, 0),
          totalTokens: projs.reduce((n, p) => n + (p.totalTokens || 0), 0),
          totalCostUsd: projs.reduce((n, p) => n + (p.totalCostUsd || 0), 0)
        }
      })
      .filter(c => c.projects.length || !needle || (scope === 'groups' && c.name.toLowerCase().includes(needle)))

    return { collections, homeBucket, projectCount: sortedProjects.length, sessionCount: sCount, totalTokens: tTok, totalCost: tCost }
  }, [data, needle, scope, order, sortKey, pinnedProjects, pinnedSessions, groupsDef, groupOf])

  const collections = view.collections || []
  const allProjectIds = useMemo(() => {
    const ids = []
    for (const c of collections) for (const p of c.projects) ids.push(p.id)
    if (view.homeBucket) ids.push(view.homeBucket.id)
    return ids
  }, [collections, view.homeBucket])

  const toggle = useCallback(id => {
    const closing = expanded.has(id)
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    if (closing) {
      setRevealedSessions(prev => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }, [expanded])
  const showAllSessions = useCallback(id => {
    setRevealedSessions(prev => {
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }, [])
  const isShowingAllSessions = useCallback(id => revealedSessions.has(id), [revealedSessions])
  const showAllProjects = useCallback(id => {
    setRevealedProjects(prev => {
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }, [])
  const isShowingAllProjects = useCallback(id => revealedProjects.has(id), [revealedProjects])
  const anyExpanded = allProjectIds.some(id => expanded.has(id))
  const toggleAll = useCallback(() => {
    setExpanded(prev => (allProjectIds.some(id => prev.has(id)) ? new Set() : new Set(allProjectIds)))
  }, [allProjectIds])

  const toggleColl = useCallback(id => {
    const closing = Boolean(collapsed[id])
    setCollapsed(prev => {
      const next = { ...prev }
      if (next[id]) delete next[id]
      else next[id] = true
      return next
    })
    if (closing) {
      setRevealedProjects(prev => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }, [collapsed, setCollapsed])

  const currentOrderIds = useCallback(() => {
    const all = (data?.projects || []).filter(p => !p.isNoProject)
    const rank = g => {
      const i = order.indexOf(g.id)
      return i === -1 ? [1, -(g.lastActive || 0)] : [0, i]
    }
    return all
      .slice()
      .sort((a, b) => {
        const ra = rank(a)
        const rb = rank(b)
        return ra[0] - rb[0] || ra[1] - rb[1]
      })
      .map(g => g.id)
  }, [data, order])

  const moveTop = useCallback(id => { setMenu(null); setOrder([id, ...currentOrderIds().filter(x => x !== id)]) }, [currentOrderIds, setOrder])
  const moveBottom = useCallback(id => { setMenu(null); setOrder([...currentOrderIds().filter(x => x !== id), id]) }, [currentOrderIds, setOrder])
  const onDrop = useCallback(targetId => {
    const from = dragId.current
    dragId.current = null
    setDragOverId(null)
    if (!from || from === targetId) return
    const ids = currentOrderIds()
    const fi = ids.indexOf(from)
    const ti = ids.indexOf(targetId)
    if (fi === -1 || ti === -1) return
    ids.splice(ti, 0, ids.splice(fi, 1)[0])
    setOrder(ids)
  }, [currentOrderIds, setOrder])

  const invalidate = useCallback(() => qc.invalidateQueries({ queryKey: ['finder', 'tree'] }), [qc])
  const rpc = useCallback(
    (method, params, okMsg) =>
      Promise.resolve(host.request(method, params))
        .then(() => {
          if (okMsg) host.notify({ kind: 'success', message: okMsg })
          invalidate()
        })
        .catch(err => {
          host.notify({ kind: 'error', message: `${method} failed: ${err?.message || err}` })
          invalidate()
        }),
    [invalidate]
  )

  const setProjectColor = useCallback(
    (id, color) => {
      setMenu(null)
      qc.setQueryData(['finder', 'tree', profile || 'default'], old =>
        old ? { ...old, projects: old.projects.map(p => (p.id === id ? { ...p, color: color || null } : p)) } : old
      )
      rpc('projects.update', { id, color: color || '' })
    },
    [qc, profile, rpc]
  )
  const setSessionColor = useCallback(
    (id, color) => {
      setMenu(null)
      setSessionColors(prev => {
        const next = { ...prev }
        if (color) next[id] = color
        else delete next[id]
        return next
      })
    },
    [setSessionColors]
  )
  const archiveSession = useCallback(id => { setMenu(null); rpc('session.archive', { session_id: id, archived: true }, 'Session archived') }, [rpc])
  const deleteSession = useCallback(
    async id => {
      setMenu(null)
      let snapshot = null
      let deleted = false
      try {
        snapshot = await host.request('session.resume', { session_id: id })
        if (!Number.isSafeInteger(snapshot?.revision) || !Number.isSafeInteger(snapshot?.execution_generation)) {
          throw new Error('The session deletion guard could not read a valid revision.')
        }
        const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
        const result = await host.request('session.mutate', {
          session_id: id,
          request_id: requestId,
          expected_revision: snapshot.revision,
          expected_generation: snapshot.execution_generation,
          operation: 'delete',
          payload: {}
        })
        deleted = Boolean(result)
        if (!deleted) throw new Error('The backend returned an empty deletion result.')
        host.notify({ kind: 'success', message: 'Session deleted' })
        invalidate()
      } catch (err) {
        host.notify({ kind: 'error', message: `session.mutate delete failed: ${err?.message || err}` })
        invalidate()
      } finally {
        if (!deleted && snapshot?.subscription_id) {
          void host.request('session.detach', {
            session_id: snapshot.session_id || id,
            subscription_id: snapshot.subscription_id
          }).catch(() => undefined)
        }
      }
    },
    [invalidate]
  )
  const newSessionInProject = useCallback(
    proj => {
      setMenu(null)
      const cwd = String(proj.path || host.state.cwd.get() || '').trim()
      if (!cwd) {
        host.notify({ kind: 'error', message: 'Open a workspace folder first, then create a session here.' })
        return
      }
      const idea = String(proj.idea || '').trim()
      if (idea) void writeProjectIdeaFile(cwd, proj.name, idea)
      const params = { cwd, cwd_explicit: true }
      const attach = proj.path
        ? Promise.resolve()
        : Promise.resolve(host.request('projects.add_folder', { id: proj.id, path: cwd, is_primary: true }))
      attach
        .then(() => host.request('session.create', params))
        .then(res => {
          const id = res?.stored_session_id || res?.session_id
          if (id) openSession(id, 'stack')
          invalidate()
        })
        .catch(err => host.notify({ kind: 'error', message: `Could not create session here: ${err?.message || err}` }))
    },
    [invalidate]
  )

  const newProject = useCallback(() => {
    const el = newProjRef.current
    const name = ((el && el.value) || '').trim()
    const idea = String((newProjIdeaRef.current && newProjIdeaRef.current.value) || '').trim()
    const cwd = String(host.state.cwd.get() || '').trim()
    if (!name) {
      setCreating(false)
      return
    }
    if (el) el.value = ''
    if (newProjIdeaRef.current) newProjIdeaRef.current.value = ''
    setCreating(false)
    const params = { name, use: false }
    if (cwd) {
      params.folders = [cwd]
      params.primary_path = cwd
    }
    Promise.resolve(host.request('projects.create', params))
      .then(res => {
        const project = res?.project
        if (idea) void writeProjectIdeaFile(cwd, name, idea)
        host.notify({ kind: 'success', message: 'Project created' })
        invalidate()
      })
      .catch(err => host.notify({ kind: 'error', message: `projects.create failed: ${err?.message || err}` }))
  }, [invalidate])
  const newSession = useCallback(() => host.newChat(), [])

  // pins
  const togglePinProject = useCallback(id => {
    setMenu(null)
    setPinnedProjects(prev => {
      const n = { ...prev }
      if (n[id]) delete n[id]
      else n[id] = true
      return n
    })
  }, [setPinnedProjects])
  const togglePinSession = useCallback(id => {
    setMenu(null)
    setPinnedSessions(prev => {
      const n = { ...prev }
      if (n[id]) delete n[id]
      else n[id] = true
      return n
    })
  }, [setPinnedSessions])
  const toggleUnread = useCallback((id, unread) => {
    setMenu(null)
    setUnreadSessions(prev => {
      const next = { ...prev }
      next[id] = Boolean(unread)
      return next
    })
  }, [setUnreadSessions])

  const branchSession = useCallback(
    id => {
      setMenu(null)
      Promise.resolve(host.request('session.branch_stored', { parent_session_id: id }))
        .then(res => {
          const child = res?.stored_session_id || res?.session_id
          if (child) openSession(child, 'stack')
          host.notify({ kind: 'success', message: 'Session branch created' })
          invalidate()
        })
        .catch(err => host.notify({ kind: 'error', message: `Could not branch session: ${err?.message || err}` }))
    },
    [invalidate]
  )

  const exportSession = useCallback(
    id => {
      setMenu(null)
      Promise.resolve(host.request('session.save', { session_id: id }))
        .then(res => {
          const file = res?.file
          if (file && pluginOs && typeof pluginOs.revealPath === 'function') void pluginOs.revealPath(file)
          host.notify({ kind: 'success', message: file ? `Session exported to ${file}` : 'Session exported' })
        })
        .catch(err => host.notify({ kind: 'error', message: `Could not export session: ${err?.message || err}` }))
    },
    []
  )

  // blur (privacy) - per project, per group, or all (header toggle)
  const toggleBlurProject = useCallback(id => {
    setMenu(null)
    setBlurProjects(prev => {
      const n = { ...prev }
      if (n[id]) delete n[id]
      else n[id] = true
      return n
    })
  }, [setBlurProjects])
  const toggleBlurGroup = useCallback(id => {
    setMenu(null)
    setBlurGroups(prev => {
      const n = { ...prev }
      if (n[id]) delete n[id]
      else n[id] = true
      return n
    })
  }, [setBlurGroups])
  const isBlurred = useCallback(
    id => privacy || !!blurProjects[id] || !!blurGroups[groupOf[id] || DEFAULT_GROUP_ID],
    [privacy, blurProjects, blurGroups, groupOf]
  )
  const isCollBlurred = useCallback(id => privacy || !!blurGroups[id], [privacy, blurGroups])

  // groups
  const moveProjectToGroup = useCallback((projectId, groupId) => {
    setMenu(null)
    setGroupOf(prev => ({ ...prev, [projectId]: groupId }))
  }, [setGroupOf])
  const createGroup = useCallback((name, assignProjectId) => {
    const n = (name || '').trim()
    setMenu(null)
    if (!n) return
    const id = newGroupId()
    setGroupsRaw(prev => [...ensureGroups(prev), { id, name: n }])
    if (assignProjectId) setGroupOf(prev => ({ ...prev, [assignProjectId]: id }))
  }, [setGroupsRaw, setGroupOf])
  const renameGroup = useCallback((id, name) => {
    const n = (name || '').trim()
    if (!n) return
    setGroupsRaw(prev => ensureGroups(prev).map(g => (g.id === id ? { ...g, name: n } : g)))
  }, [setGroupsRaw])
  const setCollectionColor = useCallback((id, color) => {
    setMenu(null)
    setGroupsRaw(prev => ensureGroups(prev).map(g => (g.id === id ? { ...g, color: color || undefined } : g)))
  }, [setGroupsRaw])
  const deleteGroup = useCallback(id => {
    setMenu(null)
    if (id === DEFAULT_GROUP_ID) return
    setGroupsRaw(prev => ensureGroups(prev).filter(g => g.id !== id))
    setGroupOf(prev => {
      const n = { ...prev }
      for (const k of Object.keys(n)) if (n[k] === id) delete n[k]
      return n
    })
  }, [setGroupsRaw, setGroupOf])

  const commitRename = useCallback(
    name => {
      const m = menu
      setMenu(null)
      const n = (name || '').trim()
      if (!m || !n) return
      if (m.kind === 'collection') renameGroup(m.coll.id, n)
      else if (m.kind === 'session') rpc('session.title', { session_id: m.session.id, title: n }, 'Session renamed')
      else if (m.group && n !== m.group.name) rpc('projects.update', { id: m.group.id, name: n }, 'Project renamed')
    },
    [menu, rpc, renameGroup]
  )
  const commitNewGroup = useCallback(
    name => {
      const m = menu
      createGroup(name, m && m.kind === 'project' ? m.group.id : null)
    },
    [menu, createGroup]
  )
  const setNewProjectFolder = useCallback(
    folderPath => setMenu(prev => prev ? { ...prev, folderPath: String(folderPath || '') } : prev),
    []
  )
  const setMoveProjectNeedle = useCallback(
    needle => setMenu(prev => prev ? { ...prev, moveNeedle: String(needle || '') } : prev),
    []
  )
  const pickProjectFolder = useCallback(async () => {
    if (!pluginOs || typeof pluginOs.pickOpenPath !== 'function') {
      host.notify({ kind: 'error', message: 'Folder picker is unavailable. Enter the folder path manually.' })
      return
    }
    try {
      const picked = await pluginOs.pickOpenPath({
        directories: true,
        title: 'Choose project folder',
        defaultPath: String(host.state.cwd.get() || '').trim() || undefined
      })
      const folder = String(picked || '').trim()
      if (folder) setNewProjectFolder(folder)
    } catch (err) {
      host.notify({ kind: 'error', message: `Folder picker failed: ${(err && err.message) || err}` })
    }
  }, [setNewProjectFolder])
  const createProjectInGroup = useCallback(
    (name, groupId, selectedFolder, idea) => {
      const n = (name || '').trim()
      const folder = String(selectedFolder || host.state.cwd.get() || '').trim()
      const goal = String(idea || '').trim()
      setMenu(null)
      if (!n) return
      if (!folder) {
        host.notify({ kind: 'error', message: 'Choose a project folder before creating the project.' })
        return
      }
      const params = { name: n, folders: [folder], primary_path: folder, use: false }
      Promise.resolve(host.request('projects.create', params))
        .then(res => {
          const pid = res && res.project && res.project.id
          if (pid && goal) void writeProjectIdeaFile(folder, n, goal)
          if (pid && groupId && groupId !== DEFAULT_GROUP_ID) setGroupOf(prev => ({ ...prev, [pid]: groupId }))
          host.notify({ kind: 'success', message: 'Project created with the selected folder' })
          invalidate()
        })
        .catch(err => host.notify({ kind: 'error', message: `projects.create failed: ${(err && err.message) || err}` }))
    },
    [invalidate, setGroupOf]
  )
  const commitNewProject = useCallback(
    (name, idea) => {
      const m = menu
      createProjectInGroup(name, m && m.kind === 'collection' ? m.coll.id : DEFAULT_GROUP_ID, m && m.folderPath, idea)
    },
    [menu, createProjectInGroup]
  )
  const commitDelete = useCallback(() => {
    const m = menu
    setMenu(null)
    if (!m) return
    if (m.kind === 'project') rpc('projects.delete', { id: m.group.id }, 'Project deleted')
    else if (m.kind === 'collection') deleteGroup(m.coll.id)
    else if (m.mode === 'deleteconfirm') deleteSession(m.session.id)
    else archiveSession(m.session.id)
  }, [menu, rpc, deleteGroup, archiveSession, deleteSession])

  const setMenuMode = useCallback(mode => setMenu(prev => (prev ? { ...prev, mode } : prev)), [])
  const closeMenu = useCallback(() => setMenu(null), [])
  const onProjectMenu = useCallback((x, y, group) => setMenu({ kind: 'project', group, x, y, mode: 'root' }), [])
  const onSessionMenu = useCallback((x, y, session) => setMenu({ kind: 'session', session, x, y, mode: 'root' }), [])
  const onCollectionMenu = useCallback((x, y, coll) => setMenu({ kind: 'collection', coll, x, y, mode: 'root' }), [])
  const onEmptyMenu = useCallback((x, y) => setMenu({ kind: 'empty', x, y, mode: 'root' }), [])
  const promptNewGroup = useCallback((x, y) => setMenu({ kind: 'empty', x, y, mode: 'newgroup' }), [])

  // bulk
  const toggleSelectMode = useCallback(() => {
    setSelectMode(v => {
      if (v) setSelected(new Set())
      return !v
    })
  }, [])
  const onToggleSelect = useCallback(id => {
    setSelected(prev => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }, [])
  const clearSelection = useCallback(() => {
    setSelected(new Set())
    setSelectMode(false)
  }, [])
  const bulkRun = useCallback(
    (label, fn) => {
      const ids = [...selected]
      if (!ids.length) return
      Promise.allSettled(ids.map(fn)).then(results => {
        const ok = results.filter(r => r.status === 'fulfilled').length
        const failed = results.length - ok
        host.notify({ kind: failed ? 'warning' : 'success', message: `${label}: ${ok} done${failed ? `, ${failed} failed` : ''}` })
        setSelected(new Set())
        invalidate()
      })
    },
    [selected, invalidate]
  )
  const bulkArchive = useCallback(() => bulkRun('Archived', id => host.request('session.archive', { session_id: id, archived: true })), [bulkRun])
  const bulkDelete = useCallback(() => bulkRun('Archived', id => host.request('session.archive', { session_id: id, archived: true })), [bulkRun])
  const bulkMove = useCallback(cwd => bulkRun('Moved', id => host.request('session.workspace.move', { session_key: id, cwd })), [bulkRun])
  const moveSessionToProject = useCallback(
    (sessionId, project) => {
      const cwd = String(project && project.path || '').trim()
      setMenu(null)
      if (!sessionId || !cwd) return
      host.request('session.workspace.move', { session_key: sessionId, cwd })
        .then(() => {
          host.notify({ kind: 'success', message: `Session moved to ${project.name}` })
          invalidate()
        })
        .catch(err => host.notify({ kind: 'error', message: `Could not move session: ${(err && err.message) || err}` }))
    },
    [invalidate]
  )
  const bulkColor = useCallback(
    color => {
      setSessionColors(prev => {
        const n = { ...prev }
        selected.forEach(id => {
          if (color) n[id] = color
          else delete n[id]
        })
        return n
      })
      setSelected(new Set())
    },
    [selected, setSessionColors]
  )

  const isExpanded = useCallback(id => (needle || scope === 'sessions' ? true : expanded.has(id)), [needle, scope, expanded])
  const isCollExpanded = useCallback(id => (needle ? true : !collapsed[id]), [needle, collapsed])

  const onKeyDown = useCallback(
    e => {
      if (e.key === 'Escape' && query) {
        e.preventDefault()
        setQuery('')
      }
    },
    [query]
  )

  const ops = {
    needle,
    showStats,
    focusedId,
    focusedBusy,
    flat: scope === 'sessions',
    sessionColors,
    unreadSessions,
    privacy,
    dragOverId,
    canOrder,
    selectMode,
    selected,
    pinnedProjects,
    pinnedSessions,
    isBlurred,
    isCollBlurred,
    onToggle: toggle,
    onToggleColl: toggleColl,
    isExpanded,
    isShowingAllSessions,
    onShowAllSessions: showAllSessions,
    isShowingAllProjects,
    onShowAllProjects: showAllProjects,
    isCollExpanded,
    onProjectMenu,
    onSessionMenu,
    onCollectionMenu,
    onToggleSelect,
    onDragStart: id => { dragId.current = id },
    onDragOver: setDragOverId,
    onDrop
  }
  const menuOps = {
    sessionColors,
    unreadSessions,
    pinnedProjects,
    pinnedSessions,
    blurProjects,
    blurGroups,
    canOrder,
    groups: groupsDef,
    groupOf,
    setMenuMode,
    closeMenu,
    commitRename,
    commitNewGroup,
    commitNewProject,
    deleteSession,
    setNewProjectFolder,
    pickProjectFolder,
    commitDelete,
    setProjectColor,
    setSessionColor,
    setCollectionColor,
    archiveSession,
    newSessionInProject,
    newSession,
    privacyOn: privacy,
    toggleBlurAll: () => setPrivacy(v => !v),
    moveSessionToProject,
    setMoveProjectNeedle,
    projects: data?.projects || [],
    moveTop,
    moveBottom,
    togglePinProject,
    togglePinSession,
    toggleUnread,
    branchSession,
    exportSession,
    toggleBlurProject,
    toggleBlurGroup,
    moveProjectToGroup
  }
  const sortOps = {
    close: () => setSortAt(null),
    setSort: k => { setSortKey(k); setSortAt(null) },
    resetOrder: () => { setOrder([]); setSortAt(null) }
  }
  const bulkOps = { bulkArchive, bulkDelete, bulkMove, bulkColor, clearSelection }
  const moveTargets = useMemo(() => (data?.projects || []).filter(p => p.path && !p.isNoProject), [data])

  let bodyNode
  if (isLoading) {
    bodyNode = h(
      'div',
      { className: 'flex min-h-0 flex-1 items-center justify-center gap-2 text-(--ui-text-tertiary)' },
      h(Codicon, { name: 'loading', spinning: true, size: '1rem' }),
      h('span', { className: 'text-xs' }, 'Loading…')
    )
  } else if (isError && !data) {
    bodyNode = h('div', { className: 'flex min-h-0 flex-1 items-center justify-center p-6' }, h(EmptyState, { title: 'Could not load sessions', description: error?.message || 'The gateway did not answer.' }))
  } else if (scope === 'sessions') {
    const flat = view.flat || []
    bodyNode = flat.length
      ? h(
          ScrollArea,
          { className: 'min-h-0 flex-1' },
          h(
            'div',
            { className: 'flex flex-col gap-0.5 p-1.5' },
            ...flat.map(s => renderSession(s, ops, ops.isBlurred(s.ownerId))),
            view.flatTotal > flat.length
              ? h('div', { className: 'px-2 py-2 text-center text-[0.625rem] text-(--ui-text-quaternary)' }, `Showing first ${flat.length} of ${view.flatTotal}. Narrow with search.`)
              : null
          )
        )
      : h('div', { className: 'flex min-h-0 flex-1 items-center justify-center p-6' }, h(EmptyState, { title: needle ? 'No matches' : 'No sessions yet', description: needle ? 'Try a title, a word from the chat, or a project name.' : 'Sessions appear here as you chat.' }))
  } else if (scope === 'groups') {
    bodyNode = collections.length
      ? h(
          ScrollArea,
          { className: 'min-h-0 flex-1' },
          h(
            'div',
            { className: 'flex flex-col gap-0.5 p-1.5' },
            ...collections.map(c => renderCollection(c, ops))
          )
        )
      : h('div', { className: 'flex min-h-0 flex-1 items-center justify-center p-6' }, h(EmptyState, { title: needle ? 'No matching groups' : 'No groups yet', description: needle ? 'Try another group name.' : 'Create a group to organise your projects.' }))
  } else if (!collections.length && !view.homeBucket) {
    bodyNode = h('div', { className: 'flex min-h-0 flex-1 items-center justify-center p-6' }, h(EmptyState, { title: needle ? 'No matches' : 'No projects yet', description: needle ? 'Try a project name, a repo path, or a chat title.' : scope === 'projects' ? 'Create a project to group sessions.' : 'Projects and sessions will appear here.' }))
  } else {
    bodyNode = h(
      ScrollArea,
      { className: 'min-h-0 flex-1' },
      h(
        'div',
        { className: 'flex flex-col gap-0.5 p-1.5' },
        ...collections.map(c => renderCollection(c, ops)),
        view.homeBucket ? renderGroup(view.homeBucket, ops) : null
      )
    )
  }

  const countLabel =
    scope === 'sessions'
      ? `${view.sessionCount} session${view.sessionCount === 1 ? '' : 's'}`
      : scope === 'groups'
        ? `${collections.length} group${collections.length === 1 ? '' : 's'}`
        : `${view.projectCount} projects, ${view.sessionCount} sessions`

  const headerBtn = (icon, label, onClick, active, spinning) =>
    h(
      Tip,
      { label },
      h(
        'button',
        {
          type: 'button',
          onClick,
          className: cn('rounded-md p-1 transition-colors hover:bg-(--chrome-action-hover)', active ? 'text-(--ui-accent)' : 'text-(--ui-text-tertiary) hover:text-foreground')
        },
        h(Codicon, { name: icon, size: '0.8125rem', spinning })
      )
    )

  return h(
    'div',
    {
      className: 'flex h-full min-h-0 flex-col',
      onContextMenu: e => {
        e.preventDefault()
        onEmptyMenu(e.clientX, e.clientY)
      }
    },
    h(ContextMenu, { menu, ops: menuOps }),
    h(SortMenu, { at: sortAt, sortKey, order, ops: sortOps }),
    h(
      'div',
      { className: 'flex flex-col gap-2 border-b border-(--ui-stroke-secondary) px-2.5 pb-2 pt-2.5' },
      h(
        'div',
        { className: 'flex items-center gap-1.5' },
        h(Codicon, { name: 'search-fuzzy', size: '0.875rem', className: 'text-(--ui-text-tertiary)' }),
        h('span', { className: 'text-[0.8125rem] font-semibold text-foreground' }, 'Finder'),
        h('span', { className: 'text-[0.625rem] text-(--ui-text-quaternary)' }, countLabel),
        h('div', { className: 'flex-1' }),
        h(ActiveContextChip, {}),
        data?.mode === 'flat'
          ? h(Tip, { label: `Project grouping unavailable (${data.treeError || 'projects.tree missing'}).` }, h(Codicon, { name: 'warning', size: '0.8125rem', className: 'text-(--ui-text-quaternary)' }))
          : null,
        headerBtn('add', 'New session', newSession),
        headerBtn('new-folder', creating ? 'Cancel new project' : 'New project', () => setCreating(c => !c), creating),
        headerBtn('layers', 'New group', e => promptNewGroup(e.clientX, e.clientY)),
        headerBtn('refresh', 'Refresh', () => refetch(), false, isFetching)
      ),
      h(SearchField, {
        value: query,
        onChange: setQuery,
        onKeyDown,
        inputRef,
        placeholder: 'Search projects & sessions…',
        hints: ['Search a project by name', 'Try a repo path', 'Find by chat title', 'Search inside a conversation', 'Filter by git branch'],
        containerClassName: 'w-full',
        'aria-label': 'Search projects and sessions'
      }),
      h(
        'div',
        { className: 'flex items-center gap-1' },
        h(ScopeTabs, { scope, setScope }),
        h('div', { className: 'flex-1' }),
        headerBtn(privacy ? 'eye-closed' : 'eye', privacy ? 'Blur-all on (all titles blurred)' : 'Blur all titles (privacy)', () => setPrivacy(v => !v), privacy),
        headerBtn('sort-precedence', `Sort: ${SORT_LABEL[sortKey] || 'Custom order'}`, e => setSortAt({ x: e.clientX, y: e.clientY }), sortKey !== 'manual'),
        headerBtn('checklist', selectMode ? 'Exit multi-select' : 'Multi-select sessions', toggleSelectMode, selectMode),
        headerBtn('graph', showStats ? 'Hide token stats' : 'Show token stats', () => setShowStats(v => !v), showStats),
        grouped && allProjectIds.length ? headerBtn(anyExpanded ? 'collapse-all' : 'expand-all', anyExpanded ? 'Collapse all' : 'Expand all', toggleAll) : null
      ),
      creating
        ? h(
            'div',
            { className: 'flex items-center gap-1' },
            h(Codicon, { name: 'new-folder', size: '0.8125rem', className: 'shrink-0 text-(--ui-text-tertiary)' }),
            h('input', {
              autoFocus: true,
              ref: newProjRef,
              placeholder: 'New project name…',
              onKeyDown: e => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  newProject()
                } else if (e.key === 'Escape') setCreating(false)
              },
              className: 'min-w-0 flex-1 rounded-md border border-(--ui-stroke-secondary) bg-transparent px-2 py-1 text-[0.8125rem] text-foreground outline-none focus:border-(--ui-accent)'
            }),
            h('textarea', {
              ref: newProjIdeaRef,
              rows: 2,
              placeholder: 'Project idea or goal (optional)…',
              className: 'min-w-0 flex-1 resize-y rounded-md border border-(--ui-stroke-secondary) bg-transparent px-2 py-1 text-[0.75rem] text-foreground outline-none focus:border-(--ui-accent)',
              onKeyDown: e => {
                if (e.key === 'Escape') setCreating(false)
                else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  newProject()
                }
              }
            }),
            h('button', { type: 'button', onClick: newProject, className: 'shrink-0 rounded-md px-2 py-0.5 text-[0.75rem] text-(--ui-accent) hover:bg-(--chrome-action-hover)' }, 'Create'),
            h('button', { type: 'button', onClick: () => setCreating(false), className: 'shrink-0 rounded-md px-2 py-0.5 text-[0.75rem] text-(--ui-text-tertiary) hover:text-foreground' }, 'Cancel')
          )
        : null
    ),
    selectMode && selected.size ? h(BulkBar, { count: selected.size, targets: moveTargets, ops: bulkOps }) : null,
    bodyNode
  )
}

export default {
  id: ID,
  name: 'Finder - Projects & Sessions',
  register(ctx) {
    storage = ctx.storage
    pluginOs = ctx.os
    pluginFiles = ctx.files
    ensureBlurStyle()

    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'Finder',
      data: {
        placement: 'left',
        width: '320px',
        minWidth: '280px',
        maxWidth: '520px',
        collapsible: true,
        hideOnly: true,
        tabTitleText: () => 'Finder',
        dock: { pane: 'sessions', pos: 'center', enforce: true }
      },
      render: () => h(FinderPane, {})
    })

    const reveal = () => {
      if (typeof host.revealPane === 'function') host.revealPane(PANE_ID)
      else host.notify({ kind: 'info', message: 'Open the Finder tab beside Sessions.' })
    }

    const togglePrivacy = () => {
      let next = true
      try {
        const cur = storage ? storage.get(PRIVACY_KEY, false) : false
        next = !cur
        storage && storage.set(PRIVACY_KEY, next)
      } catch {}
      broadcastPrivacy(next)
      host.notify({ kind: 'info', message: `Finder blur-all ${next ? 'on' : 'off'}` })
      reveal()
    }

    ctx.register({
      id: 'open',
      area: PALETTE_AREA,
      data: {
        id: 'finder.open',
        label: 'Find projects & sessions',
        keywords: ['find', 'finder', 'search', 'project', 'projects', 'session', 'sessions', 'filter', 'jump', 'group'],
        run: reveal
      }
    })

    ctx.register({
      id: 'privacy',
      area: PALETTE_AREA,
      data: {
        id: 'finder.privacy',
        label: 'Finder: toggle privacy mode',
        keywords: ['finder', 'privacy', 'blur', 'hide', 'redact', 'screenshot', 'stream'],
        run: togglePrivacy
      }
    })

    ctx.register({
      id: 'open-key',
      area: KEYBINDS_AREA,
      data: { id: 'finder.open', category: 'view', defaults: ['mod+alt+f'], label: 'Find projects & sessions', run: reveal }
    })

    ctx.register({
      id: 'privacy-key',
      area: KEYBINDS_AREA,
      data: { id: 'finder.privacy', category: 'view', defaults: ['mod+alt+p'], label: 'Finder: toggle privacy mode', run: togglePrivacy }
    })
  }
}
