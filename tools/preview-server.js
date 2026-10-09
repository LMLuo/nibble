#!/usr/bin/env node
'use strict'
// preview-server.js — 极简静态服务器，只用于在浏览器里预览面板外观
// 用法: node tools/preview-server.js [port]

const http = require('http')
const fs = require('fs')
const path = require('path')

const port = Number(process.argv[2]) || 4599
const root = path.join(__dirname, '..', 'vscode-extension', 'media')

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }

http
  .createServer((req, res) => {
    const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '') || 'preview.html'
    const file = path.join(root, rel)
    if (!file.startsWith(root) || !fs.existsSync(file)) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  .listen(port, '127.0.0.1', () => console.log('preview server on http://127.0.0.1:' + port + '/preview.html'))
