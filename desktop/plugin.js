/**
 * Finder - unified search for Projects & Sessions, as a dock TAB.
 *
 * Docks in the Sessions strip (SESSIONS | BOTS | FINDER), like Bots. Tabs:
 *   - All      : projects grouped (incl. the project-less bucket), expandable.
 *   - Projects : real projects only, each expandable to its sessions.
 *   - Sessions : a FLAT list of every session, no grouping (project shown as a tag).
 *
 * Search matches project names (core can't) + session text, bridged by project.
 * Right-click a project  -> New session here / Rename / Colour / Move / Delete.
 * Right-click a session  -> Open (tab/window) / Colour / Archive / Delete.
 * Extras: token+cost stats, a live context meter for the open chat, drag-drop
 * project reorder (grip handle), all persisted in ctx.storage.
 *
 * Data: `projects.tree` RPC (session.list fallback). Live refresh on
 * `projects.changed` / `sessions.changed`.
 *
 * Install: ~/.hermes/desktop-plugins/finder/plugin.js  (folder name == id).
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
const ORDER_KEY = 'projectOrder'
const STATS_KEY = 'showStats'
const SCOLORS_KEY = 'sessionColors'

const COLOR_PRESETS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6',
  '#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#64748b'
]

let storage = null

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
    }))
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
function renderSession(s, ops) {
  const { needle, showStats, focusedId, flat, sessionColors } = ops
  const active = s.id === focusedId
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
  return h(
    'button',
    {
      key: s.id,
      type: 'button',
      title: s.cwd || title,
      onClick: e => openSession(s.id, intentFromEvent(e)),
      onContextMenu: e => {
        e.preventDefault()
        e.stopPropagation()
        ops.onSessionMenu(e.clientX, e.clientY, s)
      },
      className: cn(
        'group/sess flex w-full items-start gap-2 rounded-md py-1.5 text-left transition-colors',
        flat ? 'px-2' : 'pl-6 pr-2',
        active ? 'bg-(--chrome-action-hover)' : 'hover:bg-(--chrome-action-hover)'
      )
    },
    h('span', {
      className: cn(
        'mt-1.5 size-1.5 shrink-0 rounded-full',
        !customColor && (active || s.unread) ? 'bg-(--ui-accent)' : '',
        !customColor && !active && !s.unread ? 'bg-(--ui-text-quaternary) opacity-50' : ''
      ),
      style: dotStyle
    }),
    h(
      'span',
      { className: 'flex min-w-0 flex-1 flex-col' },
      h(
        'span',
        { className: 'flex items-center gap-1.5' },
        s.pinned ? h(Codicon, { name: 'pinned', size: '0.75rem', className: 'shrink-0 text-(--ui-text-quaternary)' }) : null,
        h(
          'span',
          {
            className: cn(
              'truncate text-[0.8125rem] leading-tight',
              s.title ? 'text-(--ui-text-secondary)' : 'text-(--ui-text-quaternary) italic'
            )
          },
          highlight(title, needle)
        )
      ),
      s.preview
        ? h('span', { className: 'truncate text-[0.6875rem] leading-tight text-(--ui-text-quaternary)' }, highlight(s.preview, needle))
        : null,
      metaBits.length
        ? h('span', { className: 'mt-0.5 truncate text-[0.625rem] leading-tight text-(--ui-text-quaternary)' }, metaBits.join('  ·  '))
        : null
    )
  )
}

// -- project group ----------------------------------------------------------------
function renderGroup(group, ops) {
  const { needle, expanded, showStats, dragOverId, canOrder } = ops
  const dotStyle = group.color ? { backgroundColor: group.color } : undefined
  const chevron = expanded ? 'chevron-down' : 'chevron-right'
  const iconName = group.isNoProject ? 'inbox' : group.isAuto ? 'git-branch' : 'folder'
  const draggable = canOrder && !group.isNoProject

  const statsText = showStats
    ? [fmtTokens(group.totalTokens), fmtCost(group.totalCostUsd)].filter(Boolean).join('  ·  ')
    : ''

  const header = h(
    'div',
    {
      className: cn(
        'flex items-center gap-0.5 rounded-md pr-1 transition-colors',
        dragOverId === group.id && 'ring-1 ring-(--ui-accent)'
      ),
      onContextMenu: group.isNoProject
        ? undefined
        : e => {
            e.preventDefault()
            e.stopPropagation()
            ops.onProjectMenu(e.clientX, e.clientY, group)
          },
      // drop target
      onDragOver: canOrder && !group.isNoProject
        ? e => {
            e.preventDefault()
            try {
              e.dataTransfer.dropEffect = 'move'
            } catch {}
            ops.onDragOver(group.id)
          }
        : undefined,
      onDrop: canOrder && !group.isNoProject
        ? e => {
            e.preventDefault()
            ops.onDrop(group.id)
          }
        : undefined,
      onDragEnd: canOrder ? () => ops.onDragOver(null) : undefined
    },
    // drag handle (only when ordering is possible)
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
        title: group.path || group.name,
        className: cn(
          'flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1.5 text-left transition-colors',
          'hover:bg-(--chrome-action-hover)'
        )
      },
      h(Codicon, { name: chevron, size: '0.875rem', className: 'shrink-0 text-(--ui-text-quaternary)' }),
      group.color
        ? h('span', { className: 'size-2.5 shrink-0 rounded-full', style: dotStyle })
        : h(Codicon, { name: iconName, size: '0.875rem', className: 'shrink-0 text-(--ui-text-tertiary)' }),
      h('span', { className: 'min-w-0 flex-1 truncate text-[0.8125rem] font-medium text-foreground' }, highlight(group.name, needle)),
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

  const statsLine = statsText
    ? h(
        'div',
        { className: 'flex items-center gap-1 pb-0.5 pl-8 text-[0.625rem] text-(--ui-text-quaternary)' },
        h(Codicon, { name: 'graph', size: '0.6875rem' }),
        statsText
      )
    : null

  const body =
    expanded && group.sessions.length
      ? h('div', { className: 'flex flex-col pb-1' }, ...group.sessions.map(s => renderSession(s, ops)))
      : expanded && !group.sessions.length
        ? h('div', { className: 'py-1 pl-8 text-[0.6875rem] text-(--ui-text-quaternary)' }, needle ? 'No matching sessions.' : 'No sessions yet.')
        : null

  return h('div', { key: group.id, className: 'select-none' }, header, statsLine, body)
}

// -- context menu (projects + sessions) ------------------------------------------
function ContextMenu({ menu, ops }) {
  if (!menu) return null
  const MW = 240
  const MH = 320
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

  let content
  if (menu.mode === 'rename') {
    let renameEl = null
    const commit = () => ops.commitRename(renameEl ? renameEl.value : '')
    content = h(
      'div',
      { className: 'flex flex-col gap-2 p-1' },
      h('div', { className: 'px-1 text-[0.625rem] uppercase tracking-wide text-(--ui-text-quaternary)' }, 'Rename project'),
      h('input', {
        autoFocus: true,
        defaultValue: menu.group?.name || '',
        onKeyDown: e => {
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') ops.setMenuMode('root')
        },
        ref: el => {
          renameEl = el
          if (el) el.focus()
        },
        className:
          'w-full rounded-md border border-(--ui-stroke-secondary) bg-transparent px-2 py-1 text-[0.8125rem] text-foreground outline-none focus:border-(--ui-accent)'
      }),
      h(
        'div',
        { className: 'flex justify-end gap-1' },
        h('button', { type: 'button', onClick: () => ops.setMenuMode('root'), className: 'rounded-md px-2 py-0.5 text-[0.75rem] text-(--ui-text-tertiary) hover:text-foreground' }, 'Cancel'),
        h('button', { type: 'button', onClick: commit, className: 'rounded-md px-2 py-0.5 text-[0.75rem] text-(--ui-accent) hover:bg-(--chrome-action-hover)' }, 'Save')
      )
    )
  } else if (menu.mode === 'confirm') {
    const name = menu.kind === 'project' ? menu.group?.name : menu.session?.title || 'this session'
    content = h(
      'div',
      { className: 'flex flex-col gap-2 p-1' },
      h(
        'div',
        { className: 'px-1 text-[0.75rem] text-(--ui-text-secondary)' },
        menu.kind === 'project'
          ? `Delete project "${name}"? Its sessions are kept (they just lose this grouping).`
          : `Delete "${name}" and its transcript? This cannot be undone.`
      ),
      h(
        'div',
        { className: 'flex justify-end gap-1' },
        h('button', { type: 'button', onClick: () => ops.setMenuMode('root'), className: 'rounded-md px-2 py-0.5 text-[0.75rem] text-(--ui-text-tertiary) hover:text-foreground' }, 'Cancel'),
        h('button', { type: 'button', onClick: () => ops.commitDelete(), className: 'rounded-md px-2 py-0.5 text-[0.75rem] text-(--ui-danger,#ef4444) hover:bg-(--chrome-action-hover)' }, 'Delete')
      )
    )
  } else if (menu.kind === 'project') {
    const g = menu.group
    const colorRow = g.editable
      ? h(
          'div',
          { className: 'px-1 pt-1' },
          h('div', { className: 'mb-1 text-[0.625rem] uppercase tracking-wide text-(--ui-text-quaternary)' }, 'Colour'),
          h(
            'div',
            { className: 'flex flex-wrap items-center gap-1.5' },
            ...COLOR_PRESETS.map(c =>
              h('button', {
                key: c,
                type: 'button',
                title: c,
                onClick: () => ops.setProjectColor(g.id, c),
                className: cn('size-5 rounded-full border transition-transform hover:scale-110', g.color === c ? 'border-foreground' : 'border-(--ui-stroke-secondary)'),
                style: { backgroundColor: c }
              })
            ),
            h(
              'button',
              {
                type: 'button',
                title: 'Default (no colour)',
                onClick: () => ops.setProjectColor(g.id, ''),
                className: cn('flex size-5 items-center justify-center rounded-full border', !g.color ? 'border-foreground' : 'border-(--ui-stroke-secondary)')
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
              h('input', { type: 'color', value: g.color || '#3b82f6', onChange: e => ops.setProjectColor(g.id, e.target.value), className: 'absolute inset-0 cursor-pointer opacity-0' })
            )
          )
        )
      : null

    content = h(
      'div',
      { className: 'flex flex-col' },
      g.path ? item('add', 'New session here', () => ops.newSessionInProject(g)) : null,
      g.path ? item('copy', 'Copy folder path', () => { copyText(g.path, 'Folder path copied'); ops.closeMenu() }) : null,
      g.editable ? item('edit', 'Rename…', () => ops.setMenuMode('rename')) : null,
      colorRow,
      colorRow || g.editable || g.path ? sep() : null,
      item('fold-up', 'Move to top', () => ops.moveTop(g.id)),
      item('fold-down', 'Move to bottom', () => ops.moveBottom(g.id)),
      g.editable ? sep() : null,
      g.editable ? item('trash', 'Delete project', () => ops.setMenuMode('confirm'), true) : null
    )
  } else {
    const s = menu.session
    const curColor = ops.sessionColors && ops.sessionColors[s.id]
    content = h(
      'div',
      { className: 'flex flex-col' },
      item('comment-discussion', 'Open', () => { openSession(s.id, 'stack'); ops.closeMenu() }),
      item('split-horizontal', 'Open in new tab', () => { openSession(s.id, 'tab'); ops.closeMenu() }),
      item('multiple-windows', 'Open in new window', () => { openSession(s.id, 'window'); ops.closeMenu() }),
      item('copy', 'Copy session id', () => { copyId(s.id); ops.closeMenu() }),
      sep(),
      h(
        'div',
        { className: 'px-1 pt-1' },
        h('div', { className: 'mb-1 text-[0.625rem] uppercase tracking-wide text-(--ui-text-quaternary)' }, 'Tag colour'),
        h(
          'div',
          { className: 'flex flex-wrap items-center gap-1.5' },
          ...COLOR_PRESETS.map(c =>
            h('button', {
              key: c,
              type: 'button',
              title: c,
              onClick: () => ops.setSessionColor(s.id, c),
              className: cn('size-5 rounded-full border transition-transform hover:scale-110', curColor === c ? 'border-foreground' : 'border-(--ui-stroke-secondary)'),
              style: { backgroundColor: c }
            })
          ),
          h(
            'button',
            {
              type: 'button',
              title: 'Clear tag',
              onClick: () => ops.setSessionColor(s.id, ''),
              className: cn('flex size-5 items-center justify-center rounded-full border', !curColor ? 'border-foreground' : 'border-(--ui-stroke-secondary)')
            },
            h(Codicon, { name: 'circle-slash', size: '0.75rem', className: 'text-(--ui-text-quaternary)' })
          )
        )
      ),
      sep(),
      item('archive', 'Archive', () => ops.archiveSession(s.id)),
      item('trash', 'Delete', () => ops.setMenuMode('confirm'), true)
    )
  }

  return h(
    'div',
    null,
    h('div', { className: 'fixed inset-0 z-40', onClick: () => ops.closeMenu(), onContextMenu: e => { e.preventDefault(); ops.closeMenu() } }),
    h(
      'div',
      {
        className:
          'fixed z-50 w-[240px] rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-elevated) p-1 shadow-md backdrop-blur-md',
        style: { left: `${left}px`, top: `${top}px` },
        onClick: e => e.stopPropagation(),
        onContextMenu: e => e.preventDefault()
      },
      content
    )
  )
}

// -- scope tabs ------------------------------------------------------------------
function ScopeTabs({ scope, setScope }) {
  const tabs = [
    ['all', 'All'],
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
  const qc = useQueryClient()
  const inputRef = useRef(null)
  const dragId = useRef(null)
  const newProjRef = useRef(null)

  const [query, setQuery] = useState('')
  const [scope, setScope] = useState('all')
  const [expanded, setExpanded] = useState(() => new Set())
  const [dragOverId, setDragOverId] = useState(null)
  const [creating, setCreating] = useState(false)
  const [menu, setMenu] = useState(null)
  const [order, setOrder] = usePersisted(ORDER_KEY, [])
  const [showStats, setShowStats] = usePersisted(STATS_KEY, true)
  const [sessionColors, setSessionColors] = usePersisted(SCOLORS_KEY, {})

  const { data, isLoading, isError, error, isFetching, refetch } = useProjectTree(profile)

  useEffect(() => {
    const invalidate = () => qc.invalidateQueries({ queryKey: ['finder', 'tree'] })
    const disposers = [host.onEvent('projects.changed', invalidate), host.onEvent('sessions.changed', invalidate)]
    return () => disposers.forEach(d => typeof d === 'function' && d())
  }, [qc])

  const needle = query.trim().toLowerCase()
  const grouped = scope !== 'sessions'
  const canOrder = !needle && grouped

  const view = useMemo(() => {
    const projects = data?.projects || []

    // Flat Sessions tab: every session, project shown only as a tag.
    if (scope === 'sessions') {
      const seen = new Set()
      const flat = []
      for (const p of projects) {
        for (const s of p.sessions) {
          if (seen.has(s.id)) continue
          seen.add(s.id)
          flat.push({ ...s, ownerName: p.isNoProject ? '' : p.name })
        }
      }
      const filtered = flat.filter(s => !needle || sessionText(s).includes(needle))
      filtered.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return (b.lastActive || 0) - (a.lastActive || 0)
      })
      return { flat: filtered.slice(0, FLAT_CAP), flatTotal: filtered.length, projectCount: 0, sessionCount: filtered.length, totalTokens: 0, totalCost: 0 }
    }

    const out = []
    let sCount = 0
    let tTok = 0
    let tCost = 0
    for (const proj of projects) {
      if (scope === 'projects' && proj.isNoProject) continue // Projects tab = real projects only
      const nameMatched = projectMatches(proj, needle)
      const matchedSessions = needle ? proj.sessions.filter(s => nameMatched || sessionText(s).includes(needle)) : proj.sessions
      const show = !needle ? true : nameMatched || matchedSessions.length > 0
      if (!show) continue
      const sessions = matchedSessions.slice().sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return (b.lastActive || 0) - (a.lastActive || 0)
      })
      out.push({ ...proj, sessions })
      sCount += sessions.length
      tTok += proj.totalTokens || 0
      tCost += proj.totalCostUsd || 0
    }
    const rank = g => {
      if (g.isNoProject) return [2, 0]
      const idx = order.indexOf(g.id)
      return idx === -1 ? [1, -(g.lastActive || 0)] : [0, idx]
    }
    out.sort((a, b) => {
      const ra = rank(a)
      const rb = rank(b)
      return ra[0] - rb[0] || ra[1] - rb[1]
    })
    return { groups: out, projectCount: out.length, sessionCount: sCount, totalTokens: tTok, totalCost: tCost }
  }, [data, needle, scope, order])

  const groups = view.groups || []
  const toggle = useCallback(id => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const anyExpanded = groups.some(g => expanded.has(g.id))
  const toggleAll = useCallback(() => {
    setExpanded(prev => (groups.some(g => prev.has(g.id)) ? new Set() : new Set(groups.map(g => g.id))))
  }, [groups])

  const currentOrderIds = useCallback(() => {
    const all = (data?.projects || []).filter(p => !p.isNoProject)
    const rank = g => {
      const i = order.indexOf(g.id)
      return i === -1 ? [1, -(g.lastActive || 0)] : [0, i]
    }
    return all.slice().sort((a, b) => {
      const ra = rank(a)
      const rb = rank(b)
      return ra[0] - rb[0] || ra[1] - rb[1]
    }).map(g => g.id)
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
  const newSessionInProject = useCallback(
    proj => {
      setMenu(null)
      if (!proj.path) {
        host.notify({ kind: 'error', message: 'This group has no folder to open a session in.' })
        return
      }
      Promise.resolve(host.request('session.create', { cwd: proj.path, cwd_explicit: true }))
        .then(res => {
          const id = res?.stored_session_id || res?.session_id
          if (id) openSession(id, 'stack')
          invalidate()
        })
        .catch(err => host.notify({ kind: 'error', message: `Could not create session: ${err?.message || err}` }))
    },
    [invalidate]
  )

  const newProject = useCallback(() => {
    const el = newProjRef.current
    const name = ((el && el.value) || '').trim()
    if (!name) {
      setCreating(false)
      return
    }
    if (el) el.value = ''
    setCreating(false)
    rpc('projects.create', { name, use: false }, 'Project created')
  }, [rpc])
  const newSession = useCallback(() => host.newChat(), [])

  const commitRename = useCallback(
    name => {
      const g = menu?.group
      setMenu(null)
      const n = (name || '').trim()
      if (g && n && n !== g.name) rpc('projects.update', { id: g.id, name: n }, 'Project renamed')
    },
    [menu, rpc]
  )
  const commitDelete = useCallback(() => {
    const m = menu
    setMenu(null)
    if (!m) return
    if (m.kind === 'project') rpc('projects.delete', { id: m.group.id }, 'Project deleted')
    else rpc('session.delete', { session_id: m.session.id }, 'Session deleted')
  }, [menu, rpc])

  const setMenuMode = useCallback(mode => setMenu(prev => (prev ? { ...prev, mode } : prev)), [])
  const closeMenu = useCallback(() => setMenu(null), [])
  const onProjectMenu = useCallback((x, y, group) => setMenu({ kind: 'project', group, x, y, mode: 'root' }), [])
  const onSessionMenu = useCallback((x, y, session) => setMenu({ kind: 'session', session, x, y, mode: 'root' }), [])

  const isExpanded = g => (needle || scope === 'sessions' ? true : expanded.has(g.id))

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
    flat: scope === 'sessions',
    sessionColors,
    dragOverId,
    canOrder,
    onToggle: toggle,
    onProjectMenu,
    onSessionMenu,
    onDragStart: id => { dragId.current = id },
    onDragOver: setDragOverId,
    onDrop
  }
  const menuOps = {
    sessionColors,
    setMenuMode,
    closeMenu,
    commitRename,
    commitDelete,
    setProjectColor,
    setSessionColor,
    archiveSession,
    newSessionInProject,
    moveTop,
    moveBottom
  }

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
            ...flat.map(s => renderSession(s, ops)),
            view.flatTotal > flat.length
              ? h('div', { className: 'px-2 py-2 text-center text-[0.625rem] text-(--ui-text-quaternary)' }, `Showing first ${flat.length} of ${view.flatTotal}. Narrow with search.`)
              : null
          )
        )
      : h('div', { className: 'flex min-h-0 flex-1 items-center justify-center p-6' }, h(EmptyState, { title: needle ? 'No matches' : 'No sessions yet', description: needle ? 'Try a title, a word from the chat, or a project name.' : 'Sessions appear here as you chat.' }))
  } else if (!groups.length) {
    bodyNode = h('div', { className: 'flex min-h-0 flex-1 items-center justify-center p-6' }, h(EmptyState, { title: needle ? 'No matches' : 'No projects yet', description: needle ? 'Try a project name, a repo path, or a chat title.' : scope === 'projects' ? 'Create a project to group sessions.' : 'Projects and sessions will appear here.' }))
  } else {
    bodyNode = h(ScrollArea, { className: 'min-h-0 flex-1' }, h('div', { className: 'flex flex-col gap-0.5 p-1.5' }, ...groups.map(g => renderGroup(g, { ...ops, expanded: isExpanded(g) }))))
  }

  const countLabel =
    scope === 'sessions'
      ? `${view.sessionCount} session${view.sessionCount === 1 ? '' : 's'}`
      : `${view.projectCount}p · ${view.sessionCount}s${showStats && view.totalTokens ? ` · ${compactNumber(view.totalTokens)} tok` : ''}`

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
    { className: 'flex h-full min-h-0 flex-col' },
    h(ContextMenu, { menu, ops: menuOps }),
    h(
      'div',
      { className: 'flex flex-col gap-2 border-b border-(--ui-stroke-secondary) px-2.5 pb-2 pt-2.5' },
      h(
        'div',
        { className: 'flex items-center gap-1.5' },
        h(Codicon, { name: 'search-fuzzy', size: '0.875rem', className: 'text-(--ui-text-tertiary)' }),
        h('span', { className: 'text-[0.8125rem] font-semibold text-foreground' }, 'Finder'),
        h('div', { className: 'flex-1' }),
        h(ActiveContextChip, {}),
        data?.mode === 'flat'
          ? h(Tip, { label: `Project grouping unavailable (${data.treeError || 'projects.tree missing'}).` }, h(Codicon, { name: 'warning', size: '0.8125rem', className: 'text-(--ui-text-quaternary)' }))
          : null,
        headerBtn('add', 'New session', newSession),
        headerBtn('new-folder', creating ? 'Cancel new project' : 'New project', () => setCreating(c => !c), creating),
        headerBtn('graph', showStats ? 'Hide token stats' : 'Show token stats', () => setShowStats(v => !v), showStats),
        order.length ? headerBtn('clear-all', 'Reset custom order', () => setOrder([])) : null,
        grouped && groups.length ? headerBtn(anyExpanded ? 'collapse-all' : 'expand-all', anyExpanded ? 'Collapse all' : 'Expand all', toggleAll) : null,
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
        { className: 'flex items-center gap-2' },
        h(ScopeTabs, { scope, setScope }),
        h('div', { className: 'flex-1' }),
        h(Tip, { label: showStats && view.totalCost ? `Total cost ${fmtCost(view.totalCost)}` : 'Shown' }, h('span', { className: 'shrink-0 text-[0.625rem] text-(--ui-text-quaternary)' }, countLabel))
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
            h('button', { type: 'button', onClick: newProject, className: 'shrink-0 rounded-md px-2 py-0.5 text-[0.75rem] text-(--ui-accent) hover:bg-(--chrome-action-hover)' }, 'Create'),
            h('button', { type: 'button', onClick: () => setCreating(false), className: 'shrink-0 rounded-md px-2 py-0.5 text-[0.75rem] text-(--ui-text-tertiary) hover:text-foreground' }, 'Cancel')
          )
        : null
    ),
    bodyNode
  )
}

export default {
  id: ID,
  name: 'Finder - Projects & Sessions',
  register(ctx) {
    storage = ctx.storage

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

    ctx.register({
      id: 'open',
      area: PALETTE_AREA,
      data: {
        id: 'finder.open',
        label: 'Find projects & sessions',
        keywords: ['find', 'finder', 'search', 'project', 'projects', 'session', 'sessions', 'filter', 'jump'],
        run: reveal
      }
    })

    ctx.register({
      id: 'open-key',
      area: KEYBINDS_AREA,
      data: { id: 'finder.open', category: 'view', defaults: ['mod+alt+f'], label: 'Find projects & sessions', run: reveal }
    })
  }
}
