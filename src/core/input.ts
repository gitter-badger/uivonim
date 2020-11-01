import { input } from '../core/master-control'
import { VimMode } from '../neovim/types'
import { $, } from '../support/utils'
import api from '../core/instance-api'
import { remote } from 'electron'

export enum InputType {
  Down = 'down',
  Up = 'up',
}

interface RemapModifer {
  from: string
  to: string
}

interface KeyShape extends KeyboardEvent {
  mode?: VimMode
}

type OnKeyFn = (inputKeys: string, inputType: InputType) => void

const modifiers = ['Alt', 'Shift', 'Meta', 'Control']
const remaps = new Map<string, string>()
let isCapturing = true
let windowHasFocus = true
let lastEscapeTimestamp = 0
let shouldClearEscapeOnNextAppFocus = false
let keyListener: OnKeyFn = () => {}
let sendInputToVim = true

const isStandardAscii = (key: string) =>
  key.charCodeAt(0) > 32 && key.charCodeAt(0) < 127
const handleMods = ({
  ctrlKey,
  shiftKey,
  metaKey,
  altKey,
  key,
}: KeyboardEvent) => {
  const mods: string[] = []
  const onlyShift = shiftKey && !ctrlKey && !metaKey && !altKey
  const notCmdOrCtrl = !metaKey && !ctrlKey
  const macOSUnicode =
    (process.platform === 'darwin' && altKey && notCmdOrCtrl) ||
    (altKey && shiftKey && notCmdOrCtrl)

  if (onlyShift && isStandardAscii(key) && key.length === 1) return mods
  if (macOSUnicode) return mods
  if (ctrlKey) mods.push('C')
  if (shiftKey) mods.push('S')
  if (metaKey) mods.push('D')
  if (altKey) mods.push('A')
  return mods
}

const toVimKey = (key: string): string => {
  if (key === 'Backspace') return 'BS'
  if (key === '<') return 'LT'
  if (key === 'Escape') return 'Esc'
  if (key === 'Delete') return 'Del'
  if (key === ' ') return 'Space'
  if (key === 'ArrowUp') return 'Up'
  if (key === 'ArrowDown') return 'Down'
  if (key === 'ArrowLeft') return 'Left'
  if (key === 'ArrowRight') return 'Right'
  else return key
}

const isUpper = (char: string) => char.toLowerCase() !== char
const bypassEmptyMod = (key: string) => (modifiers.includes(key) ? '' : key)
const wrapKey = (key: string): string =>
  key.length > 1 && isUpper(key[0]) ? `<${key}>` : key
const combineModsWithKey = (mods: string, key: string) =>
  mods.length ? `${mods}-${key}` : key
const userModRemaps = (mods: string[]) => mods.map((m) => remaps.get(m) || m)
const joinModsWithDash = (mods: string[]) => mods.join('-')
const mapMods = $<string>(handleMods, userModRemaps, joinModsWithDash)
const mapKey = $<string>(bypassEmptyMod, toVimKey)
const formatInput = $<string>(combineModsWithKey, wrapKey)
const shortcuts = new Map<string, Function>()
const globalShortcuts = new Map<string, () => void>()

export const focus = () => {
  isCapturing = true
}

export const blur = () => {
  isCapturing = false
}

export const stealInput = (onKeyFn: OnKeyFn) => {
  sendInputToVim = false
  keyListener = onKeyFn
  return () => (sendInputToVim = true)
}

const sendToVim = (inputKeys: string) => {
  // TODO: for now shortcuts only work in dev mode
  if (process.env.VEONIM_DEV) {
    if (shortcuts.has(`${api.nvim.state.mode}:${inputKeys}`)) {
      return shortcuts.get(`${api.nvim.state.mode}:${inputKeys}`)!()
    }
  }

  if (globalShortcuts.has(inputKeys)) return globalShortcuts.get(inputKeys)!()

  // TODO: this might need more attention. i think s-space can be a valid
  // vim keybind. s-space was causing issues in terminal mode, sending weird
  // term esc char.
  if (inputKeys === '<S-Space>') return input('<space>')
  if (inputKeys.length > 1 && !inputKeys.startsWith('<')) {
    return inputKeys.split('').forEach((k: string) => input(k))
  }

  // a fix for terminal. only happens on cmd-tab. see below for more info
  if (inputKeys.toLowerCase() === '<esc>') lastEscapeTimestamp = Date.now()
  input(inputKeys)
}

export const registerShortcut = (keys: string, mode: VimMode, cb: Function) => {
  shortcuts.set(`${mode}:<${keys}>`, cb)
}

export const registerOneTimeUseShortcuts = (
  shortcuts: string[],
  cb: (shortcut: string) => void
) => {
  const done = (shortcut: string) => {
    shortcuts.forEach((s) => globalShortcuts.delete(s))
    cb(shortcut)
  }
  shortcuts.forEach((s) => globalShortcuts.set(s, () => done(s)))
}

let textarea = document.getElementById('keycomp-textarea')

const sendKeys = async (e: KeyboardEvent, inputType: InputType) => {
  const key = bypassEmptyMod(e.key)
  if (!key) return
  if (key === 'Dead' && textarea)
    (textarea as HTMLTextAreaElement).value = 'things'

  const inputKeys = formatInput(mapMods(e), mapKey(e.key))

  if (sendInputToVim) return sendToVim(inputKeys)
  keyListener(inputKeys, inputType)
}

const keydownHandler = (e: KeyboardEvent) => {
  if (!windowHasFocus || !isCapturing) return

  sendKeys(e, InputType.Down)
}

// Need to handle key events from window for GUI elements like the external
// cmdline, so if the key composition textarea isn't focused (which it won't
// be when those elements are in use), handle the event from the window.
window.addEventListener('keydown', (e) => {
  if (textarea) if (textarea === document.activeElement) return

  keydownHandler(e)
})

textarea?.addEventListener('keydown', keydownHandler)

remote.getCurrentWindow().on('focus', () => {
  windowHasFocus = true
  if (shouldClearEscapeOnNextAppFocus) {
    // so if i remap 'cmd' down+up -> 'esc' and then hit cmd+tab to switch apps
    // while in a terminal buffer, the application captures the 'cmd' (xform to
    // 'esc') but not the 'tab' key. because of the xform to 'esc' this sends
    // an escape sequence to the terminal. once the app gains focus again, the
    // first char in the terminal buffer will be "swallowed". very annoying if
    // copypasta commands, the first char gets lost and have to re-pasta

    // i couldn't figure out an elegant solution to this (tried native
    // keylistening but too much effort/unreliable), and decided to check if an
    // 'esc' key was sent immediately before the app lost focus && we were in
    // terminal insert mode. when the app gains focus again, we can "clear" the
    // previous erranous 'escape' key sent to the terminal. this might only
    // happen on macos + my custom config of remapping cmd -> cmd/esc
    input('<enter>')
    shouldClearEscapeOnNextAppFocus = false
  }
})

remote.getCurrentWindow().on('blur', async () => {
  windowHasFocus = false

  const lastEscapeFromNow = Date.now() - lastEscapeTimestamp
  const isTerminalMode = api.nvim.state.mode === VimMode.Terminal
  const fixTermEscape = isTerminalMode && lastEscapeFromNow < 25
  if (fixTermEscape) shouldClearEscapeOnNextAppFocus = true
})
