window.__ModuleLoader__.load({
  id: '@chronosun/dsh-wsl',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const base = '/dsh-wsl'
    const text = 'var(--dsw-text-primary, #1f2328)'
    const muted = 'var(--dsw-text-secondary, #6b7280)'
    const line = 'var(--dsw-border-subtle, rgba(128,128,128,.25))'
    const card = 'var(--dsw-surface-raised, rgba(127,127,127,.08))'
    const accent = 'var(--dsw-accent, #2563eb)'

    async function call(path, init) {
      const response = await fetch(base + path, { headers: { 'content-type': 'application/json' }, ...init })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
      return body
    }

    // The panel is mounted only after the user opens the WSL page, but the
    // client plugin itself loads at app start. Cache the last known list/status
    // so the tab bar paints immediately instead of waiting for `/distros` and
    // `/state` (each may spawn `wsl.exe`).
    const CACHE_KEY = 'dsh-wsl.panel-cache.v1'
    function readPanelCache() {
      const empty = { distros: [], brokers: [], settings: { users: {}, defaultDistro: '' }, idleDays: 5 }
      try {
        if (typeof localStorage === 'undefined') return empty
        const value = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null')
        if (!value || typeof value !== 'object') return empty
        return {
          distros: Array.isArray(value.distros) ? value.distros : [],
          brokers: Array.isArray(value.brokers) ? value.brokers : [],
          settings: value.settings && typeof value.settings === 'object'
            ? { users: value.settings.users || {}, defaultDistro: value.settings.defaultDistro || '' }
            : empty.settings,
          idleDays: Number.isFinite(Number(value.idleDays)) ? Number(value.idleDays) : 5,
        }
      } catch {
        return empty
      }
    }
    const panelCache = readPanelCache()
    function savePanelCache() {
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(CACHE_KEY, JSON.stringify(panelCache))
      } catch {}
    }
    let preloadStarted = false
    function preloadPanel() {
      if (preloadStarted || typeof window === 'undefined') return
      preloadStarted = true
      call('/distros').then((data) => {
        if (Array.isArray(data.distros)) {
          panelCache.distros = data.distros
          savePanelCache()
        }
      }).catch(() => {})
      call('/state').then((data) => {
        if (Array.isArray(data.brokers)) panelCache.brokers = data.brokers
        if (data.settings) panelCache.settings = { users: data.settings.users || {}, defaultDistro: data.settings.defaultDistro || '' }
        if (Number.isFinite(Number(data.idleDays))) panelCache.idleDays = Number(data.idleDays)
        savePanelCache()
      }).catch(() => {})
    }

    const toUnc = (distro, linuxPath) => `\\\\wsl.localhost\\${distro}${linuxPath.replace(/\//g, '\\')}`
    const isWslUnc = (value) => /^[\\/]{2}\??(?:wsl\.localhost|wsl\$)[\\/]/i.test(String(value ?? ''))

    const dot = (state) => h('span', {
      style: {
        display: 'inline-block', width: 8, height: 8, borderRadius: 4, marginRight: 6, flex: '0 0 auto',
        background: state === 'ready' ? '#22c55e'
          : state === 'starting' ? '#f59e0b'
          : state === 'error' ? '#ef4444' : '#9ca3af',
      },
    })

    const btn = {
      fontSize: 12, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
      border: `1px solid ${line}`, background: 'transparent', color: text,
    }
    const primary = { ...btn, background: '#247bbf', borderColor: '#247bbf', color: '#fff' }
    const input = {
      width: '100%', boxSizing: 'border-box', padding: '6px 9px', borderRadius: 6, fontSize: 12,
      border: `1px solid ${line}`, background: 'transparent', color: text, fontFamily: 'inherit',
    }
    const label = { fontSize: 12, fontWeight: 600, color: muted, textTransform: 'uppercase', letterSpacing: '.04em', margin: '0 0 6px' }

    function Icon({ size = 20 }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true,
        style: { display: 'block' }, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
      h('path', { d: 'M12 2.5c-2.3 0-4.1 1.9-4.1 4.2 0 1.4.6 2.6 1.6 3.4-1.1 1.2-1.9 2.9-2.2 4.7-.4 2.5.1 4.6 1.8 5.5 1.6.9 4.3.9 5.9 0 1.7-.9 2.2-3 1.8-5.5-.3-1.8-1.1-3.5-2.2-4.7 1-.8 1.6-2 1.6-3.4 0-2.3-1.8-4.2-4.2-4.2Z', fill: '#ffffff' }),
      h('path', { d: 'M7.4 11.3c-1.5 1-2.4 2.7-2.3 4.5.1 1 .6 1.7 1.3 2.1' }),
      h('path', { d: 'M16.6 11.3c1.5 1 2.4 2.7 2.3 4.5-.1 1-.6 1.7-1.3 2.1' }),
      h('circle', { cx: 10.2, cy: 7.8, r: 0.7, fill: 'currentColor', stroke: 'none' }),
      h('circle', { cx: 13.8, cy: 7.8, r: 0.7, fill: 'currentColor', stroke: 'none' }),
      h('path', { d: 'M10.9 9.1l1.1 1.5 1.1-1.5z', fill: 'currentColor', stroke: 'none' }),
      h('path', { d: 'M8.4 21.2c-.8 0-1.5.3-2 .8M15.6 21.2c.8 0 1.5.3 2 .8' }))
    }

    /** Browse one distro directory at a time and pick it as a workspace root. */
    function WslFolderDialog({ initialDistro = '', onClose, onCreated, workspaces, uiWorkspace }) {
      const [distros, setDistros] = useState([])
      const [distro, setDistro] = useState(initialDistro)
      const [view, setView] = useState({ path: '', parent: '/', home: '', dirs: [] })
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState('')

      const browse = useCallback(async (nextDistro, path) => {
        setLoading(true)
        try {
          const query = `?distro=${encodeURIComponent(nextDistro)}&path=${encodeURIComponent(path || '')}`
          const data = await call('/browse' + query)
          setView(data)
          setDistro(nextDistro)
          setError('')
        } catch (e) {
          setError(String(e.message || e))
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => {
        call('/distros').then((d) => {
          const list = d.distros || []
          setDistros(list)
          const first = list.includes(initialDistro) ? initialDistro : list[0]
          if (first) browse(first, '')
        }).catch((e) => setError(String(e.message || e)))
      }, [browse, initialDistro])

      const create = async () => {
        setLoading(true)
        try {
          const unc = toUnc(distro || (view.path.split('/')[1] ?? ''), view.path)
          const workspace = await workspaces.create({ path: unc })
          const workspaceId = workspace?.id ?? workspace?.workspaceId ?? workspace?.workspace?.id
          // The workspace row has no icon slot, so the WSL marker lives in the
          // title itself. Renaming right after creation keeps the sidebar
          // list visually distinguishable at a glance.
          const folder = view.path.split('/').filter(Boolean).pop() ?? 'WSL'
          try { if (workspaceId) await workspaces.rename(workspaceId, `🐧 ${folder}`) } catch {}
          onCreated?.({ distro, path: view.path, unc, workspaceId })
          if (workspaceId && uiWorkspace?.connectWorkspace) {
            await uiWorkspace.connectWorkspace(workspaceId)
          } else if (workspaceId && uiWorkspace?.startSession) {
            uiWorkspace.startSession(workspaceId)
          }
          onClose()
        } catch (e) {
          setError(String(e.message || e))
        } finally {
          setLoading(false)
        }
      }

      const row = (entry) => h('div', {
        key: entry.path,
        onClick: () => browse(distro, entry.path),
        style: { padding: '6px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 12, color: text },
        onMouseEnter: (e) => { e.currentTarget.style.background = card },
        onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
      }, '📁 ' + entry.name)

      return h('div', {
        style: {
          position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        },
        onClick: (e) => { if (e.target === e.currentTarget) onClose() },
      },
      h('div', {
        style: {
          width: 460, maxHeight: '70vh', display: 'flex', flexDirection: 'column',
          background: 'var(--dsw-surface-base, #fff)', color: text, borderRadius: 10,
          border: `1px solid ${line}`, padding: 16, gap: 10,
          boxShadow: '0 12px 40px rgba(0,0,0,.3)',
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h(Icon, { size: 16 }),
        h('b', { style: { fontSize: 13 } }, '添加 WSL 工作区'),
        h('span', { style: { flex: 1 } }),
        h('button', { type: 'button', style: btn, onClick: onClose }, '关闭')),

      h('div', null,
        h('div', { style: label }, '发行版'),
        h('select', {
          value: distro,
          onChange: (e) => browse(e.target.value, ''),
          style: { ...input, padding: '5px 8px' },
        }, distros.map((name) => h('option', { key: name, value: name }, name)))),

      h('div', null,
        h('div', { style: label }, '目录'),
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 } },
          h('button', { type: 'button', style: btn, onClick: () => browse(distro, view.parent) }, '↑'),
          h('button', { type: 'button', style: btn, onClick: () => browse(distro, view.home) }, 'home'),
          h('code', { style: { fontSize: 11, color: muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, view.path || '…')),
        h('div', {
          style: { height: 190, overflow: 'auto', border: `1px solid ${line}`, borderRadius: 8, padding: 4 },
        }, loading
          ? h('div', { style: { fontSize: 12, color: muted, padding: 8 } }, '读取中…')
          : view.dirs.length === 0
            ? h('div', { style: { fontSize: 12, color: muted, padding: 8 } }, '（没有子目录，可以直接用当前目录）')
            : view.dirs.map(row))),

      error ? h('div', { style: { fontSize: 12, color: '#b91c1c' } }, error) : null,

      h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
        h('button', { type: 'button', style: btn, onClick: onClose }, '取消'),
        h('button', { type: 'button', style: primary, disabled: loading || !view.path, onClick: create }, '使用此目录'))))
    }

    /** Dark split button: add a workspace, or pick the distro from the chevron. */
    function AddWorkspaceButton({ distros, defaultDistro, onPick }) {
      const [open, setOpen] = useState(false)
      const rootRef = useRef(null)
      useEffect(() => {
        if (!open) return undefined
        const closeOutside = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false)
        }
        const closeEscape = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('pointerdown', closeOutside)
        document.addEventListener('keydown', closeEscape)
        return () => {
          document.removeEventListener('pointerdown', closeOutside)
          document.removeEventListener('keydown', closeEscape)
        }
      }, [open])
      const plus = h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.6, strokeLinecap: 'round', 'aria-hidden': true,
      }, h('path', { d: 'M8 3v10M3 8h10' }))
      const chevron = h('svg', {
        viewBox: '0 0 16 16', width: 13, height: 13, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      }, h('path', { d: 'M4 6l4 4 4-4' }))
      const choose = (distro) => {
        setOpen(false)
        onPick(distro || defaultDistro || distros[0] || '')
      }
      return h('div', { ref: rootRef, style: { position: 'relative', display: 'inline-flex' } },
        h('div', {
          style: {
            display: 'inline-flex', alignItems: 'stretch', height: 32, borderRadius: 999,
            background: text, color: 'var(--dsw-surface-base, #fff)',
            boxShadow: '0 1px 2px rgba(0,0,0,.12)',
          },
        },
        h('button', {
          type: 'button',
          onClick: () => choose(defaultDistro),
          style: {
            border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 7,
            padding: '0 12px 0 14px', borderRadius: '999px 0 0 999px',
            fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap',
          },
        }, plus, '添加 WSL 工作区'),
        h('span', { style: { width: 1, margin: '6px 0', background: 'currentColor', opacity: 0.28 } }),
        h('button', {
          type: 'button',
          'aria-label': '选择发行版',
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          onClick: () => setOpen((value) => !value),
          style: {
            border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            padding: '0 10px', borderRadius: '0 999px 999px 0',
          },
        }, chevron)),
        open ? h('div', {
          style: {
            position: 'absolute', top: 38, right: 0, zIndex: 30, minWidth: 220,
            padding: 6, borderRadius: 9, border: `1px solid ${line}`,
            background: 'var(--dsw-surface-base, #fff)',
            boxShadow: '0 12px 32px rgba(0,0,0,.22)',
          },
        },
        h('div', { style: { padding: '4px 8px 6px', fontSize: 11, color: muted } }, '选择发行版'),
        distros.length === 0
          ? h('div', { style: { padding: '6px 8px', fontSize: 12, color: muted } }, '没有检测到 WSL 发行版')
          : distros.map((distro) => h('button', {
            key: distro,
            type: 'button',
            onClick: () => choose(distro),
            style: {
              display: 'flex', width: '100%', alignItems: 'center', gap: 8,
              border: 0, background: 'transparent', color: text, cursor: 'pointer',
              padding: '8px', borderRadius: 6, fontSize: 12, textAlign: 'left',
            },
            onMouseEnter: (event) => { event.currentTarget.style.background = card },
            onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
          },
          h('span', { style: { flex: 1 } }, distro),
          distro === defaultDistro ? h('span', { style: { fontSize: 11, color: muted } }, '默认') : null))) : null)
    }

    /** Read-only doctor snapshot plus the guided fixes that need no TTY. */
    function DoctorCard({ doctor, busy, onFix }) {
      const checks = doctor.checks || []
      const wslVersion = (doctor.wsl?.version?.lines || []).join(' · ')
      const network = doctor.network || {}
      return h('div', {
        style: { border: `1px solid ${line}`, borderRadius: 8, padding: 12, marginBottom: 14, background: card },
      },
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 12, color: muted, marginBottom: 8 } },
        h('b', { style: { color: text } }, '诊断'),
        h('span', null, wslVersion || 'WSL 版本未知'),
        h('span', null, `网络 ${network.networkingMode || '?'}`),
        h('span', null, `localhostForwarding ${network.localhostForwarding || '?'}`),
        h('span', null, doctor.settings?.defaultDistro ? `默认发行版 ${doctor.settings.defaultDistro}` : '默认发行版未设置')),
      ...checks.map((check) => h('div', {
        key: check.distro,
        style: { padding: '8px 0', borderTop: `1px solid ${line}` },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
        dot(check.error ? 'error' : check.root ? 'starting' : 'ready'),
        h('b', { style: { fontSize: 13, color: text } }, check.distro),
        h('span', { style: { fontSize: 12, color: muted } }, `${check.user || '?'}@${check.home || '?'}`),
        h('span', { style: { fontSize: 12, color: check.node?.path ? muted : '#b91c1c' } }, check.node?.version ? `node ${check.node.version}` : 'node 缺失'),
        h('span', { style: { fontSize: 12, color: muted } }, check.git?.version ? 'git ok' : 'git 缺失'),
        h('span', { style: { fontSize: 12, color: muted } }, `SSH keys ${check.keys ?? 0}`),
        h('span', { style: { fontSize: 12, color: check.path?.mntEntries > 0 ? '#b45309' : muted } }, `PATH /mnt ${check.path?.loginMntEntries ?? 0} → ${check.path?.mntEntries ?? 0}`),
        check.env?.kernel ? h('span', { style: { fontSize: 12, color: muted } }, `${check.env.kernel} · ${check.env.init || 'init?'} · docker ${check.env.docker ? '✓' : '—'} · GPU ${check.env.gpu ? '✓' : '—'}`) : null),
      check.root ? h('div', { style: { marginTop: 4, fontSize: 11, color: '#b45309' } }, '⚠ 当前以 root 运行；建议在下方设置里给该发行版指定普通用户。') : null,
      check.error ? h('div', { style: { marginTop: 4, fontSize: 11, color: '#b91c1c' } }, check.error) : null,
      h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 } },
        !check.node?.path ? h('button', { type: 'button', style: btn, disabled: busy, onClick: () => onFix(check.distro, 'node') }, busy ? '…' : '安装 Node') : null,
        (check.keys ?? 0) === 0 ? h('button', { type: 'button', style: btn, disabled: busy, onClick: () => onFix(check.distro, 'ssh-key') }, busy ? '…' : '生成 SSH key') : null,
        !check.sshConfig ? h('button', { type: 'button', style: btn, disabled: busy, onClick: () => onFix(check.distro, 'ssh-config') }, busy ? '…' : '写 SSH 配置') : null,
        check.root && !(check.users ?? []).length
          ? h('button', { type: 'button', style: btn, disabled: busy, onClick: () => onFix(check.distro, 'user') }, busy ? '…' : '创建普通用户')
          : null,
        check.node?.path && check.keys > 0 && check.sshConfig ? h('span', { style: { fontSize: 11, color: '#15803d' } }, 'SSH ready') : null))))
    }

    /** Read-only project doctor: manifests and tool availability. */
    function ProjectCard({ path, setPath, project, busy, onCheck, home, distro }) {
      return h('div', {
        style: { marginTop: 14, border: `1px solid ${line}`, borderRadius: 8, padding: 12, background: card },
      },
      h('h4', { style: { margin: '0 0 8px', fontSize: 13, color: text } }, '项目检查'),
      h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
        h('input', {
          type: 'text',
          value: path,
          placeholder: home ? `${home}/project` : '/home/<user>/project',
          onChange: (event) => setPath(event.target.value),
          style: { ...input, flex: '1 1 260px', minWidth: 180 },
        }),
        h('button', {
          type: 'button', style: btn, disabled: busy || !distro,
          onClick: onCheck,
        }, busy ? '检查中…' : '检查项目')),
      project ? h('div', { style: { marginTop: 8, fontSize: 12, color: muted, lineHeight: 1.7 } },
        h('div', { style: { color: text } }, `${project.distro || distro} · ${project.path}`),
        h('pre', {
          style: {
            margin: '6px 0 0', padding: '8px 10px', borderRadius: 6, fontSize: 11, lineHeight: 1.5,
            background: 'transparent', border: `1px solid ${line}`, color: text, whiteSpace: 'pre-wrap',
            maxHeight: 240, overflow: 'auto',
          },
        }, project.error || project.report || '（没有输出）'))
        : h('div', { style: { marginTop: 8, fontSize: 11, color: muted } }, '只读：列出 manifest、已找到的工具和缺失项，不安装任何东西。'))
    }

    return {
      inject: ['slots', 'workspaces', 'uiWorkspace'],
      apply(ctx) {
        preloadPanel()
        function Panel() {
          const [distros, setDistros] = useState(panelCache.distros)
          const [state, setState] = useState({ brokers: panelCache.brokers, idleDays: panelCache.idleDays })
          const [busy, setBusy] = useState('')
          const [error, setError] = useState('')
          const [notice, setNotice] = useState('')
          const [picking, setPicking] = useState(false)
          const [pickerDistro, setPickerDistro] = useState('')
          const [settings, setSettings] = useState(panelCache.settings)
          const [selectedDistro, setSelectedDistro] = useState(panelCache.settings.defaultDistro || panelCache.distros[0] || '')
          const [loaded, setLoaded] = useState(panelCache.distros.length > 0)
          const [doctor, setDoctor] = useState(null)
          const [doctorBusy, setDoctorBusy] = useState(false)
          const [doctorMsg, setDoctorMsg] = useState('')
          const [projectPath, setProjectPath] = useState('')
          const [project, setProject] = useState(null)
          const [projectBusy, setProjectBusy] = useState(false)

          const refresh = useCallback(async () => {
            try {
              const [d, s] = await Promise.all([call('/distros'), call('/state')])
              const list = d.distros || []
              const idleDays = s.idleDays ?? s.settings?.idleDays ?? 5
              const nextSettings = s.settings
                ? { users: s.settings.users || {}, defaultDistro: s.settings.defaultDistro || '' }
                : panelCache.settings
              setDistros(list)
              setSelectedDistro((prev) => {
                if (list.includes(prev)) return prev
                const preferred = s.settings?.defaultDistro
                if (preferred && list.includes(preferred)) return preferred
                return list[0] || ''
              })
              setState({ ...s, brokers: s.brokers || [], idleDays })
              setSettings(nextSettings)
              panelCache.distros = list
              panelCache.brokers = s.brokers || []
              panelCache.settings = nextSettings
              panelCache.idleDays = idleDays
              savePanelCache()
              setLoaded(true)
              setError('')
            } catch (e) {
              setError(String(e.message || e))
            }
          }, [])

          useEffect(() => {
            refresh()
            const timer = setInterval(refresh, 3000)
            return () => clearInterval(timer)
          }, [refresh])

          const act = async (kind, distro) => {
            setBusy(kind + ':' + distro)
            try {
              await call('/' + kind, { method: 'POST', body: JSON.stringify({ distro }) })
              await refresh()
            } catch (e) {
              setError(String(e.message || e))
            } finally {
              setBusy('')
            }
          }

          const runDoctor = useCallback(async () => {
            setDoctorBusy(true)
            setDoctorMsg('')
            try {
              const result = await call('/doctor')
              setDoctor(result)
              if (result.settings) setSettings({ users: result.settings.users || {}, defaultDistro: result.settings.defaultDistro || '' })
            } catch (e) {
              setDoctorMsg(String(e.message || e))
            } finally {
              setDoctorBusy(false)
            }
          }, [])

          const fix = async (distro, action) => {
            setDoctorBusy(true)
            setDoctorMsg(action === 'node' ? `正在为 ${distro} 安装 Node…` : action === 'user' ? `正在为 ${distro} 创建普通用户…` : `正在处理 ${action}…`)
            try {
              const result = await call('/doctor/fix', { method: 'POST', body: JSON.stringify({ distro, action }) })
              if (action === 'ssh-key') setDoctorMsg(`公钥（把它加到设备）：\n${result.out || result.err || '（没有输出）'}`)
              else if (action === 'ssh-config') setDoctorMsg(`SSH 配置：\n${result.out || result.err || '（没有输出）'}`)
              else if (action === 'user') setDoctorMsg(`已创建 ${result.name || 'chronos'}：\n${result.out || result.err || '（没有输出）'}`)
              else setDoctorMsg(result.out || result.err || `exit ${result.code}`)
              const next = await call('/doctor')
              setDoctor(next)
              if (next.settings) setSettings({ users: next.settings.users || {}, defaultDistro: next.settings.defaultDistro || '' })
            } catch (e) {
              setDoctorMsg(String(e.message || e))
            } finally {
              setDoctorBusy(false)
            }
          }

          const saveSettings = async (patch) => {
            const next = {
              users: { ...settings.users, ...(patch.users || {}) },
              defaultDistro: patch.defaultDistro === undefined ? settings.defaultDistro : patch.defaultDistro,
            }
            setSettings(next)
            try {
              const saved = await call('/settings', { method: 'POST', body: JSON.stringify(next) })
              setSettings({ users: saved.users || {}, defaultDistro: saved.defaultDistro || '' })
              setNotice('设置已保存')
            } catch (e) {
              setError(String(e.message || e))
            }
          }

          const brokerFor = (name) => {
            const candidates = state.brokers.filter((b) => (b.distro || '') === name)
            const user = settings.users[name] ?? ''
            const exact = candidates.filter((b) => (b.user || '') === user)
            return exact.find((b) => b.state === 'ready' || b.state === 'starting')
              ?? exact[0]
              ?? candidates.find((b) => b.state === 'ready' || b.state === 'starting')
              ?? candidates[0]
          }
          const selectedName = selectedDistro || settings.defaultDistro || distros[0] || ''
          const selectedBroker = brokerFor(selectedName)
          const selectedState = selectedBroker?.state ?? 'detached'
          const selectedCheck = doctor?.checks?.find((entry) => entry.distro === selectedName)
          const selectedHello = selectedBroker?.hello ?? (selectedCheck
            ? { user: selectedCheck.user, home: selectedCheck.home, node: selectedCheck.node?.path }
            : null)
          const selectedWorking = busy.endsWith(':' + selectedName)
          const nodeReady = Boolean(selectedHello?.node)
          const nodeMissing = Boolean(selectedCheck && !selectedCheck.node?.path)
          const checkProject = async () => {
            const path = projectPath.trim() || selectedHello?.home || ''
            if (!path) {
              setError('请输入 WSL 里的项目绝对路径')
              return
            }
            setProjectBusy(true)
            try {
              const query = new URLSearchParams({
                distro: selectedName,
                user: selectedHello?.user || '',
                path,
              })
              setProject(await call('/doctor/project?' + query.toString()))
              setError('')
            } catch (e) {
              setError(String(e.message || e))
            } finally {
              setProjectBusy(false)
            }
          }

          const tab = (name) => {
            const active = name === selectedName
            return h('button', {
              key: name,
              type: 'button',
              onClick: () => setSelectedDistro(name),
              style: {
                border: 0, cursor: 'pointer', padding: '7px 0 8px', marginBottom: -1,
                background: 'transparent',
                color: active ? accent : muted, fontSize: 13, fontWeight: active ? 600 : 400,
                borderBottom: active ? `2px solid ${accent}` : '2px solid transparent',
                whiteSpace: 'nowrap',
              },
            }, name)
          }

          return h('div', { style: { padding: '18px 24px', width: '100%', maxWidth: 1180, boxSizing: 'border-box', color: text, fontSize: 13 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
            h(Icon, { size: 20 }),
            h('h2', { style: { margin: 0, fontSize: 15, fontWeight: 600, flex: 1 } }, 'WSL'),
            h('button', {
              type: 'button', style: btn,
              onClick: async () => {
                setError('')
                setNotice('')
                try {
                  const { workspaces: list } = await call('/workspaces')
                  let marked = 0
                  for (const w of list) {
                    if (!isWslUnc(w.path)) continue
                    if (!w.id || String(w.title ?? '').startsWith('🐧')) continue
                    const folder = String(w.path).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'WSL'
                    await ctx.workspaces.rename(w.id, `🐧 ${folder}`)
                    marked += 1
                  }
                  setNotice(marked > 0 ? `已标记 ${marked} 个 WSL 工作区` : '所有 WSL 工作区都已标记，无需操作。')
                } catch (e) {
                  setError(String(e.message || e))
                }
              },
            }, '标记已有'),
            h('button', {
              type: 'button',
              'aria-label': '帮助',
              title: [
                '选一个发行版里的目录作为工作区；WSL 模式会话会在该发行版里执行 bash、后台任务和终端。',
                state.idleDays === 0 ? '不会因空闲自动断开 helper，发行版本身保持运行。' : `空闲 ${state.idleDays} 天后自动断开 helper，发行版本身保持运行。`,
                state.presetDefault?.installed
                  ? 'WSL 工作区（\\\\wsl.localhost\\...）里新建的会话默认使用 WSL 模式，显式选择其他模式时除外；Windows 工作区不受影响。'
                  : '默认预设注入未生效：若新建会话仍不是 WSL 模式，请重启 DSH 后再试。',
              ].join('\n'),
              style: { ...btn, width: 28, height: 28, padding: 0, borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
            }, '?'),
            h(AddWorkspaceButton, {
              distros,
              defaultDistro: settings.defaultDistro,
              onPick: (distro) => { setPickerDistro(distro); setPicking(true) },
            })),

          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 12px', flexWrap: 'wrap' } },
            h('button', { type: 'button', style: btn, disabled: doctorBusy, onClick: runDoctor }, doctorBusy ? '诊断中…' : '运行诊断'),
            h('span', { style: { fontSize: 12, color: muted } }, '检查 Node / SSH / PATH / 网络'),
            state.capabilities && Object.values(state.capabilities).some((ok) => !ok)
              ? h('span', { style: { fontSize: 12, color: '#b45309' } }, '部分宿主能力缺失（见诊断）')
              : null),

          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' } },
          h('div', { style: { flex: '1 1 340px', minWidth: 300, maxWidth: 430, display: 'flex', flexDirection: 'column' } },
          h('h3', { style: label }, '设置'),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 } },
            h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: muted } },
              '默认发行版',
              h('select', {
                value: settings.defaultDistro || '',
                onChange: (event) => saveSettings({ defaultDistro: event.target.value }),
                style: { ...input, width: 180, padding: '4px 8px' },
              },
              h('option', { value: '' }, '（未设置）'),
              distros.map((name) => h('option', { key: name, value: name }, name)))),

          error ? h('div', {
            style: { marginBottom: 12, padding: '8px 10px', borderRadius: 6, fontSize: 12, color: '#b91c1c', background: 'rgba(239,68,68,.08)' },
          }, error) : null,

          notice ? h('div', {
            style: { marginBottom: 12, padding: '8px 10px', borderRadius: 6, fontSize: 12, color: '#15803d', background: 'rgba(34,197,94,.10)' },
          }, notice) : null,

          h('h3', { style: label }, '发行版'),
          distros.length === 0
            ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 24, minHeight: 34, borderBottom: `1px solid ${line}`, marginBottom: 14 } },
              h('span', { style: { fontSize: 13, color: muted, padding: '7px 0 8px' } }, loaded ? '没有检测到 WSL 发行版' : '加载发行版…'))
            : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 24, borderBottom: `1px solid ${line}`, marginBottom: 14 } }, distros.map(tab)),
          selectedName && distros.length > 0 ? h('div', {
            style: { border: `1px solid ${line}`, borderRadius: 8, padding: 12, background: card },
          },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            dot(selectedState),
            h('b', { style: { fontSize: 13, color: text } }, selectedName),
            h('span', { style: { fontSize: 12, color: muted } }, selectedState),
            h('span', { style: { flex: 1 } }),
            h('button', {
              type: 'button',
              disabled: selectedWorking || !selectedName,
              onClick: () => act(selectedState === 'detached' || selectedState === 'error' ? 'connect' : 'disconnect', selectedName),
              style: btn,
            }, selectedWorking ? '…' : (selectedState === 'detached' || selectedState === 'error' ? '连接' : '断开'))),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 10, fontSize: 12 } },
            dot(nodeReady ? 'ready' : nodeMissing ? 'error' : 'starting'),
            h('span', { style: { color: nodeReady ? muted : nodeMissing ? '#b45309' : muted } },
              nodeReady ? 'Linux Node ready' : nodeMissing ? 'Linux Node 缺失' : 'Linux Node 未检查'),
            nodeMissing ? h('button', {
              type: 'button', disabled: doctorBusy,
              onClick: () => fix(selectedName, 'node'), style: btn,
            }, doctorBusy ? '…' : '安装 Node') : null,
            h('span', { style: { flex: 1 } }),
            h('button', {
              type: 'button', disabled: doctorBusy,
              onClick: runDoctor, style: btn,
            }, doctorBusy ? '检查中…' : doctor ? '重新检查' : '检查环境')),
          h('div', { style: { marginTop: 8, fontSize: 12, color: muted, lineHeight: 1.8 } },
            h('div', null, selectedHello ? `${selectedHello.user}@${selectedHello.home}` : '未连接'),
            h('div', null, 'node: ', h('span', { style: { color: nodeReady ? muted : '#b45309' } }, selectedHello?.node || '未检测')),
            h('div', null, '引用计数: ', String(selectedBroker?.refcount ?? 0))),
          selectedBroker?.lastError ? h('div', {
            style: { marginTop: 6, fontSize: 11, lineHeight: 1.5, color: '#b91c1c', wordBreak: 'break-word' },
          }, selectedBroker.lastError) : null,
          !doctor ? h('div', { style: { marginTop: 8, fontSize: 11, color: muted } }, '点“检查环境”查看 Node / SSH / PATH / 网络；不会自动诊断。') : null) : null,

          h('div', { style: { marginTop: 18, paddingTop: 14, borderTop: `1px solid ${line}` } },
            h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: muted } },
              '空闲断开（天）',
              h('input', {
                type: 'number', min: 0, step: 1, value: state.idleDays,
                onChange: async (event) => {
                  const days = Number(event.target.value)
                  setState((prev) => ({ ...prev, idleDays: days }))
                  try {
                    const saved = await call('/idle', { method: 'POST', body: JSON.stringify({ days }) })
                    setState((prev) => ({ ...prev, idleDays: saved.idleDays }))
                  } catch (e) { setError(String(e.message || e)) }
                },
                style: { ...input, width: 72 },
              }),
              '0 = 永不自动断开')),

          ),
          h('div', { style: { flex: '2 1 560px', minWidth: 0 } },
            h('h3', { style: label }, '诊断与修复'),
            doctorMsg ? h('pre', {
              style: {
                margin: '0 0 14px', padding: '8px 10px', borderRadius: 6, fontSize: 11, lineHeight: 1.5,
                background: card, border: `1px solid ${line}`, color: text, whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto',
              },
            }, doctorMsg) : null,
            doctor ? h(DoctorCard, { doctor, busy: doctorBusy, onFix: fix })
              : h('div', {
                style: { border: `1px solid ${line}`, borderRadius: 8, padding: 18, background: card, color: muted, fontSize: 12, lineHeight: 1.7 },
              }, '点击“运行诊断”查看每个发行版的 Node、SSH、PATH、网络状态和修复按钮；结果会显示在这里。'),
            h(ProjectCard, {
              path: projectPath,
              setPath: setProjectPath,
              project,
              busy: projectBusy,
              onCheck: checkProject,
              home: selectedHello?.home,
              distro: selectedName,
            })),

          picking ? h(WslFolderDialog, {
            initialDistro: pickerDistro,
            onClose: () => { setPicking(false); setPickerDistro('') },
            onCreated: () => refresh(),
            workspaces: ctx.workspaces,
            uiWorkspace: ctx.uiWorkspace,
          }) : null)))
        }

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'wsl', order: 20, label: 'WSL',
        }, Icon))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'wsl',
        }, Panel))
      },
    }
  },
})
