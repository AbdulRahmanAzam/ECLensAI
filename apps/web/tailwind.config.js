/**
 * Every palette shade resolves to a CSS variable (see src/styles/tokens.css) so
 * colour lives in one place and utility classes stay declarative.
 *
 * The product ships light-only by design — see the note in tokens.css.
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
        'line-strong': token('line-strong'),
        brand: token('brand'),
        'brand-hover': token('brand-hover'),
        'brand-soft': token('brand-soft'),
        accent: token('accent'),
        'accent-soft': token('accent-soft'),

        ink: token('ink'),
        'ink-2': token('ink-2'),
        'ink-3': token('ink-3'),
      },
      fontFamily: {
        sans: [
          'Inter',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        // Editorial display face, used only for page and hero titles. It is
        // what stops a dense analyst tool from reading like a stock template.
        display: ['Instrument Serif', 'Iowan Old Style', 'Georgia', 'serif'],
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
        // Layered and low-alpha. The `inset` highlight on `card` is the detail
        // that makes a white panel read as a lit surface rather than a cutout.
        xs: '0 1px 2px 0 rgb(var(--shadow-color) / 0.06)',
        card: '0 0 0 1px rgb(var(--shadow-color) / 0.04), 0 1px 2px -1px rgb(var(--shadow-color) / 0.08), 0 3px 8px -3px rgb(var(--shadow-color) / 0.07)',
        raised:
          '0 0 0 1px rgb(var(--shadow-color) / 0.05), 0 2px 4px -2px rgb(var(--shadow-color) / 0.1), 0 10px 24px -8px rgb(var(--shadow-color) / 0.14)',
        pop: '0 0 0 1px rgb(var(--shadow-color) / 0.06), 0 6px 16px -6px rgb(var(--shadow-color) / 0.16), 0 24px 48px -16px rgb(var(--shadow-color) / 0.24)',
        lifted:
          'inset 0 1px 0 0 rgb(255 255 255 / 0.9), 0 0 0 1px rgb(var(--shadow-color) / 0.05), 0 1px 2px -1px rgb(var(--shadow-color) / 0.1), 0 8px 20px -8px rgb(var(--shadow-color) / 0.12)',
        // Primary control: a lit top edge plus a tinted drop.
        control:
          'inset 0 1px 0 0 rgb(255 255 255 / 0.14), 0 1px 2px 0 rgb(var(--shadow-color) / 0.24)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
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
        'fade-up': 'fade-up 0.34s cubic-bezier(0.22, 1, 0.36, 1) both',
        'scale-in': 'scale-in 0.18s cubic-bezier(0.22, 1, 0.36, 1) both',
        'slide-in-right': 'slide-in-right 0.24s cubic-bezier(0.22, 1, 0.36, 1) both',
      },
    },
  },
  plugins: [],
};
