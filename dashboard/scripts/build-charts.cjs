'use strict';

const path = require('node:path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');

esbuild.buildSync({
  entryPoints: [path.join(root, 'src/charts.jsx')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  outfile: path.join(root, 'public/assets/charts.js'),
  legalComments: 'none',
});
