import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  '#f3faf9',
          100: '#d6f0ed',
          500: '#0fb09c',
          600: '#0e9486',
          700: '#0c7669',
        },
      },
    },
  },
  plugins: [],
};
export default config;
