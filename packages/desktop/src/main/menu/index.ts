import fs from 'fs'
import fsPromises from 'fs/promises'
import path from 'path'
import { app, Menu, ipcMain, type BrowserWindow } from 'electron'
import log from 'electron-log'
import { ensureDirSync } from 'common/filesystem'
import { isLinux, isOsx, isWindows } from '../config'
import { updateSidebarMenu } from '../menu/actions/edit'
import { updateFormatMenu } from '../menu/actions/format'
import { updateSelectionMenus, type SelectionState } from '../menu/actions/paragraph'
import { onInternalChannel } from '../utils/internalIpc'
import { viewLayoutChanged } from '../menu/actions/view'
import configureMenu, { configSettingMenu } from '../menu/templates'
import { setLanguage } from '../i18n.js'
import type Preference from '../preferences'
import type Keybindings from '../keyboard/shortcutHandler'
import type { IUserPreferences } from '@shared/types/preferences'

const RECENTLY_USED_DOCUMENTS_FILE_NAME = 'recently-used-documents.json'
const MAX_RECENTLY_USED_DOCUMENTS = 12

export const MenuType = {
  DEFAULT: 0,
  EDITOR: 1,
  SETTINGS: 2
} as const

export type MenuTypeValue = (typeof MenuType)[keyof typeof MenuType]

interface WindowMenuEntry {
  menu: Menu | null
  type: MenuTypeValue
}

interface AddEditorMenuOptions {
  sourceCodeModeEnabled?: boolean
}

interface ThemeMenuChange {
  theme?: string
  followSystemTheme?: boolean
}

class AppMenu {
  private readonly _preferences: Preference
  private readonly _keybindings: Keybindings
  private readonly _userDataPath: string
  public readonly RECENTS_PATH: string
  public readonly isOsxOrWindows: boolean
  public activeWindowId: number
  public windowMenus: Map<number, WindowMenuEntry>
  private _recentDocuments: string[] | null
  private _recentsDirty: boolean
  private _recentsWriteTimer: NodeJS.Timeout | null
  private _menuRebuildScheduled: boolean

  /**
   * @param preferences The preferences instances.
   * @param keybindings The keybindings instances.
   * @param userDataPath The user data path.
   */
  constructor(
    preferences: Preference,
    keybindings: Keybindings,
    userDataPath: string
  ) {
    this._preferences = preferences
    this._keybindings = keybindings
    this._userDataPath = userDataPath

    this.RECENTS_PATH = path.join(userDataPath, RECENTLY_USED_DOCUMENTS_FILE_NAME)
    this.isOsxOrWindows = isOsx || isWindows
    this.activeWindowId = -1
    this.windowMenus = new Map()
    this._recentDocuments = null
    this._recentsDirty = false
    this._recentsWriteTimer = null
    this._menuRebuildScheduled = false

    // The recents list lives in memory; it is loaded once and every mutation
    // is persisted with a debounced async write. On macOS the OS manages the
    // recents list natively, so the JSON file is unused there.
    if (!isOsx) {
      this._loadRecentlyUsedDocuments().catch((err) => {
        log.error('Error while loading recently used documents:', err)
      })
      // Flush a pending debounced write at quit, otherwise recents added in
      // the final moments of a session would silently vanish. One sync write
      // during shutdown is acceptable.
      app.on('before-quit', () => this._flushRecentlyUsedDocumentsSync())
    }

    // Initialize main process language from preferences
    this._initializeLanguage()

    this._listenForIpcMain()
  }

  /**
   * Add the file or directory path to the recently used documents.
   *
   * @param filePath The file or directory full path.
   */
  addRecentlyUsedDocument(filePath: string): void {
    const { isOsxOrWindows } = this

    if (isOsxOrWindows) app.addRecentDocument(filePath)
    if (isOsx) return

    const recentDocuments = this.getRecentlyUsedDocuments()
    const index = recentDocuments.indexOf(filePath)
    if (index > 0) {
      recentDocuments.splice(index, 1)
    }
    if (index !== 0) {
      recentDocuments.unshift(filePath)
    }

    if (recentDocuments.length > MAX_RECENTLY_USED_DOCUMENTS) {
      recentDocuments.splice(
        MAX_RECENTLY_USED_DOCUMENTS,
        recentDocuments.length - MAX_RECENTLY_USED_DOCUMENTS
      )
    }

    this._recentDocuments = recentDocuments
    this._schedulePersistRecentlyUsedDocuments()
    this.updateAppMenu()
  }

  /**
   * Returns a list of all recently used documents and folders.
   */
  getRecentlyUsedDocuments(): string[] {
    return [...(this._recentDocuments ?? [])]
  }

