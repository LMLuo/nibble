#!/usr/bin/env node
'use strict'
// make-vsix.js — 离线打包 .vsix（不依赖 vsce / npm 联网）
// VSIX 就是一个 zip：根下有 extension.vsixmanifest、[Content_Types].xml，以及 extension/ 目录
// 用法: node tools/make-vsix.js

const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..', 'vscode-extension')
const outDir = path.resolve(__dirname, '..', 'dist')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
// 注意：刻意加 -offline 后缀，避免覆盖官方 vsce 产出的同名包（发布请用 npm run package:official）
const outFile = path.join(outDir, `${pkg.name}-${pkg.version}-offline.vsix`)

if (pkg.repository && String(pkg.repository.url).includes('REPLACE-ME')) {
  console.log('⚠️  repository 仍是占位符（REPLACE-ME）—— 本地安装没问题，但发布到 Open VSX 前请改成真实仓库地址')
}
if (!fs.existsSync(path.join(root, 'icon.png'))) {
  console.log('⚠️  缺少 icon.png，市场列表会没有图标（运行 node tools/make-icon.js 生成）')
}
if (!fs.existsSync(path.join(root, 'lib', 'nibble.js'))) {
  console.error('❌ 缺少 vscode-extension/lib/（自包含副本，不入库）')
  console.error('   请先运行: npm run sync   （或 node tools/sync-lib.js）')
  process.exit(1)
}

// ---------------- CRC32 + 最小 ZIP（store，不压缩）----------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c
  }
  return t
})()
function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (~c) >>> 0
}
function zip(entries) {
  const parts = []
  const central = []
  let offset = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const crc = crc32(e.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8) // store
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12) // 1980-01-01
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(e.data.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    parts.push(local, nameBuf, e.data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0, 8)
    cd.writeUInt16LE(0, 10)
    cd.writeUInt16LE(0, 12)
    cd.writeUInt16LE(0x21, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(e.data.length, 20)
    cd.writeUInt32LE(e.data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(0, 38)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)
    offset += local.length + nameBuf.length + e.data.length
  }
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cdBuf, eocd])
}

// ---------------- 收集文件 ----------------
const EXCLUDE = new Set(['.vscodeignore', 'config.json', 'media/preview.html'])
const SKIP_DIRS = new Set(['icon-src', 'node_modules', '.vscode', '.git'])
function walk(dir, rel = '') {
  const out = []
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const abs = path.join(dir, name)
    const relPath = (rel ? rel + '/' : '') + name
    if (EXCLUDE.has(relPath)) continue
    const st = fs.statSync(abs)
    if (st.isDirectory()) out.push(...walk(abs, relPath))
    else out.push(relPath)
  }
  return out
}

const files = walk(root).sort()
const entries = [{ name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES(), 'utf8') }]
for (const rel of files) {
  entries.push({ name: 'extension/' + rel.replace(/\\/g, '/'), data: fs.readFileSync(path.join(root, rel)) })
}
entries.push({ name: 'extension.vsixmanifest', data: Buffer.from(VSIX_MANIFEST(), 'utf8') })

fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(outFile, zip(entries))

console.log('✅ 已打包 ' + outFile)
console.log('   大小 ' + (fs.statSync(outFile).size / 1024).toFixed(1) + ' KB，共 ' + entries.length + ' 个条目：')
for (const e of entries) console.log('   - ' + e.name)

function CONTENT_TYPES() {
  return `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".html" ContentType="text/html"/>
  <Default Extension=".svg" ContentType="image/svg+xml"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>`
}

function VSIX_MANIFEST() {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const list = (v) => (Array.isArray(v) ? v.join(',') : '')
  // 注意：Assets / Icon / Categories 缺一不可 —— Open VSX 拿不到图标与详情资源时会直接 406 拒绝发布会。
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${esc(pkg.name)}" Version="${esc(pkg.version)}" Publisher="${esc(pkg.publisher)}" />
    <DisplayName>${esc(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${esc(pkg.description)}</Description>
    <Tags>${esc(list(pkg.keywords))}</Tags>
    <Categories>${esc(list(pkg.categories))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${esc(pkg.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free"/>
    </Properties>
    <License>extension/LICENSE</License>
    <Icon>extension/icon.png</Icon>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/icon.png" Addressable="true" />
  </Assets>
</PackageManifest>`
}
