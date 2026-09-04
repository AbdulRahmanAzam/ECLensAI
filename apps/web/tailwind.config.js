/**
 * Every palette shade resolves to a CSS variable (see src/styles/tokens.css) so
 * the same utility class renders correctly in both themes. Dark mode is driven
 * by `data-theme` on <html>, set before first paint by the bootstrap script in
 * index.html.
 *
 * @type {import('tailwindcss').Config}
 */
const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

const ramp = (family) =>
  Object.fromEntries(
    SHADES.map((shade) => [shade, `rgb(var(--c-${family}-${shade}) / <alpha-value>)`]),
  );

const token = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        slate: ramp('slate'),
        navy: ramp('navy'),
        red: ramp('red'),
        amber: ramp('amber'),
        emerald: ramp('emerald'),
        teal: ramp('teal'),

        canvas: token('canvas'),
        'canvas-alt': token('canvas-alt'),
        surface: token('surface'),
        'surface-2': token('surface-2'),
        'surface-3': token('surface-3'),
        line: token('line'),
        'line-soft': token('line-soft'),
        brand: token('brand'),
        'brand-hover': token('brand-hover'),
        'brand-soft': token('brand-soft'),
        accent: token('accent'),
        'accent-soft': token('accent-soft'),

        // Always-dark chrome (sidebar, hero, sign-in panel) — never inverts.
        ink: token('ink'),
        'ink-2': token('ink-2'),
        'ink-3': token('ink-3'),
      },
      fontFamily: {
        sans: [
          'InterVariable',
          'Inter',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      letterSpacing: {
        tightest: '-0.032em',
      },
      borderRadius: {
        md: '0.5rem',
        lg: '0.625rem',
        xl: '0.875rem',
        '2xl': '1.125rem',
        '3xl': '1.5rem',
      },
      boxShadow: {
        // Layered, low-alpha shadows tinted with the brand hue rather than pure
        // black — pure black reads muddy on the light canvas.
        xs: '0 1px 2px 0 rgb(var(--shadow-color) / 0.05)',
        card: '0 1px 2px -1px rgb(var(--shadow-color) / 0.08), 0 2px 6px -2px rgb(var(--shadow-color) / 0.06)',
        raised:
          '0 1px 2px -1px rgb(var(--shadow-color) / 0.1), 0 4px 12px -3px rgb(var(--shadow-color) / 0.1)',
        pop: '0 4px 12px -4px rgb(var(--shadow-color) / 0.12), 0 18px 40px -12px rgb(var(--shadow-color) / 0.22)',
        glow: '0 0 0 1px rgb(var(--c-brand) / 0.18), 0 8px 24px -8px rgb(var(--c-brand) / 0.45)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'none' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'translateY(8px) scale(0.98)' },
          to: { opacity: '1', transform: 'none' },
        },
        'slide-in-right': {
          from: { opacity: '0', transform: 'translateX(16px)' },
          to: { opacity: '1', transform: 'none' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.2s ease-out both',
        'fade-up': 'fade-up 0.28s cubic-bezier(0.22, 1, 0.36, 1) both',
        'scale-in': 'scale-in 0.18s cubic-bezier(0.22, 1, 0.36, 1) both',
        'slide-in-right': 'slide-in-right 0.24s cubic-bezier(0.22, 1, 0.36, 1) both',
      },
    },
  },
  plugins: [],
};