  /**
   * Clear recently used documents.
   */
  clearRecentlyUsedDocuments(): void {
    const { isOsxOrWindows } = this
    if (isOsxOrWindows) app.clearRecentDocuments()
    if (isOsx) return

    this._recentDocuments = []
    this._schedulePersistRecentlyUsedDocuments()
    this.updateAppMenu()
  }

  /**
   * Add a default menu to the given window.
   *
   * @param windowId The window id.
   */
  addDefaultMenu(windowId: number): void {
    const { windowMenus } = this
    const menu = this._buildSettingMenu() // Setting menu is also the fallback menu.
    windowMenus.set(windowId, menu)
  }

  /**
   * Add the settings menu to the given window.
   *
   * @param window The settings browser window.
   */
  addSettingMenu(window: BrowserWindow): void {
    const { windowMenus } = this
    const menu = this._buildSettingMenu()
    windowMenus.set(window.id, menu)
  }

  /**
   * Add the editor menu to the given window.
   *
   * @param window The editor browser window.
   * @param options The menu options.
   */
  addEditorMenu(window: BrowserWindow, options: AddEditorMenuOptions = {}): void {
    const isSourceMode = !!options.sourceCodeModeEnabled
    const { windowMenus } = this
    windowMenus.set(window.id, this._buildEditorMenu())

    const entry = windowMenus.get(window.id)
    const menu = entry?.menu
    if (!menu) return

    // Set source-code editor if preferred.
    const sourceCodeModeMenuItem = menu.getMenuItemById('sourceCodeModeMenuItem')
    if (sourceCodeModeMenuItem) {
      sourceCodeModeMenuItem.checked = isSourceMode
    }

    if (isSourceMode) {
      const typewriterModeMenuItem = menu.getMenuItemById('typewriterModeMenuItem')
      const focusModeMenuItem = menu.getMenuItemById('focusModeMenuItem')
      if (typewriterModeMenuItem) typewriterModeMenuItem.enabled = false
      if (focusModeMenuItem) focusModeMenuItem.enabled = false
    }

    const { _keybindings } = this
    _keybindings.registerEditorKeyHandlers(window)

    if (isWindows) {
      // WORKAROUND: Window close event isn't triggered on Windows if `setIgnoreMenuShortcuts(true)` is used (Electron#32674).
      // NB: Remove this immediately if upstream is fixed because the event may be emitted twice.
      _keybindings.registerAccelerator(window, 'Alt+F4', (win: BrowserWindow | null) => {
        if (win && !win.isDestroyed()) {
          win.close()
        }
      })
    }
  }

  /**
   * Remove menu from the given window.
   *
   * @param windowId The window id.
   */
  removeWindowMenu(windowId: number): void {
    // NOTE: Shortcut handler is automatically unregistered when window is closed.
    const { activeWindowId } = this
    this.windowMenus.delete(windowId)
    if (activeWindowId === windowId) {
      this.activeWindowId = -1
    }
  }

  /**
   * Returns the window menu.
   *
   * @param windowId The window id.
   */
  getWindowMenuById(windowId: number): Menu {
    const menu = this.windowMenus.get(windowId)
    if (!menu) {
      log.error(`getWindowMenuById: Cannot find window menu for window id ${windowId}.`)
      throw new Error(`Cannot find window menu for id ${windowId}.`)
    }
    // The original JS returns `menu.menu` directly; settings menus on non-macOS
    // platforms have `menu: null`, in which case the consumer is responsible
    // for handling the null/undefined return.
    return menu.menu as Menu
  }

  /**
   * Check whether the given window has a menu.
   *
   * @param windowId The window id.
   */
  has(windowId: number): boolean {
    return this.windowMenus.has(windowId)
  }

  /**
   * Set the given window as last active.
   *
   * @param windowId The window id.
   */
  setActiveWindow(windowId: number): void {
    if (this.activeWindowId !== windowId) {
      // Change application menu to the current window menu.
      this._setApplicationMenu(this.getWindowMenuById(windowId))
      this.activeWindowId = windowId
    }
  }

  /**
   * Updates all window menus.
   *
   * NOTE: We need this method to add or remove menu items at runtime.
   */
  updateAppMenu(recentUsedDocuments?: string[]): void {
    if (recentUsedDocuments) {
      this._recentDocuments = [...recentUsedDocuments]
    }

    // Coalesce bursts into one rebuild per tick: restoring a session fires one
    // addRecentlyUsedDocument per tab, and rebuilding every window menu per
    // file is quadratic work that stalls the main process.
    if (this._menuRebuildScheduled) return
    this._menuRebuildScheduled = true
    setImmediate(() => {
      this._menuRebuildScheduled = false
      this._rebuildEditorMenus()
    })
  }

