export type PreviewSource = { kind: 'sim' } | { kind: 'web'; url: string; device: 'phone' | 'desktop' }

declare module 'claude-code' {
  interface PluginState {
    preview: {
      source: PreviewSource
    }
  }
}
