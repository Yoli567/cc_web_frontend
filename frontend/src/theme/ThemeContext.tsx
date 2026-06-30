/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

export type ThemeMode = 'dark' | 'light'
export type ThemePalette = 'orange' | 'pink' | 'purple' | 'green' | 'brown'
export type FontTarget = 'english' | 'chinese'

export interface CustomFont {
  id: string
  name: string
  url: string
}

interface PaletteDefinition {
  label: string
  primary: string
  primaryDeep: string
  primarySoftDark: string
  primarySoftLight: string
  accent: string
  accentSoft: string
  rgb: string
}

const palettes: Record<ThemePalette, PaletteDefinition> = {
  orange: {
    label: 'Clay',
    primary: '#C2785A',
    primaryDeep: '#A8634A',
    primarySoftDark: 'rgba(194, 120, 90, 0.13)',
    primarySoftLight: '#F0E6DF',
    accent: '#B8899A',
    accentSoft: '#D0A3B1',
    rgb: '194, 120, 90',
  },
  pink: {
    label: 'Rose',
    primary: '#B8899A',
    primaryDeep: '#9E7485',
    primarySoftDark: 'rgba(184, 137, 154, 0.14)',
    primarySoftLight: '#F0E4EA',
    accent: '#C2785A',
    accentSoft: '#D7A18C',
    rgb: '184, 137, 154',
  },
  purple: {
    label: 'Mauve',
    primary: '#9283A8',
    primaryDeep: '#7C6E91',
    primarySoftDark: 'rgba(146, 131, 168, 0.15)',
    primarySoftLight: '#E9E3F0',
    accent: '#B8899A',
    accentSoft: '#D0A3B1',
    rgb: '146, 131, 168',
  },
  green: {
    label: 'Sage',
    primary: '#8A9E87',
    primaryDeep: '#738770',
    primarySoftDark: 'rgba(138, 158, 135, 0.15)',
    primarySoftLight: '#E4ECE3',
    accent: '#C2785A',
    accentSoft: '#D7A18C',
    rgb: '138, 158, 135',
  },
  brown: {
    label: 'Walnut',
    primary: '#9A7A62',
    primaryDeep: '#80634F',
    primarySoftDark: 'rgba(154, 122, 98, 0.16)',
    primarySoftLight: '#E9DFD6',
    accent: '#8A9E87',
    accentSoft: '#A7B8A4',
    rgb: '154, 122, 98',
  },
}

interface ThemeContextValue {
  mode: ThemeMode
  palette: ThemePalette
  palettes: Record<ThemePalette, PaletteDefinition>
  backgrounds: Record<ThemeMode, string>
  selectedFonts: Record<FontTarget, string>
  customFonts: Record<FontTarget, CustomFont[]>
  liquidGlass: boolean
  surfaceOpacity: number
  cabinBubble: boolean
  cabinBackground: boolean
  setMode: (mode: ThemeMode) => void
  setPalette: (palette: ThemePalette) => void
  setBackground: (mode: ThemeMode, dataUrl: string) => void
  clearBackground: (mode: ThemeMode) => void
  setSelectedFont: (target: FontTarget, fontId: string) => void
  addCustomFont: (target: FontTarget, file: File) => Promise<void>
  deleteCustomFont: (target: FontTarget, fontId: string) => void
  setLiquidGlass: (value: boolean) => void
  setSurfaceOpacity: (value: number) => void
  setCabinBubble: (value: boolean) => void
  setCabinBackground: (value: boolean) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

const storedMode = () => localStorage.getItem('cc-theme-mode') as ThemeMode | null
const storedPalette = () => localStorage.getItem('cc-theme-palette') as ThemePalette | null
const storedBackgrounds = (): Record<ThemeMode, string> => ({
  dark: localStorage.getItem('cc-bg-dark') ?? '',
  light: localStorage.getItem('cc-bg-light') ?? '',
})
const CUSTOM_FONT_META_KEYS: Record<FontTarget, string> = {
  english: 'cc-custom-fonts-en',
  chinese: 'cc-custom-fonts-zh',
}
const SELECTED_FONT_KEYS: Record<FontTarget, string> = {
  english: 'cc-font-en',
  chinese: 'cc-font-zh',
}
const storedSelectedFonts = (): Record<FontTarget, string> => ({
  english: normalizeStoredFontChoice(localStorage.getItem(SELECTED_FONT_KEYS.english)),
  chinese: normalizeStoredFontChoice(localStorage.getItem(SELECTED_FONT_KEYS.chinese)),
})
const storedCustomFontMeta = (): Record<FontTarget, CustomFont[]> => ({
  english: loadCustomFontMeta('english'),
  chinese: loadCustomFontMeta('chinese'),
})

const FONT_DB_NAME = 'cc-font-assets'
const FONT_STORE_NAME = 'fonts'
const SURFACE_OPACITY_KEY = 'cc-surface-opacity'

function storedSurfaceOpacity() {
  const raw = Number(localStorage.getItem(SURFACE_OPACITY_KEY))
  return Number.isFinite(raw) ? Math.min(100, Math.max(25, raw)) : 76
}

function openFontDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(FONT_DB_NAME, 1)