  private _rebuildEditorMenus(): void {
    const recentUsedDocuments = this.getRecentlyUsedDocuments()

    // "we don't support changing menu object after calling setMenu, the behavior
    // is undefined if user does that." That mean we have to recreate the editor
    // application menu each time.

    // rebuild all window menus
    this.windowMenus.forEach((value, key) => {
      const { menu: oldMenu, type } = value
      if (type !== MenuType.EDITOR || !oldMenu) return

      const { menu: newMenu } = this._buildEditorMenu(recentUsedDocuments)
      if (!newMenu) return

      // all other menu items are set automatically
      updateMenuItem(oldMenu, newMenu, 'sourceCodeModeMenuItem')
      updateMenuItem(oldMenu, newMenu, 'typewriterModeMenuItem')
      updateMenuItem(oldMenu, newMenu, 'focusModeMenuItem')
      updateMenuItem(oldMenu, newMenu, 'readOnlyModeMenuItem')
      updateMenuItem(oldMenu, newMenu, 'sideBarMenuItem')
      updateMenuItem(oldMenu, newMenu, 'tabBarMenuItem')
      updateMenuItem(oldMenu, newMenu, 'tocMenuItem')

      // update window menu
      value.menu = newMenu
      // update application menu if necessary
      const { activeWindowId } = this
      if (activeWindowId === key) {
        this._setApplicationMenu(newMenu)
      }
    })
  }

  /**
   * Rebuild every window menu so updated keybinding accelerators are reflected
   * wherever shortcuts are shown: the menu bar on Windows/Linux and the macOS
   * application menu for both editor and settings windows.
   */
  updateKeybindings(): void {
    const recentUsedDocuments = this.getRecentlyUsedDocuments()
    this.windowMenus.forEach((value, key) => {
      const { menu: oldMenu, type } = value

      let newMenu: Menu | null = null
      if (type === MenuType.EDITOR) {
        if (!oldMenu) return
        const { menu: rebuilt } = this._buildEditorMenu(recentUsedDocuments)
        if (!rebuilt) return

        updateMenuItem(oldMenu, rebuilt, 'sourceCodeModeMenuItem')
        updateMenuItem(oldMenu, rebuilt, 'typewriterModeMenuItem')
        updateMenuItem(oldMenu, rebuilt, 'focusModeMenuItem')
        updateMenuItem(oldMenu, rebuilt, 'readOnlyModeMenuItem')
        updateMenuItem(oldMenu, rebuilt, 'sideBarMenuItem')
        updateMenuItem(oldMenu, rebuilt, 'tabBarMenuItem')
        updateMenuItem(oldMenu, rebuilt, 'tocMenuItem')
        newMenu = rebuilt
      } else if (type === MenuType.SETTINGS) {
        newMenu = this._buildSettingMenu().menu
        if (!newMenu) return
      } else {
        return
      }

      value.menu = newMenu
      if (this.activeWindowId === key) {
        this._setApplicationMenu(newMenu)
      }
    })
  }

  /**
   * Update line ending menu items.
   *
   * @param windowId The window id.
   * @param lineEnding Either >lf< or >crlf<.
   */
  updateLineEndingMenu(windowId: number, lineEnding: string): void {
    const menus = this.getWindowMenuById(windowId)
    const crlfMenu = menus.getMenuItemById('crlfLineEndingMenuEntry')
    const lfMenu = menus.getMenuItemById('lfLineEndingMenuEntry')
    if (lineEnding === 'crlf') {
      if (crlfMenu) crlfMenu.checked = true
    } else {
      if (lfMenu) lfMenu.checked = true
    }
  }

  /**
   * Update always on top menu item.
   *
   * @param windowId The window id.
   * @param flag Always on top.
   */
  updateAlwaysOnTopMenu(windowId: number, flag: boolean): void {
    const menus = this.getWindowMenuById(windowId)
    const menu = menus.getMenuItemById('alwaysOnTopMenuItem')
    if (menu) menu.checked = flag
  }

