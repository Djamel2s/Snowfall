import type { AlienAvatar } from './api'

type Tone = { light: string; base: string; shade: string }

export const alienPalette: Record<AlienAvatar['color'], Tone> = {
  pink: { light: '#ffe3f1', base: '#f5a8d0', shade: '#d476a9' },
  coral: { light: '#ffd6d1', base: '#ff8a86', shade: '#dc5662' },
  mint: { light: '#ddfff1', base: '#8fe3c2', shade: '#4cb991' },
  lavender: { light: '#efe9ff', base: '#bba9f5', shade: '#8a72d9' },
  sky: { light: '#e2f2ff', base: '#8ec9ff', shade: '#5698e0' },
  lime: { light: '#f4ffd6', base: '#c8e872', shade: '#91bb3b' },
  snow: { light: '#ffffff', base: '#eef2f8', shade: '#bcc5d4' },
  gold: { light: '#fff4d2', base: '#ffd36e', shade: '#e2a136' },
}

export const defaultAlien: AlienAvatar = { kind: 'alien', color: 'sky', eyes: 'classic', accessory: 'none' }