    request.onupgradeneeded = () => {
      request.result.createObjectStore(FONT_STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function saveFontBlob(key: string, file: File) {
  const db = await openFontDb()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(FONT_STORE_NAME, 'readwrite')
    tx.objectStore(FONT_STORE_NAME).put(file, key)
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
    tx.onerror = () => {
      db.close()
      reject(tx.error)
    }
  })
}

async function loadFontBlob(key: string) {
  const db = await openFontDb()
  return new Promise<Blob | null>((resolve, reject) => {
    const tx = db.transaction(FONT_STORE_NAME, 'readonly')
    const request = tx.objectStore(FONT_STORE_NAME).get(key)
    request.onsuccess = () => resolve(request.result ?? null)
    request.onerror = () => reject(request.error)
    tx.oncomplete = () => db.close()
    tx.onerror = () => {
      db.close()
      reject(tx.error)
    }
  })
}

async function deleteFontBlob(key: string) {
  const db = await openFontDb()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(FONT_STORE_NAME, 'readwrite')
    tx.objectStore(FONT_STORE_NAME).delete(key)
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
    tx.onerror = () => {
      db.close()
      reject(tx.error)
    }
  })
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => storedMode() ?? 'dark')
  const [palette, setPaletteState] = useState<ThemePalette>(() => storedPalette() ?? 'orange')
  const [backgrounds, setBackgrounds] = useState<Record<ThemeMode, string>>(storedBackgrounds)
  const [selectedFonts, setSelectedFonts] = useState<Record<FontTarget, string>>(storedSelectedFonts)
  const [customFonts, setCustomFonts] = useState<Record<FontTarget, CustomFont[]>>(storedCustomFontMeta)
  const [liquidGlass, setLiquidGlassState] = useState(() => localStorage.getItem('cc-liquid-glass') === 'true')
  const [surfaceOpacity, setSurfaceOpacityState] = useState(storedSurfaceOpacity)
  const [cabinBubble, setCabinBubbleState] = useState(() => localStorage.getItem('cc-cabin-bubble') !== 'false')
  const [cabinBackground, setCabinBackgroundState] = useState(() => localStorage.getItem('cc-cabin-bg') !== 'false')

  const setMode = (value: ThemeMode) => {
    setModeState(value)
    localStorage.setItem('cc-theme-mode', value)
  }

  const setPalette = (value: ThemePalette) => {
    setPaletteState(value)
    localStorage.setItem('cc-theme-palette', value)
  }

  const setBackground = (targetMode: ThemeMode, dataUrl: string) => {
    setBackgrounds((current) => ({ ...current, [targetMode]: dataUrl }))
    localStorage.setItem(`cc-bg-${targetMode}`, dataUrl)
  }

  const clearBackground = (targetMode: ThemeMode) => {
    setBackgrounds((current) => ({ ...current, [targetMode]: '' }))
    localStorage.removeItem(`cc-bg-${targetMode}`)
  }

  const setSelectedFont = (target: FontTarget, fontId: string) => {
    const normalized = fontId || 'system'
    setSelectedFonts((current) => ({ ...current, [target]: normalized }))
    localStorage.setItem(SELECTED_FONT_KEYS[target], normalized)
  }

  const addCustomFont = useCallback(async (target: FontTarget, file: File) => {
    const id = `${target}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await saveFontBlob(id, file)
    const objectUrl = URL.createObjectURL(file)
    const font = { id, name: file.name.replace(/\.[^.]+$/, '') || `Custom ${Date.now()}`, url: objectUrl }
    setCustomFonts((current) => {
      const next = { ...current, [target]: [...current[target], font] }
      persistCustomFontMeta(target, next[target])
      return next
    })
    setSelectedFonts((current) => ({ ...current, [target]: id }))
    localStorage.setItem(SELECTED_FONT_KEYS[target], id)
  }, [])

  const setLiquidGlass = (value: boolean) => {
    setLiquidGlassState(value)
    localStorage.setItem('cc-liquid-glass', String(value))
  }

  const setSurfaceOpacity = (value: number) => {
    const normalized = Math.min(100, Math.max(25, Math.round(value)))
    setSurfaceOpacityState(normalized)
    localStorage.setItem(SURFACE_OPACITY_KEY, String(normalized))
  }

  const setCabinBubble = (value: boolean) => {
    setCabinBubbleState(value)
    localStorage.setItem('cc-cabin-bubble', String(value))
  }

  const setCabinBackground = (value: boolean) => {
    setCabinBackgroundState(value)
    localStorage.setItem('cc-cabin-bg', String(value))
  }

  const deleteCustomFont = useCallback((target: FontTarget, fontId: string) => {
    void deleteFontBlob(fontId)
    if (fontId === `${target}-legacy`) void deleteFontBlob(target)
    setCustomFonts((current) => {
      const removed = current[target].find((font) => font.id === fontId)
      if (removed?.url.startsWith('blob:')) URL.revokeObjectURL(removed.url)
      const nextFonts = current[target].filter((font) => font.id !== fontId)
      persistCustomFontMeta(target, nextFonts)
      return { ...current, [target]: nextFonts }
    })
    setSelectedFonts((current) => {
      if (current[target] !== fontId) return current
      localStorage.setItem(SELECTED_FONT_KEYS[target], 'system')
      return { ...current, [target]: 'system' }
    })
  }, [])

  useEffect(() => {
    let cancelled = false

    ;(['english', 'chinese'] as FontTarget[]).forEach((target) => {
      customFonts[target].forEach((font) => {
        void loadFontBlob(font.id).then((blob) => {
          if (!blob || cancelled) return
          const objectUrl = URL.createObjectURL(blob)
          setCustomFonts((current) => ({
            ...current,
            [target]: current[target].map((item) =>
              item.id === font.id ? { ...item, url: objectUrl } : item,
            ),
          }))
        }).catch(() => {
          // Font loading is optional; Settings can replace a failed font.
        })
      })

      void loadFontBlob(target).then((blob) => {
        if (!blob || cancelled) return
        const legacyId = `${target}-legacy`
        if (customFonts[target].some((font) => font.id === legacyId)) return
        const objectUrl = URL.createObjectURL(blob)
        const legacyFont = { id: legacyId, name: 'Custom 1', url: objectUrl }
        setCustomFonts((current) => {
          if (current[target].some((font) => font.id === legacyId)) return current
          const nextFonts = [legacyFont, ...current[target]]
          persistCustomFontMeta(target, nextFonts)
          return { ...current, [target]: nextFonts }
        })
        setSelectedFonts((current) => {
          if (current[target] !== 'custom') return current
          localStorage.setItem(SELECTED_FONT_KEYS[target], legacyId)
          return { ...current, [target]: legacyId }
        })
      }).catch(() => {
        // Font loading is optional; Settings can replace a failed font.
      })
    })

    return () => {
      cancelled = true
    }
  // Intentionally only performs initial IndexedDB hydration.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const cssVars = useMemo(
    () => buildThemeVars(
      mode,
      palettes[palette],
      backgrounds[mode],
      selectedFonts,
      customFonts,
      surfaceOpacity,
    ),
    [mode, palette, backgrounds, selectedFonts, customFonts, surfaceOpacity],
  )

  useEffect(() => {
    document.documentElement.style.background = mode === 'dark' ? '#211f1b' : '#f5f3ee'
  }, [mode])

  useEffect(() => {
    const styleId = 'cc-custom-font-faces'
    const existing = document.getElementById(styleId)
    existing?.remove()

    const allFonts = [...customFonts.english, ...customFonts.chinese].filter((font) => font.url)
    if (allFonts.length === 0) return

    const style = document.createElement('style')
    style.id = styleId
    style.textContent = `
      ${customFonts.english.map((font) => font.url ? `@font-face { font-family: "${fontFaceName('english', font.id)}"; src: url("${font.url}"); font-display: block; unicode-range: U+0000-024F, U+1E00-1EFF; }` : '').join('\n')}
      ${customFonts.chinese.map((font) => font.url ? `@font-face { font-family: "${fontFaceName('chinese', font.id)}"; src: url("${font.url}"); font-display: block; unicode-range: U+2E80-9FFF, U+F900-FAFF, U+20000-2A6DF, U+2A700-2B73F, U+2B740-2B81F, U+2B820-2CEAF, U+3000-303F, U+FF00-FFEF; }` : '').join('\n')}
    `
    document.head.appendChild(style)

    void document.fonts.ready

    return () => style.remove()
  }, [customFonts])

  const value = useMemo(
    () => ({
      mode,
      palette,
      palettes,
      backgrounds,
      selectedFonts,
      customFonts,
      liquidGlass,
      surfaceOpacity,
      setMode,
      setPalette,
      setBackground,
      clearBackground,
      setSelectedFont,
      setLiquidGlass,
      setSurfaceOpacity,
      cabinBubble,
      cabinBackground,
      addCustomFont,
      deleteCustomFont,
      setCabinBubble,
      setCabinBackground,
    }),
    [mode, palette, backgrounds, selectedFonts, customFonts, liquidGlass, surfaceOpacity, cabinBubble, cabinBackground, addCustomFont, deleteCustomFont],
  )

  return (
    <ThemeContext.Provider value={value}>
      <div
        className="h-full"
        data-theme={mode}
        data-palette={palette}
        data-glass={liquidGlass ? 'liquid' : 'soft'}
        style={cssVars}
      >
        {liquidGlass && <style>{liquidGlassRuntimeCss}</style>}
        {children}
      </div>
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used inside ThemeProvider')
  }
  return context
}

const SYSTEM_EN_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
const SYSTEM_ZH_STACK = '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif'
const SYSTEM_EN_PRIMARY = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui'
const SYSTEM_ZH_PRIMARY = '"Noto Sans SC", "PingFang SC", "Microsoft YaHei"'

function normalizeStoredFontChoice(value: string | null) {
  if (!value || value === 'serif' || value === 'rounded' || value === 'mono') return 'system'
  return value
}

function loadCustomFontMeta(target: FontTarget): CustomFont[] {
  try {
    const raw = localStorage.getItem(CUSTOM_FONT_META_KEYS[target])
    if (!raw) return []
    const parsed = JSON.parse(raw) as Array<Partial<CustomFont>>
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((font): font is Pick<CustomFont, 'id' | 'name'> =>
        typeof font.id === 'string' && typeof font.name === 'string',
      )
      .map((font) => ({ id: font.id, name: font.name, url: '' }))
  } catch {
    return []
  }
}

function persistCustomFontMeta(target: FontTarget, fonts: CustomFont[]) {
  localStorage.setItem(
    CUSTOM_FONT_META_KEYS[target],
    JSON.stringify(fonts.map(({ id, name }) => ({ id, name }))),
  )
}

function fontFaceName(target: FontTarget, id: string) {
  return `CC ${target} ${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

function customFontStack(target: FontTarget, selectedId: string, fonts: Record<FontTarget, CustomFont[]>) {
  if (selectedId === 'system') return null
  const font = fonts[target].find((item) => item.id === selectedId)
  return font ? `"${fontFaceName(target, font.id)}"` : null
}

const liquidGlassRuntimeCss = `
  [data-glass='liquid'] .cc-header,
  [data-glass='liquid'] .cc-composer-menu,
  [data-glass='liquid'] .cc-reply-preview,
  [data-glass='liquid'] .cc-message-search-panel,
  [data-glass='liquid'] .cc-selection-toolbar,
  [data-glass='liquid'] .cc-message-action-menu,
  [data-glass='liquid'] .cc-load-all-btn,
  [data-glass='liquid'] .cc-saved-search-card,
  [data-glass='liquid'] .cc-activity-calendar,
  [data-glass='liquid'] .cc-tool-use-panel,
  [data-glass='liquid'] .cc-tool-use-pill,
  [data-glass='liquid'] .cc-voice-transcript-btn,
  [data-glass='liquid'] .cc-recording-overlay,
  [data-glass='liquid'] .cc-composer,
  [data-glass='liquid'] .cc-composer-plus,
  [data-glass='liquid'] .cc-composer-action,
  [data-glass='liquid'] .cc-cabin-nav-button,
  [data-glass='liquid'] .cc-cabin-search-button {
    backdrop-filter: blur(4px) saturate(180%);
    -webkit-backdrop-filter: blur(4px) saturate(180%);
  }

  [data-glass='liquid'] .cc-sidebar {
    backdrop-filter: blur(28px) saturate(180%);
    -webkit-backdrop-filter: blur(28px) saturate(180%);
  }

  [data-glass='liquid'] .cc-scroll-bottom-button {
    background: color-mix(in srgb, var(--cc-glass) 42%, transparent);
    backdrop-filter: blur(6px) saturate(190%);
    -webkit-backdrop-filter: blur(6px) saturate(190%);
  }

  [data-glass='liquid'] .cc-recording-overlay {
    backdrop-filter: blur(6px) saturate(190%);
    -webkit-backdrop-filter: blur(6px) saturate(190%);
  }

  [data-glass='liquid'] .cc-settings-modal-root {
    background: rgba(0, 0, 0, 0.06);
    backdrop-filter: blur(16px) saturate(130%);
    -webkit-backdrop-filter: blur(16px) saturate(130%);
  }

  [data-glass='liquid'] .cc-settings-modal-backdrop {
    background:
      linear-gradient(rgba(0, 0, 0, 0.08), rgba(0, 0, 0, 0.08)),
      color-mix(in srgb, var(--cc-glass) 8%, transparent);
    backdrop-filter: blur(30px) saturate(145%);
    -webkit-backdrop-filter: blur(30px) saturate(145%);
  }

  [data-theme='light'][data-glass='liquid'] .cc-settings-modal-panel {
    background:
      linear-gradient(rgba(255, 255, 255, 0.78), rgba(255, 255, 255, 0.78)),
      color-mix(in srgb, var(--cc-glass) 26%, var(--cc-card-solid));
    backdrop-filter: blur(18px) saturate(150%);
    -webkit-backdrop-filter: blur(18px) saturate(150%);
  }

  [data-theme='dark'][data-glass='liquid'] .cc-settings-modal-panel {
    background:
      linear-gradient(rgba(27, 25, 21, 0.78), rgba(27, 25, 21, 0.78)),
      color-mix(in srgb, var(--cc-glass) 26%, var(--cc-card-solid));
    backdrop-filter: blur(18px) saturate(150%);
    -webkit-backdrop-filter: blur(18px) saturate(150%);
  }

  [data-glass='liquid'] .cc-settings-textarea {
    background: color-mix(in srgb, var(--cc-card-solid) 92%, var(--cc-input) 8%);
  }

  [data-theme='light'][data-glass='liquid'] .cc-activity-calendar {
    background: rgba(245, 243, 238, 0.24);
    background: color-mix(in srgb, var(--cc-glass) 22%, transparent);
    backdrop-filter: blur(6px) saturate(180%);
    -webkit-backdrop-filter: blur(6px) saturate(180%);
  }

  [data-theme='dark'][data-glass='liquid'] .cc-activity-calendar {
    background: rgba(33, 31, 27, 0.22);
    background: color-mix(in srgb, var(--cc-glass) 22%, transparent);
    backdrop-filter: blur(6px) saturate(180%);
    -webkit-backdrop-filter: blur(6px) saturate(180%);
  }
`

function buildThemeVars(
  mode: ThemeMode,
  palette: PaletteDefinition,
  background: string,
  selectedFonts: Record<FontTarget, string>,
  customFonts: Record<FontTarget, CustomFont[]>,
  surfaceOpacity: number,
): CSSProperties {
  const isDark = mode === 'dark'
  const hasBackground = background.length > 0
  const selectedEnglish = customFontStack('english', selectedFonts.english, customFonts)
  const selectedChinese = customFontStack('chinese', selectedFonts.chinese, customFonts)
  const englishStack = selectedEnglish ? `${selectedEnglish}, ${SYSTEM_EN_STACK}` : SYSTEM_EN_STACK
  const chineseStack = selectedChinese ? `${selectedChinese}, ${SYSTEM_ZH_STACK}` : SYSTEM_ZH_STACK
  const englishPrimary = selectedEnglish ?? SYSTEM_EN_PRIMARY
  const chinesePrimary = selectedChinese ?? SYSTEM_ZH_PRIMARY
  const alpha = Math.min(1, Math.max(0.25, surfaceOpacity / 100))
  const controlAlpha = Math.min(1, Math.max(0.32, alpha + 0.08))

  return {
    '--cc-bg': isDark ? '#211f1b' : '#f5f3ee',
    '--cc-bg-image': hasBackground ? `url("${background}")` : 'none',
    '--cc-bg-overlay': hasBackground
      ? isDark ? 'rgba(33, 31, 27, 0.28)' : 'rgba(245, 243, 238, 0.18)'
      : 'transparent',
    '--cc-bg-soft': isDark ? '#28251f' : '#efece6',
    '--cc-surface': isDark ? 'rgba(27, 25, 21, 0.9)' : 'rgba(255, 255, 255, 0.9)',
    '--cc-card': isDark ? `rgba(27, 25, 21, ${alpha})` : `rgba(255, 255, 255, ${alpha})`,
    '--cc-card-solid': isDark ? '#1b1915' : '#ffffff',
    '--cc-card-soft': isDark ? `rgba(34, 31, 26, ${controlAlpha})` : `rgba(246, 242, 235, ${controlAlpha})`,
    '--cc-surface-opacity': `${surfaceOpacity}%`,
    '--cc-surface-layer': isDark ? `rgba(27, 25, 21, ${alpha})` : `rgba(255, 255, 255, ${alpha})`,
    '--cc-header-layer': isDark ? `rgba(33, 31, 27, ${alpha})` : `rgba(245, 243, 238, ${alpha})`,
    '--cc-control-layer': isDark ? `rgba(48, 43, 36, ${controlAlpha})` : `rgba(238, 234, 226, ${controlAlpha})`,
    '--cc-control-layer-hover': isDark ? `rgba(58, 52, 43, ${controlAlpha})` : `rgba(230, 224, 214, ${controlAlpha})`,
    '--cc-text': isDark ? '#f1eadf' : '#2d2926',
    '--cc-sub': isDark ? '#ddd3c7' : '#5f574f',
    '--cc-dim': isDark ? '#b8ad9f' : '#7f756b',
    '--cc-primary': palette.primary,
    '--cc-primary-deep': palette.primaryDeep,
    '--cc-primary-soft': isDark ? palette.primarySoftDark : palette.primarySoftLight,
    '--cc-primary-rgb': palette.rgb,
    '--cc-accent': palette.accent,
    '--cc-accent-soft': palette.accentSoft,
    '--cc-border': isDark ? `rgba(${palette.rgb}, 0.13)` : `rgba(${palette.rgb}, 0.16)`,
    '--cc-border-soft': isDark ? 'rgba(92, 82, 71, 0.48)' : 'rgba(72, 65, 57, 0.12)',
    '--cc-input': isDark ? `rgba(48, 43, 36, ${controlAlpha})` : `rgba(238, 234, 226, ${controlAlpha})`,
    '--cc-focus': `rgba(${palette.rgb}, 0.7)`,
    '--cc-glass': isDark ? 'rgba(33, 31, 27, 0.92)' : 'rgba(245, 243, 238, 0.92)',
    '--cc-font-en': englishStack,
    '--cc-font-zh': chineseStack,
    '--cc-font-ui': `${englishPrimary}, ${chinesePrimary}, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`,
  } as CSSProperties
}