  /**
   * Update theme menu state across editor menus.
   */
  updateThemeMenu = ({ theme, followSystemTheme }: ThemeMenuChange = {}): void => {
    this.windowMenus.forEach((value) => {
      const { menu, type } = value
      if (type !== MenuType.EDITOR || !menu) {
        return
      }

      const themeMenus = menu.getMenuItemById('themeMenu')
      if (!themeMenus || !themeMenus.submenu) {
        return
      }

      themeMenus.submenu.items.forEach((item) => {
        if (item.type === 'radio' && typeof followSystemTheme !== 'undefined') {
          item.enabled = !followSystemTheme
        }

        if (item.id === 'follow-system-theme' && typeof followSystemTheme !== 'undefined') {
          item.checked = followSystemTheme
        }

        if (item.type === 'radio' && typeof theme !== 'undefined') {
          item.checked = item.id === theme
        } else if (item.id && item.id === theme) {
          item.checked = true
        }
      })
    })
  }

  /**
   * Update all auto save entries from editor menus to the given state.
   */
  updateAutoSaveMenu = (autoSave: boolean): void => {
    this.windowMenus.forEach((value) => {
      const { menu, type } = value
      if (type !== MenuType.EDITOR || !menu) {
        return
      }

      const autoSaveMenu = menu.getMenuItemById('autoSaveMenuItem')
      if (!autoSaveMenu) {
        return
      }
      autoSaveMenu.checked = autoSave
    })
  }

  private async _loadRecentlyUsedDocuments(): Promise<void> {
    let candidates: string[] = []
    try {
      const parsed: unknown = JSON.parse(await fsPromises.readFile(this.RECENTS_PATH, 'utf-8'))
      if (Array.isArray(parsed)) {
        candidates = parsed.filter((f): f is string => typeof f === 'string' && f.length > 0)
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.error('Error while read recently used documents:', err)
      }
    }

    // Existence is verified once at startup, in parallel; from then on the
    // list is maintained in memory rather than re-stat'ing every entry on each
    // menu rebuild.
    const existsFlags = await Promise.all(
      candidates.map(async(f) => {
        try {
          await fsPromises.access(f)
          return true
        } catch {
          return false
        }
      })
    )
    this._recentDocuments = candidates
      .filter((_, i) => existsFlags[i])
      .slice(0, MAX_RECENTLY_USED_DOCUMENTS)

    // Menus built before the load completed were rendered without recents.
    if (this.windowMenus.size > 0) {
      this.updateAppMenu()
    }
  }

  private _schedulePersistRecentlyUsedDocuments(): void {
    this._recentsDirty = true
    if (this._recentsWriteTimer) {
      clearTimeout(this._recentsWriteTimer)
    }
    // Debounce: session restoration adds one entry per tab in a burst.
    this._recentsWriteTimer = setTimeout(() => {
      this._recentsWriteTimer = null
      this._persistRecentlyUsedDocuments().catch((err) => {
        log.error('Error while writing recently used documents:', err)
      })
    }, 500)
  }

  private async _persistRecentlyUsedDocuments(): Promise<void> {
    if (!this._recentsDirty) return
    const json = JSON.stringify(this._recentDocuments ?? [], null, 2)
    this._recentsDirty = false
    try {
      await fsPromises.mkdir(this._userDataPath, { recursive: true })
      await fsPromises.writeFile(this.RECENTS_PATH, json, 'utf-8')
    } catch (err) {
      // Keep the dirty flag so the next mutation retries the write.
      this._recentsDirty = true
      log.error('Error while writing recently used documents:', err)
    }
  }

  private _flushRecentlyUsedDocumentsSync(): void {
    if (this._recentsWriteTimer) {
      clearTimeout(this._recentsWriteTimer)
      this._recentsWriteTimer = null
    }
    if (!this._recentsDirty) return
    this._recentsDirty = false
    try {
      ensureDirSync(this._userDataPath)
      fs.writeFileSync(this.RECENTS_PATH, JSON.stringify(this._recentDocuments ?? [], null, 2), 'utf-8')
    } catch (err) {
      log.error('Error while writing recently used documents on quit:', err)
    }
  }

  _buildEditorMenu(recentUsedDocuments: string[] | null = null): WindowMenuEntry {
    if (!recentUsedDocuments) {
      recentUsedDocuments = this.getRecentlyUsedDocuments()
    }

    const menuTemplate = configureMenu(this._keybindings, this._preferences, recentUsedDocuments)
    const menu = Menu.buildFromTemplate(menuTemplate)
    return { menu, type: MenuType.EDITOR }
  }

  _buildSettingMenu(): WindowMenuEntry {
    if (isOsx) {
      const menuTemplate = configSettingMenu(this._keybindings)
      const menu = Menu.buildFromTemplate(menuTemplate)
      return { menu, type: MenuType.SETTINGS }
    }
    return { menu: null, type: MenuType.SETTINGS }
  }

