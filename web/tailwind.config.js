/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef4ff',
          100: '#d9e5ff',
          500: '#2c5fd4',
          600: '#1f4bb0',
          700: '#183a89',
          900: '#0f2450',
        },
      },
      fontSize: {
        // The gate screen is read at arm's length in sunlight — the base size is
        // deliberately larger than a typical web app.
        base: ['1.0625rem', { lineHeight: '1.5rem' }],
        lg: ['1.1875rem', { lineHeight: '1.75rem' }],
      },
      minHeight: {
        touch: '48px',
      },
    },
  },
  plugins: [],
};
