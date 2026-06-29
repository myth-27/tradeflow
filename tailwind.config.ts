import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './hooks/**/*.{js,ts,jsx,tsx}',
    './lib/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        'brand-green': '#22c55e',
        'brand-red': '#ef4444',
        'brand-amber': '#f59e0b',
        'brand-purple': '#8b5cf6',
        'brand-blue': '#3b82f6',
      },
    },
  },
  plugins: [],
};

export default config;