  _setApplicationMenu(menu: Menu | null): void {
    if (isLinux && !menu) {
      // WORKAROUND for Electron#16521: We cannot hide the (application) menu on Linux.
      const dummyMenu = Menu.buildFromTemplate([])
      Menu.setApplicationMenu(dummyMenu)
    } else {
      Menu.setApplicationMenu(menu)
    }
  }

  /**
   * Initialize main process language from preferences
   */
  async _initializeLanguage(): Promise<void> {
    try {
      const currentLanguage = this._preferences.getItem<string>('language')
      if (currentLanguage) {
        setLanguage(currentLanguage)
        log.info(`Main process language initialized to: ${currentLanguage}`)
      }
    } catch (error) {
      log.error('Failed to initialize main process language:', error)
    }
  }

  _listenForIpcMain(): void {
    ipcMain.on('mt::add-recently-used-document', (_e, pathname: string) => {
      this.addRecentlyUsedDocument(pathname)
    })
    ipcMain.on('mt::update-line-ending-menu', (_e, windowId: number, lineEnding: string) => {
      this.updateLineEndingMenu(windowId, lineEnding)
    })
    ipcMain.on(
      'mt::update-format-menu',
      (_e, windowId: number, formats: Record<string, boolean>) => {
        if (!this.has(windowId)) {
          log.error(`UpdateApplicationMenu: Cannot find window menu for window id ${windowId}.`)
          return
        }
        updateFormatMenu(this.getWindowMenuById(windowId), formats)
      }
    )
    ipcMain.on('mt::update-sidebar-menu', (_e, windowId: number, value: unknown) => {
      if (!this.has(windowId)) {
        log.error(`UpdateApplicationMenu: Cannot find window menu for window id ${windowId}.`)
        return
      }
      updateSidebarMenu(this.getWindowMenuById(windowId), value)
    })
    ipcMain.on(
      'mt::view-layout-changed',
      (_e, windowId: number, viewSettings: Record<string, unknown>) => {
        if (!this.has(windowId)) {
          log.error(`UpdateApplicationMenu: Cannot find window menu for window id ${windowId}.`)
          return
        }
        viewLayoutChanged(this.getWindowMenuById(windowId), viewSettings)
      }
    )
    ipcMain.on('mt::editor-selection-changed', (_e, windowId: number, changes: SelectionState) => {
      if (!this.has(windowId)) {
        log.error(`UpdateApplicationMenu: Cannot find window menu for window id ${windowId}.`)
        return
      }
      updateSelectionMenus(this.getWindowMenuById(windowId), changes)
    })

    // In source-code mode the Paragraph and Format commands act on the hidden
    // WYSIWYG engine, so grey them out; on return to WYSIWYG they are re-enabled
    // and the next selection change refines them (#3531).
    ipcMain.on('mt::set-editor-format-menus-enabled', (_e, windowId: number, enabled: boolean) => {
      if (!this.has(windowId)) return
      const menu = this.getWindowMenuById(windowId)
      for (const id of ['paragraphMenuEntry', 'formatMenuItem']) {
        const entry = menu.getMenuItemById(id)
        entry?.submenu?.items.forEach((item) => (item.enabled = enabled))
      }
    })

    onInternalChannel('menu-add-recently-used', (pathname: string) => {
      this.addRecentlyUsedDocument(pathname)
    })
    ipcMain.on('menu-clear-recently-used', () => {
      this.clearRecentlyUsedDocuments()
    })

    onInternalChannel('broadcast-preferences-changed', async(prefs: Partial<IUserPreferences>) => {
      if (prefs.theme !== undefined || prefs.followSystemTheme !== undefined) {
        this.updateAppMenu()
      }
      if (prefs.autoSave !== undefined) {
        this.updateAutoSaveMenu(prefs.autoSave)
      }
      if (prefs.language) {
        // Update main process language and rebuild menu
        setLanguage(prefs.language)
        this.updateAppMenu()
      }
    })
  }
}

const updateMenuItem = (oldMenus: Menu, newMenus: Menu, id: string): void => {
  const oldItem = oldMenus.getMenuItemById(id)
  const newItem = newMenus.getMenuItemById(id)
  if (oldItem && newItem) {
    newItem.checked = oldItem.checked
  }
}

// ----------------------------------------------

// HACKY: We have one application menu per window and switch the menu when
// switching windows, so we can access and change the menu items via Electron.

/**
 * Return the menu from the application menu.
 *
 * @param menuId Menu ID
 * @returns Returns the menu or null.
 */
export const getMenuItemById = (menuId: string): Electron.MenuItem | null => {
  const menus = Menu.getApplicationMenu()
  if (!menus) return null
  return menus.getMenuItemById(menuId)
}

export default AppMenu
