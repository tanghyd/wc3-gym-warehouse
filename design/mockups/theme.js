/* Mockup theme wiring: the frontend.md 6.2 createVuetify block, with the colours read off tokens.css.
   Mode: ?theme=light|dark|system, else the stored choice, else system (as gnl src/helpers/theme.js). */
;(() => {
  const root = document.documentElement
  const media = matchMedia('(prefers-color-scheme: dark)')
  let stored = null
  try { stored = localStorage.getItem('theme') } catch (e) { /* storage blocked: system */ }
  const mode = Vue.ref(new URLSearchParams(location.search).get('theme') || stored || 'system')
  const prefersDark = Vue.ref(media.matches)
  media.addEventListener('change', (e) => { prefersDark.value = e.matches })
  const active = () => (mode.value === 'system' ? (prefersDark.value ? 'dark' : 'light') : mode.value)
  root.dataset.theme = active()

  const COLORS = ['background', 'surface', 'surface-bright', 'surface-light', 'surface-variant', 'on-surface-variant',
    'primary', 'primary-darken-1', 'on-primary', 'secondary', 'secondary-darken-1', 'on-secondary',
    'error', 'warning', 'info', 'success', 'primary-text', 'band', 'on-band', 'band-muted', 'tag', 'on-tag',
    'win', 'loss', 'draw', 'series-1', 'series-2', 'magnitude']
  // Vuetify parses hex only, so each mode's values are read off tokens.css with the attribute set
  function read(name) {
    root.dataset.theme = name
    const css = getComputedStyle(root)
    const v = (n) => css.getPropertyValue('--' + n).trim()
    const colors = Object.fromEntries(COLORS.map((c) => [c, v(c)]))
    colors['on-background'] = colors['on-surface'] = v('on-surface')
    return { dark: name === 'dark', colors,
      variables: { 'border-color': v('on-surface'), 'border-opacity': +v('border-opacity'), 'medium-emphasis-opacity': 0.7 } }
  }

  const field = { variant: 'filled', bgColor: 'surface-light', density: 'compact', rounded: 'sm', color: 'primary', hideDetails: 'auto' }
  function vuetify(defaults = {}) {
    const themes = { light: read('light'), dark: read('dark') }
    root.dataset.theme = active()
    return Vuetify.createVuetify({
      theme: { defaultTheme: active(), themes },
      defaults: {
        VTooltip: { openOnClick: true },
        VCard: { variant: 'flat', border: true, rounded: 'sm' },
        VBtn: { rounded: 'sm' },
        VChip: { rounded: 'sm' },
        VTextField: field, VSelect: field, VAutocomplete: field,
        ...defaults,
      },
    })
  }

  const THEMES = [
    { value: 'light', title: 'Light', icon: 'mdi-white-balance-sunny' },
    { value: 'dark', title: 'Dark', icon: 'mdi-weather-night' },
    { value: 'system', title: 'System', icon: 'mdi-theme-light-dark' },
  ]
  // gnl src/App.vue: the app-bar menu with the three modes
  const ThemeMenu = {
    setup() {
      const theme = Vuetify.useTheme()
      Vue.watchEffect(() => { theme.global.name.value = active(); root.dataset.theme = active() })
      const set = (m) => { mode.value = m; try { localStorage.setItem('theme', m) } catch (e) { /* not kept */ } }
      const icon = Vue.computed(() => (THEMES.find((t) => t.value === mode.value) || THEMES[2]).icon)
      return { THEMES, mode, set, icon }
    },
    template: `<span><v-menu>
      <template #activator="{ props }"><v-btn v-bind="props" :icon="icon" variant="text" size="small" aria-label="Theme" /></template>
      <v-list density="compact"><v-list-item v-for="t in THEMES" :key="t.value" :title="t.title" :prepend-icon="t.icon"
        :active="mode === t.value" @click="set(t.value)" /></v-list>
    </v-menu></span>`,
  }

  window.gnlMockup = { vuetify, ThemeMenu }
})()
