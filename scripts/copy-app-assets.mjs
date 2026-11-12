import { mkdirSync, cpSync } from 'node:fs';
mkdirSync('dist/app/shell', { recursive: true });
cpSync('src/app/shell', 'dist/app/shell', { recursive: true });
