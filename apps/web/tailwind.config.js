/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: {
          50: '#f2f6fb',
          100: '#e2ebf5',
          200: '#c5d6ea',
          300: '#9ab7d6',
          400: '#6891bd',
          500: '#4573a4',
          600: '#345b88',
          700: '#2c4a6f',
          800: '#283f5d',
          900: '#24374f',
          950: '#162234',
        },
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
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)',
        pop: '0 10px 30px -6px rgb(15 23 42 / 0.16)',
      },
    },
  },
  plugins: [],
};
