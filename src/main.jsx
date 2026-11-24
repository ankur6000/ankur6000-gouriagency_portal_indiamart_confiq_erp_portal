import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, Check, ChevronDown, CircleHelp, LockKeyhole, Mail, Menu, Package, Pencil, Phone, Plus, ShieldCheck, Sparkles, WhatsApp, X } from './icons.jsx'
import { createStatementPdf, getStatementPeriodRange } from './statementPdf.js'
import { createHolidayCalendarPdf } from './holidayPdf.js'
import { createNoticePdf } from './noticePdf.js'
import { indiaHolidayStates } from './indiaHolidayStates.js'
import SalesAnalysis from './SalesAnalysis.jsx'
import './styles.css'

const API = '/api'
const SITE_BUILD_TIMESTAMP = __PORTAL_BUILD_TIMESTAMP__
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024
const MAX_HOME_SLIDER_IMAGE_BYTES = 2 * 1024 * 1024
const MAX_BULK_ORDER_FILE_BYTES = 10 * 1024 * 1024

async function readApiJson(response, fallbackMessage = 'The portal returned an unexpected response.') {
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error(fallbackMessage)
  }
  try {
    return await response.json()
  } catch {
    throw new Error(fallbackMessage)
  }
}

function parseCsvRows(source) {
  const text = String(source || '').replace(/^\uFEFF/, '')
  const firstLine = text.split(/\r?\n/, 1)[0] || ''
  const delimiter = !firstLine.includes(',') && firstLine.includes(';') ? ';' : ','
  const rows = []
  let row = []; let field = ''; let quoted = false
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index++ }
      else if (character === '"') quoted = false
      else field += character
    } else if (character === '"' && field.length === 0) quoted = true
    else if (character === delimiter) { row.push(field); field = '' }
    else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index++
      row.push(field); rows.push(row); row = []; field = ''
    } else field += character
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows
}

function zipEntriesFromXlsx(buffer) {
  const view = new DataView(buffer)
  const minEnd = Math.max(0, view.byteLength - 65_557)
  let endRecord = -1
  for (let offset = view.byteLength - 22; offset >= minEnd; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) { endRecord = offset; break }
  }
  if (endRecord < 0) throw new Error('This Excel workbook could not be read. Save it as .xlsx or upload a CSV file.')
  const count = view.getUint16(endRecord + 10, true)
  let offset = view.getUint32(endRecord + 16, true)
  const decoder = new TextDecoder()
  const entries = new Map()
  for (let index = 0; index < count; index++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('This Excel workbook has an invalid file table.')
    const method = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const uncompressedSize = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localOffset = view.getUint32(offset + 42, true)
    const name = decoder.decode(new Uint8Array(buffer, offset + 46, nameLength))
    entries.set(name, { method, compressedSize, uncompressedSize, localOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

async function readXlsxEntry(buffer, entries, name) {
  const entry = entries.get(name)
  if (!entry) return null
  if (entry.uncompressedSize > 25 * 1024 * 1024) throw new Error('The Excel sheet is too large to import safely.')
  const view = new DataView(buffer)
  const local = entry.localOffset
  if (view.getUint32(local, true) !== 0x04034b50) throw new Error('This Excel workbook contains an invalid sheet.')
  const dataOffset = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
  const compressed = buffer.slice(dataOffset, dataOffset + entry.compressedSize)
  if (entry.method === 0) return new TextDecoder().decode(compressed)
  if (entry.method !== 8 || typeof DecompressionStream === 'undefined') throw new Error('This browser cannot open this Excel workbook. Save it as CSV and upload the CSV instead.')
  try {
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
    return new TextDecoder().decode(await new Response(stream).arrayBuffer())
  } catch { throw new Error('Could not decompress this Excel workbook. Save it as CSV and upload the CSV instead.') }
}

function xmlElements(parent, localName) {
  return [...parent.getElementsByTagName('*')].filter(element => element.localName === localName)
}

function xmlText(parent) {
  return xmlElements(parent, 't').map(element => element.textContent || '').join('')
}

async function parseXlsxRows(file) {
  const buffer = await file.arrayBuffer()
  const entries = zipEntriesFromXlsx(buffer)
  const workbookText = await readXlsxEntry(buffer, entries, 'xl/workbook.xml')
  if (!workbookText) throw new Error('The Excel workbook does not contain a readable worksheet.')
  const workbook = new DOMParser().parseFromString(workbookText, 'application/xml')
  if (workbook.getElementsByTagName('parsererror').length) throw new Error('The Excel workbook has invalid worksheet metadata.')
  const firstSheet = xmlElements(workbook, 'sheet')[0]
  const relationshipId = firstSheet?.getAttribute('r:id') || firstSheet?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')
  const relationshipsText = await readXlsxEntry(buffer, entries, 'xl/_rels/workbook.xml.rels')
  let worksheetPath = 'xl/worksheets/sheet1.xml'
  if (relationshipId && relationshipsText) {
    const relationships = new DOMParser().parseFromString(relationshipsText, 'application/xml')
    const relationship = xmlElements(relationships, 'Relationship').find(item => item.getAttribute('Id') === relationshipId)
    if (relationship?.getAttribute('Target')) {
      const target = relationship.getAttribute('Target').replace(/^\//, '')
      worksheetPath = target.startsWith('xl/') ? target : `xl/${target.replace(/^\.\//, '')}`
    }
  }
  const sheetText = await readXlsxEntry(buffer, entries, worksheetPath)
  if (!sheetText) throw new Error('The first worksheet could not be found in this Excel workbook.')
  const sheet = new DOMParser().parseFromString(sheetText, 'application/xml')
  if (sheet.getElementsByTagName('parsererror').length) throw new Error('The first worksheet contains invalid data.')
  const sharedText = await readXlsxEntry(buffer, entries, 'xl/sharedStrings.xml')
  const sharedStrings = sharedText ? xmlElements(new DOMParser().parseFromString(sharedText, 'application/xml'), 'si').map(xmlText) : []
  const rows = []
  for (const rowElement of xmlElements(sheet, 'row')) {
    const row = []
    for (const cell of [...rowElement.children].filter(element => element.localName === 'c')) {
      const letters = (cell.getAttribute('r') || '').match(/^[A-Z]+/i)?.[0] || ''
      let column = 0
      for (const letter of letters.toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64
      column--
      const valueElement = [...cell.children].find(element => element.localName === 'v')
      const inlineElement = [...cell.children].find(element => element.localName === 'is')
      let value = valueElement?.textContent || (inlineElement ? xmlText(inlineElement) : '')
      if (cell.getAttribute('t') === 's') value = sharedStrings[Number(value)] ?? ''
      if (column >= 0) row[column] = value
    }
    rows.push(row)
  }
  return rows
}

function toMedicineOrderRows(rows) {
  const nonEmpty = rows.filter(row => row.some(value => String(value ?? '').trim()))
  if (!nonEmpty.length) throw new Error('No medicine rows were found. Add “Medicine name” and “Quantity” columns to the sheet.')
  const normalizeHeading = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const names = new Set(['medicinename', 'medicine', 'productname', 'product', 'itemname', 'item', 'drugname'])
  const quantities = new Set(['quantity', 'qty', 'quantitypcs', 'quantityboxes', 'quantityboxespcs', 'pcs', 'boxes'])
  const header = nonEmpty[0].map(normalizeHeading)
  const nameColumn = header.findIndex(value => names.has(value))
  const quantityColumn = header.findIndex(value => quantities.has(value))
  const hasHeader = nameColumn >= 0 && quantityColumn >= 0
  const dataRows = hasHeader ? nonEmpty.slice(1) : nonEmpty
  const nameIndex = hasHeader ? nameColumn : 0
  const quantityIndex = hasHeader ? quantityColumn : 1
  const items = dataRows.map(row => ({ name: String(row[nameIndex] ?? '').trim(), quantity: String(row[quantityIndex] ?? '').trim() }))
    .filter(item => item.name || item.quantity)
  if (!items.length) throw new Error('No medicine entries were found beneath the column headings.')
  if (items.length > 100) throw new Error('A single order can contain up to 100 medicine rows. Split this sheet into smaller orders.')
  const incomplete = items.findIndex(item => !item.name || !item.quantity || !/^[A-Za-z0-9][A-Za-z0-9 ./-]{0,59}$/.test(item.quantity))
  if (incomplete >= 0) throw new Error(`Check spreadsheet row ${incomplete + (hasHeader ? 2 : 1)}: enter a medicine name and a quantity of up to 60 letters, numbers, spaces, dots, slashes, or hyphens.`)
  return items
}

function ClientBulkOrderUpload({ disabled, onImport, resetToken }) {
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)
  useEffect(() => { setMessage(''); setError(false) }, [resetToken])
  const importFile = async event => {
    const file = event.target.files?.[0]
    if (!file) return
    setMessage(''); setError(false)
    try {
      if (file.size > MAX_BULK_ORDER_FILE_BYTES) throw new Error('Choose a CSV or Excel file up to 10 MB.')
      const extension = file.name.split('.').pop().toLowerCase()
      if (!['csv', 'xlsx'].includes(extension)) throw new Error('Upload a .csv or modern Excel .xlsx file.')
      const rows = extension === 'csv' ? parseCsvRows(await file.text()) : await parseXlsxRows(file)
      const items = toMedicineOrderRows(rows)
      onImport(items)
      setMessage(`${items.length} medicine rows imported. Review and edit them below, then submit the order for approval.`)
    } catch (importError) {
      setMessage(importError.message || 'Could not read this order sheet.')
      setError(true)
    } finally { event.target.value = '' }
  }
  const downloadTemplate = () => {
    const blob = new Blob(['Medicine name,Quantity\r\n'], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url; link.download = 'Gouri-Agency-order-template.csv'; link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }
  return <section className="bulk-order-upload" aria-label="Import medicine order spreadsheet">
    <div><strong>Import an order sheet</strong><small>Upload CSV or Excel (.xlsx) with “Medicine name” and “Quantity” columns. The first sheet is imported and stays editable before you submit.</small></div>
    <div className="bulk-order-upload-actions"><label className="button outline" aria-disabled={disabled}>Choose CSV / Excel<input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={disabled} onChange={importFile}/></label><button type="button" className="text-button" disabled={disabled} onClick={downloadTemplate}>Download CSV template</button></div>
    {message && <small className={`bulk-order-upload-message${error ? ' error' : ''}`} role={error ? 'alert' : 'status'}>{message}</small>}
  </section>
}

function encodeUpload(file, label, acceptedTypes, maxBytes = MAX_UPLOAD_BYTES) {
  if (!file) return Promise.resolve(null)
  if (file.size > maxBytes) return Promise.reject(new Error(`${label} must be ${Math.floor(maxBytes / (1024 * 1024))} MB or smaller.`))
  const extension = file.name.split('.').pop().toLowerCase()
  const typeByExtension = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png'
  }
  const expectedType = typeByExtension[extension]
  if (!expectedType || !acceptedTypes.includes(expectedType) || (file.type && file.type !== expectedType)) {
    return Promise.reject(new Error(`${label} must be an accepted PDF or image file.`))
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve({ name: file.name, type: expectedType, data: reader.result })
    reader.onerror = () => reject(new Error(`Could not read ${label.toLowerCase()}.`))
    reader.readAsDataURL(file)
  })
}

async function extractSignature(file) {
  if (!file) throw new Error('Upload the required signature image.')
  const encoded = await encodeUpload(file, 'Signature image', ['image/jpeg', 'image/png'])
  const image = new Image()
  await new Promise((resolve, reject) => {
    image.onload = resolve
    image.onerror = () => reject(new Error('Could not read the signature image.'))
    image.src = encoded.data
  })
  const scale = Math.min(1, 1400 / Math.max(image.naturalWidth, image.naturalHeight))
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))
  const sourceCanvas = document.createElement('canvas')
  sourceCanvas.width = width; sourceCanvas.height = height
  const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true })
  sourceContext.fillStyle = '#fff'; sourceContext.fillRect(0, 0, width, height)
  sourceContext.drawImage(image, 0, 0, width, height)

  const backgroundCanvas = document.createElement('canvas')
  backgroundCanvas.width = width; backgroundCanvas.height = height
  const backgroundContext = backgroundCanvas.getContext('2d', { willReadFrequently: true })
  backgroundContext.fillStyle = '#fff'; backgroundContext.fillRect(0, 0, width, height)
  if ('filter' in backgroundContext) {
    const blurRadius = Math.max(2, Math.round(Math.min(width, height) * 0.025))
    backgroundContext.filter = `blur(${blurRadius}px)`
  }
  backgroundContext.drawImage(sourceCanvas, 0, 0)
  backgroundContext.filter = 'none'

  const source = sourceContext.getImageData(0, 0, width, height).data
  const background = backgroundContext.getImageData(0, 0, width, height).data
  const extracted = sourceContext.createImageData(width, height)
  let minX = width, minY = height, maxX = -1, maxY = -1, strongestInk = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4
      const luminance = source[index] * 0.2126 + source[index + 1] * 0.7152 + source[index + 2] * 0.0722
      const paper = background[index] * 0.2126 + background[index + 1] * 0.7152 + background[index + 2] * 0.0722
      const contrast = Math.max(0, paper - luminance)
      strongestInk = Math.max(strongestInk, contrast)
      const level = Math.max(0, Math.min(1, (contrast - 12) / 55))
      const alpha = Math.round(Math.pow(level, 0.62) * 255)
      extracted.data[index] = 0
      extracted.data[index + 1] = 0
      extracted.data[index + 2] = 0
      extracted.data[index + 3] = alpha
      if (alpha > 8) {
        minX = Math.min(minX, x); minY = Math.min(minY, y)
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
      }
    }
  }
  if (maxX < minX || maxY < minY || strongestInk < 30) {
    throw new Error('Could not detect the signature. Use a clear dark signature on plain light paper.')
  }
  sourceContext.putImageData(extracted, 0, 0)
  const inkWidth = maxX - minX + 1, inkHeight = maxY - minY + 1
  const padding = Math.max(8, Math.min(40, Math.round(Math.max(inkWidth, inkHeight) * 0.06)))
  const outputCanvas = document.createElement('canvas')
  outputCanvas.width = inkWidth + padding * 2; outputCanvas.height = inkHeight + padding * 2
  outputCanvas.getContext('2d').drawImage(sourceCanvas, minX, minY, inkWidth, inkHeight, padding, padding, inkWidth, inkHeight)
  const data = outputCanvas.toDataURL('image/png')
  const encodedPng = data.split(',')[1] || ''
  if (Math.floor(encodedPng.length * 3 / 4) > MAX_UPLOAD_BYTES) throw new Error('The extracted signature is too large. Use a smaller signature image.')
  const baseName = file.name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9 _-]/gi, '').trim() || 'signature'
  return { name: `${baseName}-signature.png`, type: 'image/png', data }
}

function downloadPdfDataUrl(file) {
  if (!file?.data?.startsWith('data:application/pdf;base64,')) return false
  const encoded = file.data.slice(file.data.indexOf(',') + 1)
  const binary = window.atob(encoded)
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
  const blob = new Blob([bytes], { type: 'application/pdf' })
  const link = document.createElement('a')
  const url = URL.createObjectURL(blob)
  link.href = url; link.download = file.name || 'Gouri Agency order ledger.pdf'
  document.body.appendChild(link); link.click(); link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
  return true
}

async function downloadProtectedPdf(path, token) {
  const response = await fetch(path, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error || 'Could not download this PDF.')
  }
  const blob = await response.blob()
  const fileName = /filename="([^"]+)"/i.exec(response.headers.get('content-disposition') || '')?.[1] || 'Gouri Agency.pdf'
  const link = document.createElement('a')
  const url = URL.createObjectURL(blob)
  link.href = url; link.download = fileName
  document.body.appendChild(link); link.click(); link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
  notifyActionSuccess('PDF downloaded successfully.')
}

function safeArchiveName(value) {
  return String(value || 'Customer profile').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '') || 'Customer profile'
}

function uploadBytes(upload) {
  const base64 = upload.data.split(',')[1] || ''
  const binary = window.atob(base64)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function uploadExtension(upload) {
  return { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' }[upload.type] || upload.name.split('.').pop().toLowerCase()
}

function Mark({ small = false, className = '' }) {
  return <span className={`brand-mark ${small ? 'small' : ''} ${className}`.trim()} aria-label="Gouri Agency"><span>G</span><i>A</i></span>
}

function BrandLoadingMark({ inline = false, label = 'Loading' }) {
  return <span className={`brand-loading-mark${inline ? ' inline' : ''}`} role="status" aria-label={label}><Mark small={inline} className="flipflop-mark"/></span>
}

function LoadingAction({ label }) {
  return <span className="loading-action"><BrandLoadingMark inline label={label}/><span>{label}</span></span>
}

function notifyActionSuccess(message) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('gouri-action-success', { detail: { message } }))
}

function ActionToast() {
  const [message, setMessage] = useState('')
  useEffect(() => {
    let timer
    const show = event => {
      const nextMessage = String(event.detail?.message || '').trim()
      if (!nextMessage) return
      setMessage(nextMessage)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setMessage(''), 10000)
    }
    window.addEventListener('gouri-action-success', show)
    return () => { window.clearTimeout(timer); window.removeEventListener('gouri-action-success', show) }
  }, [])
  if (!message) return null
  return <div className="action-toast" role="status" aria-live="polite"><span className="action-toast-check"><Check size={16}/></span><span className="action-toast-message">{message}</span><button type="button" aria-label="Dismiss notification" onClick={() => setMessage('')}>×</button><button type="button" className="action-toast-ok" onClick={() => setMessage('')}>OK</button></div>
}

function PagePreloader({ leaving }) {
  return <div className={`loader${leaving ? ' out' : ''}`} role="status" aria-live="polite" aria-hidden={leaving}>
    <div className="loader-inner"><Mark className="flipflop-mark"/><span className="loader-word">GOURI AGENCY PORTAL</span><div className="load-track"><i/></div><span className="loader-caption">Preparing your workspace</span></div>
  </div>
}

function PublicHolidayCalendar() {
  const indiaYear = () => Number(new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric' }).format(new Date()))
  const [currentYear, setCurrentYear] = useState(indiaYear)
  const availableYears = [...new Set([2026, currentYear, currentYear + 1])].sort((a, b) => b - a)
  const [year, setYear] = useState(currentYear)
  const [stateCode, setStateCode] = useState('WB')
  const [calendar, setCalendar] = useState(null)
  const [calendarLoading, setCalendarLoading] = useState(false)
  const [holidayCalendarError, setHolidayCalendarError] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setCalendar(null)
    setHolidayCalendarError('')
    setCalendarLoading(true)
    const loadCalendar = async () => {
      try {
        let data
        if (year === 2026) {
          const module = await import('./indiaHolidayEngine.js')
          data = module.createIndiaHolidayCalendar(year, stateCode)
          if (!data) throw new Error('The checked 2026 list is unavailable for this region.')
        } else {
          const response = await fetch(`${API}/holidays/${year}/${stateCode}`, { signal: controller.signal, headers: { Accept: 'application/json' } })
          data = await response.json().catch(() => null)
          if (!response.ok || !Array.isArray(data?.holidays)) throw new Error(data?.error || 'The holiday calendar could not be loaded.')
        }
        if (!controller.signal.aborted) setCalendar(data)
      } catch (error) {
        if (!controller.signal.aborted) setHolidayCalendarError(error.message || 'The holiday calendar could not be loaded.')
      } finally { if (!controller.signal.aborted) setCalendarLoading(false) }
    }
    loadCalendar()
    return () => controller.abort()
  }, [stateCode, year])
  useEffect(() => {
    const timer = window.setInterval(() => setCurrentYear(indiaYear()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => { setYear(currentYear) }, [currentYear])
  const isLoadingCalendar = calendarLoading
  const months = Array.from({ length: 12 }, (_, index) => ({
    month: index + 1,
    holidays: (calendar?.holidays || []).filter(holiday => Number(holiday.date.slice(5, 7)) === index + 1)
  }))
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const upcomingHoliday = calendar?.holidays?.filter(holiday => holiday.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0]
  const displayDate = date => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', weekday: 'short' }).format(new Date(`${date}T12:00:00+05:30`))
  const displayMonth = month => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', month: 'long' }).format(new Date(Date.UTC(year, month - 1, 15, 12)))
  const download = async () => {
    if (!calendar || downloading) return
    setDownloading(true)
    setDownloadError('')
    try {
      const blob = await createHolidayCalendarPdf({ year, calendar })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      const stateName = calendar.region.split(',')[0].replace(/[^a-z0-9 -]/gi, '').trim().replace(/\s+/g, '-')
      link.download = `Gouri-Agency-${stateName}-Holiday-Calendar-${year}.pdf`
      document.body.appendChild(link); link.click(); link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
      notifyActionSuccess(`${year} holiday calendar PDF downloaded.`)
    } catch {
      setDownloadError('Could not create the holiday PDF. Please try again.')
    } finally { setDownloading(false) }
  }
  return <section className="public-holiday-calendar" aria-labelledby="public-holiday-title">
    <div className="holiday-calendar-heading">
      <div>
        <div className="eyebrow"><span className="live-dot"/> PLAN AHEAD</div>
        <h2 id="public-holiday-title">Public holidays,<br/><em>month by month.</em></h2>
        <p>Select a region and year. The calendar follows India’s current year and loads published holiday data.</p>
      </div>
      <div className="holiday-calendar-actions">
        <label>State / union territory<select value={stateCode} onChange={event => setStateCode(event.target.value)}>{[...indiaHolidayStates].sort((a, b) => a.name.localeCompare(b.name)).map(state => <option key={state.code || state.codes[0]} value={state.code || state.codes[0]}>{state.name}{(state.code || state.codes[0]) === 'WB' ? ' · Default' : ''}</option>)}</select></label>
        <label>Calendar year<select value={year} onChange={event => setYear(Number(event.target.value))}>{availableYears.map(value => <option key={value} value={value}>{value}{value === currentYear ? ' · Current year' : ''}</option>)}</select></label>
        <button className="button dark" type="button" onClick={download} disabled={!calendar || downloading}>{downloading ? <LoadingAction loading label="Preparing PDF…"/> : <>Download holiday PDF <ArrowDown size={15}/></>}</button>
      </div>
    </div>
    {downloadError && <p className="holiday-download-error" role="alert">{downloadError}</p>}
    {calendar ? <>
      <div className="holiday-calendar-meta"><span>{calendar.region}</span><span>{calendar.holidays.length} listed dates</span><span>{calendar.notification}</span></div>
      <div className="holiday-month-grid">
        {months.map(group => <section className="holiday-month-card" key={group.month}>
          <header><h3>{displayMonth(group.month)}</h3><span>{group.holidays.length}</span></header>
          {group.holidays.length ? <ul>{group.holidays.map((holiday, index) => <li className={holiday.date === upcomingHoliday?.date && holiday.name === upcomingHoliday?.name ? 'holiday-upcoming' : ''} key={`${holiday.date}-${holiday.name}-${index}`}>
            <span className="holiday-emoji" aria-hidden="true">{holiday.emoji}</span>
            <span className="holiday-event"><strong>{holiday.name}</strong><small>{holiday.category}{holiday.note ? ` · ${holiday.note}` : ''}</small></span>
            <time dateTime={holiday.date}>{displayDate(holiday.date)}</time>
            {holiday.date === today && <span className="holiday-day-flag">TODAY</span>}
            {holiday.date === upcomingHoliday?.date && holiday.name === upcomingHoliday?.name && holiday.date !== today && <span className="holiday-day-flag">NEXT</span>}
          </li>)}</ul> : <p className="holiday-empty-month">No holiday listed for this month in the selected calendar.</p>}
        </section>)}
      </div>
      <p className="holiday-calendar-note">{calendar.coverageNote || 'Dates can change in official notices, especially religious dates and additional state closures. Confirm with the relevant government gazette before planning.'}</p>
      <div className="holiday-calendar-sources"><span>Calendar sources:</span>{calendar.sources?.length ? calendar.sources.map(source => <a href={source.url} key={source.url} target="_blank" rel="noreferrer">{source.label} <ArrowUpRight size={13}/></a>) : <><a href={calendar.sourceUrl} target="_blank" rel="noreferrer">{calendar.sourceLabel || 'Government holiday calendar'} <ArrowUpRight size={13}/></a>{calendar.attribution && <a href="https://www.indiadigital.org/open/data/" target="_blank" rel="noreferrer">Data by IndiaDigital · CC BY 4.0 <ArrowUpRight size={13}/></a>}{calendar.updateUrls?.map(source => <a href={source.url} key={source.url + source.label} target="_blank" rel="noreferrer">{source.label} <ArrowUpRight size={13}/></a>)}{!calendar.updateUrls?.length && calendar.updateUrl && <a href={calendar.updateUrl} target="_blank" rel="noreferrer">Government updates <ArrowUpRight size={13}/></a>}</>}</div>
    </> : <div className="holiday-calendar-unpublished"><span aria-hidden="true">{isLoadingCalendar ? '\u23F3' : '\uD83D\uDCC5'}</span><div><strong>{isLoadingCalendar ? 'Loading the state holiday calendar...' : `The ${year} holiday calendar is not available yet.`}</strong><p>{holidayCalendarError || (isLoadingCalendar ? 'Preparing the selected state list.' : 'Published dates will appear here when available.')}</p><a href="https://www.india.gov.in/topics/law-justice/holidays" target="_blank" rel="noreferrer">Open India government holiday information <ArrowUpRight size={14}/></a></div></div>}
  </section>
}

const FALLBACK_HOME_SLIDER_SETTINGS = {
  enabled: true,
  intervalSeconds: 10,
  images: Array.from({ length: 6 }, (_, index) => ({
    id: `fallback-slide-${index + 1}`,
    name: ['Healthcare supplies', 'Distribution center', 'Reliable delivery', 'Community pharmacy', 'Careful handling', 'Secure supply chain'][index],
    url: `/home-slider/default-${index + 1}.svg`
  }))
}

function noticePdfFilename(notice) {
  const name = String(notice.title || 'gouri-agency-notice').normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
  return `${name || 'gouri-agency-notice'}.pdf`
}

function getIndiaNoticeClock(date = new Date()) {
  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date)
  const datePart = type => dateParts.find(part => part.type === type)?.value || ''
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(date)
  return { date: `${datePart('year')}-${datePart('month')}-${datePart('day')}`, time }
}

function noticeIsVisibleNow(notice, now = new Date()) {
  if (notice.scheduleEnabled !== true) return true
  const { date, time } = getIndiaNoticeClock(now)
  if (notice.startDate && date < notice.startDate) return false
  if (notice.endDate && date > notice.endDate) return false
  if (!notice.startTime || !notice.endTime) return true
  return notice.startTime <= notice.endTime
    ? time >= notice.startTime && time < notice.endTime
    : time >= notice.startTime || time < notice.endTime
}

function noticeScheduleSummary(notice) {
  if (notice.scheduleEnabled !== true) return 'Visible every day · all day'
  const dates = notice.startDate || notice.endDate
    ? `${notice.startDate || 'No start date'} – ${notice.endDate || 'No end date'}`
    : 'Every day'
  const hours = notice.startTime && notice.endTime ? `${notice.startTime}–${notice.endTime} IST` : 'All day'
  return `${dates} · ${hours}`
}

async function downloadNoticePdf(notice) {
  const blob = await createNoticePdf(notice)
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = noticePdfFilename(notice)
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function HomeNoticeBoard() {
  const [notices, setNotices] = useState([])
  const [scheduleClock, setScheduleClock] = useState(Date.now())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [downloadingId, setDownloadingId] = useState('')
  useEffect(() => {
    let cancelled = false
    const loadNotices = async () => {
      try {
        const response = await fetch(`${API}/notices`, { cache: 'no-store', headers: { Accept: 'application/json' } })
        const data = await readApiJson(response, 'Could not load the notice board.')
        if (!response.ok) throw new Error(data.error || 'Could not load the notice board.')
        if (!cancelled) { setNotices(Array.isArray(data.notices) ? data.notices : []); setError('') }
      } catch (loadError) {
        if (!cancelled) setError(loadError.message || 'Notices are temporarily unavailable.')
      } finally { if (!cancelled) setLoading(false) }
    }
    loadNotices()
    const refresh = window.setInterval(loadNotices, 30000)
    return () => { cancelled = true; window.clearInterval(refresh) }
  }, [])
  useEffect(() => {
    const refreshClock = window.setInterval(() => setScheduleClock(Date.now()), 15000)
    return () => window.clearInterval(refreshClock)
  }, [])
  const download = async notice => {
    setDownloadingId(notice.id)
    try { await downloadNoticePdf(notice) }
    catch (downloadError) { setError(downloadError.message || 'Could not create the notice PDF.') }
    finally { setDownloadingId('') }
  }
  const visibleNotices = useMemo(() => notices.filter(notice => noticeIsVisibleNow(notice, new Date(scheduleClock))), [notices, scheduleClock])
  const newestId = visibleNotices[0]?.id
  const duration = `${Math.max(18, visibleNotices.length * 9)}s`
  const renderNotice = (notice, index, repeated = false) => <article className={`home-notice-card${notice.priority === 'high' ? ' is-high-priority' : ''}${notice.id === newestId ? ' is-latest' : ''}`} key={`${repeated ? 'loop-' : ''}${notice.id}-${index}`}>
    <div className="home-notice-card-copy">
      <div className="home-notice-card-title-row">
        {notice.priority === 'high' && <span className="notice-exclamation" aria-label="High priority">!</span>}
        <h3>{notice.title}</h3>
        {notice.id === newestId && <span className="notice-new-badge">NEW</span>}
      </div>
      <p>{notice.body}</p>
      <time dateTime={notice.createdAt}>{new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(notice.createdAt))} IST</time>
    </div>
    <button type="button" className="button outline notice-pdf-button" disabled={repeated || downloadingId === notice.id} tabIndex={repeated ? -1 : undefined} onClick={() => download(notice)}>{downloadingId === notice.id ? <LoadingAction loading label="Preparing PDF…"/> : <>Download PDF <ArrowDown size={14}/></>}</button>
  </article>
  return <section className="home-notice-board" aria-labelledby="home-notice-title">
    <div className="home-notice-heading"><div><span className="eyebrow"><span className="live-dot"/> UPDATES FROM GOURI AGENCY</span><h2 id="home-notice-title">Notice board</h2></div><span className="home-notice-count">{visibleNotices.length} {visibleNotices.length === 1 ? 'notice' : 'notices'}</span></div>
    {loading ? <div className="home-notice-empty" role="status">Loading current notices…</div> : visibleNotices.length ? <div className="home-notice-window" aria-label="Notices scroll upward. Focus or hover to pause.">
      <div className="home-notice-track" style={{ '--notice-marquee-duration': duration }}>
        <div className="home-notice-group">{visibleNotices.map((notice, index) => renderNotice(notice, index))}</div>
        <div className="home-notice-group" aria-hidden="true">{visibleNotices.map((notice, index) => renderNotice(notice, index, true))}</div>
      </div>
    </div> : <div className={`home-notice-empty${error ? ' has-error' : ''}`} role={error ? 'status' : undefined}>{error || 'There are no current notices. Please check back for updates.'}</div>}
    {error && visibleNotices.length > 0 && <p className="home-notice-refresh-error" role="status">{error}</p>}
  </section>
}

function HomeImageSlider() {
  const [settings, setSettings] = useState(FALLBACK_HOME_SLIDER_SETTINGS)
  const [activeIndex, setActiveIndex] = useState(0)
  useEffect(() => {
    let cancelled = false
    fetch(`${API}/home-slider`, { cache: 'no-store' })
      .then(async response => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Could not load home images.')
        if (!cancelled) setSettings(data)
      })
      .catch(() => { if (!cancelled) setSettings(FALLBACK_HOME_SLIDER_SETTINGS) })
    return () => { cancelled = true }
  }, [])
  const images = (settings?.images || []).filter(Boolean)
  useEffect(() => {
    setActiveIndex(current => Math.min(current, Math.max(0, images.length - 1)))
  }, [images.length])
  useEffect(() => {
    if (!settings?.enabled || images.length < 2) return undefined
    const timer = window.setInterval(() => setActiveIndex(current => (current + 1) % images.length), settings.intervalSeconds * 1000)
    return () => window.clearInterval(timer)
  }, [settings?.enabled, settings?.intervalSeconds, images.length])
  if (!settings?.enabled || !images.length) return null
  const activeImage = images[activeIndex]
  const moveTo = direction => setActiveIndex(current => (current + direction + images.length) % images.length)
  return <section className="home-image-slider" aria-label="Gouri Agency image gallery" aria-roledescription="carousel">
    <div className="home-image-frame">
      <img key={activeImage.id} src={activeImage.url} alt={activeImage.name || `Gouri Agency slide ${activeIndex + 1}`} fetchPriority={activeIndex === 0 ? 'high' : 'auto'}/>
      <div className="home-image-caption"><span>GOURI AGENCY</span><strong>Wholesale healthcare distribution</strong></div>
      {images.length > 1 && <>
        <button type="button" className="home-image-arrow previous" aria-label="Previous image" onClick={() => moveTo(-1)}>‹</button>
        <button type="button" className="home-image-arrow next" aria-label="Next image" onClick={() => moveTo(1)}>›</button>
        <div className="home-image-dots" role="tablist" aria-label="Choose a slide">{images.map((image, index) => <button key={image.id} type="button" role="tab" aria-label={`Show slide ${index + 1}`} aria-selected={index === activeIndex} className={index === activeIndex ? 'active' : ''} onClick={() => setActiveIndex(index)}/>)}</div>
        <span className="home-image-count">{String(activeIndex + 1).padStart(2, '0')} / {String(images.length).padStart(2, '0')}</span>
      </>}
    </div>
  </section>
}

const RAZORPAY_PUBLIC_LINK = 'https://razorpay.me/@gouriagency'

function PayOnlinePage() {
  const [redirecting, setRedirecting] = useState(true)
  const [seconds, setSeconds] = useState(5)

  useEffect(() => {
    if (!redirecting) return undefined
    const interval = window.setInterval(() => setSeconds(value => Math.max(0, value - 1)), 1000)
    const timeout = window.setTimeout(() => window.location.assign(RAZORPAY_PUBLIC_LINK), 5000)
    return () => { window.clearInterval(interval); window.clearTimeout(timeout) }
  }, [redirecting])

  const beginRedirect = () => { setSeconds(5); setRedirecting(true) }
  const openRazorpayNow = () => window.location.assign(RAZORPAY_PUBLIC_LINK)

  return <main className="inner-page pay-online-page">
    <div className="eyebrow"><span className="live-dot"/> PAYMENT</div>
    <h1 className="inner-title">Pay <em>online.</em></h1>
    <p className="inner-lede">Continue to Gouri Agency’s Razorpay payment page to complete your payment.</p>
    {!redirecting && <button type="button" className="button dark" onClick={beginRedirect}>Continue to Razorpay <ArrowUpRight size={16}/></button>}
    {redirecting && <div className="payment-redirect-backdrop">
      <section className="payment-redirect-dialog" role="dialog" aria-modal="true" aria-labelledby="payment-redirect-title">
        <span className="eyebrow"><span className="live-dot"/> RAZORPAY PAYMENT</span>
        <h2 id="payment-redirect-title">Continue to payment</h2>
        <p>You’re being redirected to Gouri Agency’s Razorpay payment page.</p>
        <div className="payment-countdown" role="status" aria-live="polite">Redirecting in <strong>{seconds}</strong> {seconds === 1 ? 'second' : 'seconds'}…</div>
        <div className="payment-redirect-actions"><button type="button" className="button dark" onClick={openRazorpayNow}>Continue now <ArrowUpRight size={15}/></button><button type="button" className="button outline" onClick={() => setRedirecting(false)}>Stay on this page</button></div>
      </section>
    </div>}
  </main>
}

function RequiredMark() {
  return <span className="required-mark" aria-hidden="true">*</span>
}

function ProfileEditor({ profile, token, admin = false, onSaved, onViewDocument, onCancel }) {
  const [draft, setDraft] = useState(profile)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [isError, setIsError] = useState(false)
  const [pincodeMessage, setPincodeMessage] = useState('')
  const pincodeTimerRef = useRef(null)
  const frozen = !admin && Boolean(profile.profileFrozen)
  const gstIdentityLocked = !admin && Boolean(profile.gstVerifiedAt)

  useEffect(() => { setDraft(profile) }, [profile])
  useEffect(() => () => window.clearTimeout(pincodeTimerRef.current), [])
  const change = (field, value) => setDraft(current => ({ ...current, [field]: value }))
  const changeProfilePincode = value => {
    const pincode = String(value || '').replace(/\D/g, '').slice(0, 6)
    setDraft(current => ({ ...current, pincode, city: '', state: '', country: 'India' }))
    setPincodeMessage('')
    window.clearTimeout(pincodeTimerRef.current)
    if (pincode.length !== 6) return
    pincodeTimerRef.current = window.setTimeout(async () => {
      setPincodeMessage('Looking up city and state…')
      try {
        const response = await fetch(`${API}/pincode/${pincode}`, { cache: 'no-store' })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Enter the location details manually.')
        setDraft(current => current.pincode === pincode ? { ...current, city: data.city || current.city, state: data.state || current.state, country: data.country || 'India' } : current)
        setPincodeMessage(`Location found: ${[data.city, data.state, data.country].filter(Boolean).join(', ')}.`)
      } catch (error) { setPincodeMessage(error.message || 'Enter the city, state, and country manually.') }
    }, 300)
  }
  const save = async event => {
    event.preventDefault()
    setSaving(true); setMessage(''); setIsError(false)
    const form = event.currentTarget
    try {
      const [ownerPhoto, drugLicense, gstCopy, signature] = await Promise.all([
        encodeUpload(form.elements.ownerPhoto.files[0], 'Profile photo', ['image/jpeg', 'image/png']),
        encodeUpload(form.elements.drugLicenseFile.files[0], 'Drug license', ['application/pdf', 'image/jpeg']),
        admin ? encodeUpload(form.elements.gstCopyFile.files[0], 'GST copy', ['application/pdf', 'image/jpeg']) : null,
        admin && form.elements.signatureFile.files[0] ? extractSignature(form.elements.signatureFile.files[0]) : null
      ])
      const payload = {
        shopName: draft.shopName, businessType: draft.businessType, ownerName: draft.ownerName,
        partnerOne: draft.partnerOne, partnerTwo: draft.partnerTwo, email: draft.email,
        mobile: draft.mobile, shopAddress: draft.shopAddress,
        pincode: draft.pincode, city: draft.city, state: draft.state, country: draft.country,
        attachments: { ownerPhoto, drugLicense, ...(admin ? { gstCopy, signature } : {}) }
      }
      payload.drugLicenseNumber = draft.drugLicenseNumber
      if (admin || !profile.profileFrozen) {
        payload.drugLicenseExpiresAt = draft.drugLicenseExpiresAt
      }
      if (admin) {
        payload.gstNumber = draft.gstNumber
      }
      const endpoint = admin ? `${API}/profiles/${encodeURIComponent(profile.id)}` : `${API}/profile`
      const response = await fetch(endpoint, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not update this profile.')
      setDraft(data.profile); onSaved(data.profile); form.reset(); setMessage('Profile updated.'); notifyActionSuccess('Profile details saved successfully.')
    } catch (err) {
      setMessage(err.message || 'Could not update this profile.'); setIsError(true)
    } finally { setSaving(false) }
  }

  return <form className="profile-editor" onSubmit={save}>
    <div className="profile-editor-intro"><ProfileAvatar profile={draft} token={token} alt={`${draft.shopName} owner`}/><div><strong>{admin ? 'Edit customer profile' : 'Your shop profile'}</strong><p>{admin ? 'Admins can update all profile details and documents.' : 'Update your contact details and drug license information. GST details remain locked.'}</p></div></div>
    {frozen && <div className="license-freeze-alert" role="alert"><strong>Profile frozen</strong><span>{profile.drugLicenseExpiryMissing ? 'The drug license expiry date is not recorded.' : `The drug license expired on ${profile.drugLicenseExpiresAt}.`} You can update the license number and upload a current copy; an admin must update the expiry date to restore order access.</span></div>}
    {draft.attachments?.signature && <div className="saved-signature"><strong>Saved authorized signature</strong>{draft.attachments.signature.data ? <img src={draft.attachments.signature.data} alt={`${draft.shopName} authorized signature`} /> : <DocumentLinks attachments={{ signature: draft.attachments.signature }} profileId={draft.id} token={token} onView={onViewDocument}/>}</div>}
    {!admin && draft.attachments?.drugLicense && <DocumentLinks attachments={{ drugLicense: draft.attachments.drugLicense }} profileId={draft.id} token={token} onView={onViewDocument}/>}
    {message && <div className={`notice profile-notice ${isError ? 'error' : ''}`} role={isError ? 'alert' : 'status'}>{isError ? <CircleHelp size={15}/> : <Check size={15}/>} {message}</div>}
    <div className="form-row"><label>Shop name<input value={draft.shopName || ''} onChange={event => change('shopName', event.target.value)} disabled={frozen || gstIdentityLocked} required />{gstIdentityLocked && <small className="locked-field-note">Locked to the verified GST registration.</small>}</label><label>Business type<span className="select-wrap"><select value={draft.businessType || ''} onChange={event => change('businessType', event.target.value)} disabled={frozen} required><option value="" disabled>Select business type</option><option>Sole proprietorship</option><option>Partnership</option></select><ChevronDown size={15}/></span></label></div>
    {draft.businessType === 'Sole proprietorship' && <label>Shop owner name<input value={draft.ownerName || ''} onChange={event => change('ownerName', event.target.value)} disabled={frozen} required /></label>}
    {draft.businessType === 'Partnership' && <div className="form-row"><label>Partner 1 name<input value={draft.partnerOne || ''} onChange={event => change('partnerOne', event.target.value)} disabled={frozen} required /></label><label>Partner 2 name<input value={draft.partnerTwo || ''} onChange={event => change('partnerTwo', event.target.value)} disabled={frozen} required /></label></div>}
    <div className="form-row"><label>Email address<input type="email" value={draft.email || ''} onChange={event => change('email', event.target.value)} disabled={frozen} required /></label><label>Mobile number<input type="tel" inputMode="tel" value={draft.mobile || ''} onChange={event => change('mobile', event.target.value)} pattern="[+]?[0-9 ()-]{10,20}" title="Enter a valid mobile number with 10 to 15 digits." disabled={frozen} required /></label></div>
    <label>Shop address<textarea rows="3" value={draft.shopAddress || ''} onChange={event => change('shopAddress', event.target.value)} disabled={frozen || gstIdentityLocked} required />{gstIdentityLocked && <small className="locked-field-note">Locked to the verified GST registration.</small>}</label>
    <div className="form-row"><label>PIN code<input inputMode="numeric" maxLength="6" value={draft.pincode || ''} onChange={event => changeProfilePincode(event.target.value)} disabled={frozen} /></label><label>City / district<input value={draft.city || ''} onChange={event => change('city', event.target.value)} disabled={frozen} /></label></div>
    {pincodeMessage && <small className="gst-verification-note" role="status">{pincodeMessage}</small>}
    <div className="form-row"><label>State<input value={draft.state || ''} onChange={event => change('state', event.target.value)} disabled={frozen} /></label><label>Country<input value={draft.country || ''} onChange={event => change('country', event.target.value)} disabled={frozen} /></label></div>
    <div className="form-row"><label>GST number<input value={draft.gstNumber || ''} onChange={event => change('gstNumber', event.target.value)} readOnly={!admin} disabled={frozen} required />{!admin && <small className="locked-field-note">GST details can only be changed by an admin.</small>}</label><label>Drug license number<input value={draft.drugLicenseNumber || ''} onChange={event => change('drugLicenseNumber', event.target.value)} required />{!admin && <small className="locked-field-note">Keep this number current with your license copy.</small>}</label></div>
    <label><span className="required-field-label">Drug license expiry date {(admin || !frozen) && <RequiredMark/>}</span><input type="date" value={draft.drugLicenseExpiresAt || ''} onChange={event => change('drugLicenseExpiresAt', event.target.value)} readOnly={frozen} required={admin || !frozen}/>{admin ? <small className="locked-field-note">Clients may update this date before it expires. After expiry, only an admin can restore access.</small> : frozen ? <small className="locked-field-note">Only an admin can update a missing or expired date.</small> : <small className="locked-field-note">You may update this date before the current license expires.</small>}</label>
    <div className={`file-upload-grid ${admin ? 'admin-profile-upload' : 'client-profile-upload'}`}><label className="file-upload">{admin ? 'Change client profile photo' : 'Profile photo'} <span className="optional-label">Optional</span><input name="ownerPhoto" type="file" accept=".jpg,.jpeg,.png,image/jpeg,image/png" disabled={frozen} /><small>{admin ? 'Choose a replacement photo; it will update the client record and future PDFs.' : 'JPG or PNG · up to 5 MB'}</small></label><label className="file-upload">Drug license copy <span className="optional-label">Optional</span><input name="drugLicenseFile" type="file" accept=".pdf,.jpg,.jpeg,application/pdf,image/jpeg" /><small>PDF or JPG · up to 5 MB</small></label>{admin && <><label className="file-upload">GST copy <span className="optional-label">Optional</span><input name="gstCopyFile" type="file" accept=".pdf,.jpg,.jpeg,application/pdf,image/jpeg" /><small>PDF or JPG · up to 5 MB</small></label><label className="file-upload">Authorized signature <span className="optional-label">Optional</span><input name="signatureFile" type="file" accept=".jpg,.jpeg,.png,image/jpeg,image/png" /><small>Clear signature on light paper</small></label></>}</div>
    <div className="profile-editor-actions">{onCancel && <button className="button outline" type="button" disabled={saving} onClick={onCancel}>Cancel editing</button>}<button className="button dark" disabled={saving}>{saving ? <LoadingAction loading label="Saving profile…"/> : <>Save profile changes <Check size={15}/></>}</button></div>
  </form>
}

function ProfileAvatar({ profile, token, alt = '' }) {
  const holder = useRef(null)
  const [visible, setVisible] = useState(false)
  const [photoUrl, setPhotoUrl] = useState('')
  const photo = profile?.attachments?.ownerPhoto || profile?.attachments?.profilePhoto
  useEffect(() => {
    if (!photo) return
    if (!('IntersectionObserver' in window)) { setVisible(true); return }
    const target = holder.current
    if (!target) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect() }
    }, { rootMargin: '120px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [profile?.id, photo?.name])
  useEffect(() => {
    setPhotoUrl('')
    if (!photo || !visible) return
    if (photo.data?.startsWith('data:')) { setPhotoUrl(photo.data); return }
    if (!profile?.id || !token) return
    const controller = new AbortController()
    let objectUrl = ''
    fetch(`${API}/profiles/${encodeURIComponent(profile.id)}/documents/ownerPhoto`, { cache: 'force-cache', headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error('Could not load profile photo.'); return response.blob() })
      .then(blob => { objectUrl = URL.createObjectURL(blob); setPhotoUrl(objectUrl) })
      .catch(() => {})
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [profile?.id, token, photo?.name, photo?.data, visible])
  return <div ref={holder} className="profile-avatar">{photoUrl ? <img src={photoUrl} alt={alt} loading="lazy"/> : <Package size={20}/>}</div>
}

function DocumentLinks({ attachments, profileId, token, onView }) {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const documents = [
    ['Owner photo', 'ownerPhoto', attachments?.ownerPhoto || attachments?.profilePhoto],
    ['Authorized signature', 'signature', attachments?.signature],
    ['Drug license', 'drugLicense', attachments?.drugLicense],
    ['GST copy', 'gstCopy', attachments?.gstCopy]
  ].filter(([, , file]) => file?.name && file?.type)
  if (!documents.length) return null
  const getDocumentBlob = async (file, key) => {
    if (file.data?.startsWith('data:')) return await (await fetch(file.data)).blob()
    if (!profileId || !token) throw new Error('Sign in again to view this document.')
    const response = await fetch(`${API}/profiles/${encodeURIComponent(profileId)}/documents/${key}`, { cache: 'force-cache', headers: { Authorization: `Bearer ${token}` } })
    if (!response.ok) throw new Error('Could not load this document. Please try again.')
    return response.blob()
  }
  const viewDocument = async (label, key, file) => {
    setBusy(key); setError('')
    try {
      const blob = await getDocumentBlob(file, key)
      const objectUrl = URL.createObjectURL(blob)
      onView({ ...file, label, data: objectUrl, objectUrl })
    } catch (cause) { setError(cause.message || 'Could not open this document.') }
    finally { setBusy('') }
  }
  const downloadDocument = async (label, key, file) => {
    setBusy(key); setError('')
    try {
      const blob = await getDocumentBlob(file, key)
      const objectUrl = URL.createObjectURL(blob)
      const link = document.createElement('a'); link.href = objectUrl; link.download = file.name
      document.body.appendChild(link); link.click(); link.remove()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000)
    } catch (cause) { setError(cause.message || `Could not download ${label.toLowerCase()}.`) }
    finally { setBusy('') }
  }
  return <div className="order-attachments">{documents.map(([label, key, file]) => <span className="document-actions" key={`${label}-${file.name}`}>
    <button type="button" disabled={Boolean(busy)} onClick={() => viewDocument(label, key, file)}>{busy === key ? 'Loading…' : `View ${label}`}</button>
    <button type="button" className="document-download-button" disabled={Boolean(busy)} onClick={() => downloadDocument(label, key, file)}>{busy === key ? 'Loading…' : `${label} download`}</button>
  </span>)}{error && <small className="communication-notice error" role="alert">{error}</small>}</div>
}

function maskProfileValue(value) {
  const text = String(value || '').trim()
  if (!text) return 'Not provided'
  let visibleCharacters = 4
  const characters = [...text]
  for (let index = characters.length - 1; index >= 0; index--) {
    if (!/[\p{L}\p{N}]/u.test(characters[index])) continue
    if (visibleCharacters > 0) visibleCharacters--
    else characters[index] = '*'
  }
  return characters.join('')
}

function ClientProfileDetails({ profile, token, onSaved, onViewDocument }) {
  const [editing, setEditing] = useState(false)
  useEffect(() => { setEditing(false) }, [profile.id])
  if (editing) return <div className="client-profile-edit-mode"><ProfileEditor profile={profile} token={token} onViewDocument={onViewDocument} onSaved={updated => { onSaved(updated); setEditing(false) }} onCancel={() => setEditing(false)}/></div>
  const fields = [
    ['Shop name', profile.shopName], ['Business type', profile.businessType],
    ...(profile.businessType === 'Partnership' ? [['Partner 1', profile.partnerOne], ['Partner 2', profile.partnerTwo]] : [['Shop owner', profile.ownerName]]),
    ['Email address', profile.email], ['Mobile number', profile.mobile], ['Shop address', profile.shopAddress],
    ['PIN code', profile.pincode], ['City / district', profile.city], ['State', profile.state], ['Country', profile.country],
    ['IndiaMART customer', profile.indiaMartCustomer === false ? 'No' : 'Yes'],
    ['GST number', profile.gstNumber], ['Drug license number', profile.drugLicenseNumber],
    ['Drug license expiry date', profile.drugLicenseExpiresAt]
  ]
  return <section className="client-profile-readonly" aria-label="Masked profile details">
    <div className="client-profile-readonly-heading"><div className="profile-editor-intro"><ProfileAvatar profile={profile} token={token} alt="Client profile"/><div><strong>Profile information</strong><p>Only the last four letters or digits are shown. Use Edit to view or change your details.</p></div></div><button type="button" className="button outline profile-pencil-button" aria-label="Edit profile details" title="Edit profile details" onClick={() => setEditing(true)}><Pencil size={15}/> Edit</button></div>
    <dl className="client-profile-masked-grid">{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{maskProfileValue(value)}</dd></div>)}</dl>
    {profile.profileFrozen && <div className="license-freeze-alert" role="status"><strong>Profile frozen</strong><span>{profile.drugLicenseExpiryMissing ? 'Drug license expiry is missing.' : `Drug license expired on ${profile.drugLicenseExpiresAt}.`} Contact the agency for any update that requires admin action.</span></div>}
    <DocumentLinks attachments={profile.attachments} profileId={profile.id} token={token} onView={onViewDocument}/>
  </section>
}

function DocumentPreview({ document, onClose }) {
  useEffect(() => () => { if (document.objectUrl) URL.revokeObjectURL(document.objectUrl) }, [document.objectUrl])
  const type = document.type || (document.data?.match(/^data:([^;,]+)/)?.[1] || '')
  return <div className="document-preview-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="document-preview" role="dialog" aria-modal="true" aria-labelledby="document-preview-title">
      <header><div><span className="eyebrow">CUSTOMER DOCUMENT</span><h2 id="document-preview-title">{document.label || document.name}</h2><small>{document.name}</small></div><button type="button" className="preview-close" onClick={onClose} aria-label="Close document preview"><X size={19}/></button></header>
      {type.startsWith('image/') ? <img className="document-preview-image" src={document.data} alt={document.label || document.name}/> : type === 'application/pdf' ? <iframe className="document-preview-pdf" src={document.data} title={document.label || document.name}/> : <p>This file type cannot be previewed in the browser.</p>}
      <a className="button outline" href={document.data} download={document.name}><ArrowDown size={15}/> Download file</a>
    </section>
  </div>
}

const formatMoney = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(value || 0))
const calculateClientCharges = (baseAmount, rules = []) => {
  const base = Number(baseAmount) || 0
  if (base <= 0) return []
  return rules.map(rule => ({
    ...rule,
    amount: Math.round(((rule.type === 'fixed' ? Number(rule.value) : base * Number(rule.value) / 100) + Number.EPSILON) * 100) / 100
  })).filter(item => item.amount > 0)
}
const sumClientCharges = charges => Math.round((charges.reduce((sum, item) => sum + Number(item.amount || 0), 0) + Number.EPSILON) * 100) / 100
function PaymentChargeSummary({ baseAmount, charges }) {
  const chargeTotal = sumClientCharges(charges || [])
  return <div className="client-charge-summary" aria-label="Payment charge breakdown">
    <strong>Payment summary</strong>
    <div><span>Amount before charges</span><b>{formatMoney(baseAmount)}</b></div>
    {(charges || []).map((charge, index) => <div key={charge.id || `${charge.reason}-${index}`}><span>{charge.reason} {charge.type === 'percent' ? `(${charge.value}%)` : '(fixed)'}</span><b>{formatMoney(charge.amount)}</b></div>)}
    {!chargeTotal && <div><span>Additional charges</span><b>{formatMoney(0)}</b></div>}
    <div className="client-charge-total"><span>Total to pay</span><b>{formatMoney(Number(baseAmount || 0) + chargeTotal)}</b></div>
  </div>
}
const formatTimestamp = value => new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Asia/Kolkata' })
const formatSiteTimestamp = value => new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata', timeZoneName: 'short' }).format(new Date(value))
const promoDateTimeInputValue = value => {
  if (!value || !Number.isFinite(Date.parse(value))) return ''
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value)).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}
const promoDateTimeInputToIso = value => {
  if (!value) return ''
  const date = new Date(`${value}:00+05:30`)
  return Number.isFinite(date.getTime()) ? date.toISOString() : ''
}
function getOrderCancellationDisabledReason(order, now = Date.now()) {
  if (order.status === 'Cancelled') return 'This order is already cancelled.'
  if (order.approvedAt || ['Approved', 'Rejected', 'Complete'].includes(order.status)) return 'Cancellation is closed after an order is approved or rejected.'
  if (!['In progress', 'Pending approval'].includes(order.status)) return 'Cancellation is available only while the order is in progress.'
  const createdAt = Date.parse(order.date || order.createdAt || '')
  if (!Number.isFinite(createdAt) || now >= createdAt + 24 * 60 * 60 * 1000) return 'The 24-hour cancellation period has ended.'
  return ''
}
let razorpayScriptPromise
let cashfreeScriptPromise
function loadRazorpayCheckout() {
  if (window.Razorpay) return Promise.resolve()
  if (razorpayScriptPromise) return razorpayScriptPromise
  razorpayScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://checkout.razorpay.com/v1/checkout.js'
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => { razorpayScriptPromise = null; reject(new Error('Could not load Razorpay Checkout.')) }
    document.body.appendChild(script)
  })
  return razorpayScriptPromise
}
function loadCashfreeCheckout() {
  if (window.Cashfree) return Promise.resolve()
  if (cashfreeScriptPromise) return cashfreeScriptPromise
  cashfreeScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://sdk.cashfree.com/js/v3/cashfree.js'
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => { cashfreeScriptPromise = null; reject(new Error('Could not load Cashfree Checkout.')) }
    document.body.appendChild(script)
  })
  return cashfreeScriptPromise
}

const paymentStatusLabel = payment => {
  if (payment.refundStatus === 'pending') return 'Refund processing'
  if (payment.refundStatus === 'processed') return 'Refunded'
  if (payment.refundStatus === 'partially_refunded') return 'Partially refunded'
  if (payment.refundStatus === 'failed') return 'Refund failed'
  if (payment.refundStatus === 'manual_review') return 'Agency review required'
  if (['Awaiting Razorpay payment', 'Awaiting Cashfree payment'].includes(payment.status) && Date.parse(payment.expiresAt) <= Date.now()) return 'Reconciling payment'
  return ['Razorpay payment processing', 'Cashfree payment processing'].includes(payment.status) ? 'Payment processing' : payment.status
}
const paymentAppliedAmount = payment => Number(payment?.amountApplied ?? payment?.amount ?? 0)
const paymentAllocationNote = payment => {
  if (payment?.allocationKind === 'carry-forward') return `Account credit carried from ${payment.sourceOrderId || 'another order'}.`
  const allocations = (payment?.allocations || []).filter(row => row.role === 'carry-forward')
  if (!allocations.length) return Number(payment?.amount || 0) > paymentAppliedAmount(payment) ? `Transaction total ${formatMoney(payment.amount)}; ${formatMoney(payment.unallocatedAmount)} is awaiting allocation.` : ''
  return `Transaction total ${formatMoney(payment.amount)}. Carried to ${allocations.map(row => `${row.orderId} ${formatMoney(row.amount)}`).join(', ')}.`
}

function summarizeOrderPayments(orders = []) {
  return orders.reduce((totals, order) => {
    if (order.status === 'Cancelled') return totals
    const due = Number(order.amountDue || 0)
    const paid = Number(order.amountPaid || 0)
    totals.due += due
    totals.paid += paid
    totals.outstanding += Math.max(0, due - paid)
    return totals
  }, { due: 0, paid: 0, outstanding: 0 })
}

function getDueAgeTone(order, now = Date.now()) {
  if (order.status === 'Cancelled') return ''
  const outstanding = Math.max(0, Number(order.amountDue || 0) - Number(order.amountPaid || 0))
  const placedAt = Date.parse(order.date)
  if (outstanding <= 0 || !Number.isFinite(placedAt)) return ''
  const age = now - placedAt
  if (age > 15 * 24 * 60 * 60 * 1000) return 'red'
  if (age > 7 * 24 * 60 * 60 * 1000) return 'yellow'
  return ''
}

function DueAgeIndicator({ order }) {
  const tone = getDueAgeTone(order)
  if (!tone) return null
  const label = tone === 'red' ? 'Over 15 days' : 'Over 7 days'
  return <span className={`due-age-indicator ${tone}`} title={`Outstanding balance ${label.toLowerCase()}`} aria-label={`Outstanding balance ${label.toLowerCase()}`}><i/>{label}</span>
}

function PaymentSummary({ orders, title, className = '' }) {
  const totals = summarizeOrderPayments(orders)
  const yellowCount = orders.filter(order => getDueAgeTone(order) === 'yellow').length
  const redCount = orders.filter(order => getDueAgeTone(order) === 'red').length
  return <section className={`payment-overview ${className}`}>
    {title && <h3>{title}</h3>}
    <div className="payment-overview-grid">
      <article><span>Total dues</span><strong>{formatMoney(totals.due)}</strong></article>
      <article><span>Total paid</span><strong>{formatMoney(totals.paid)}</strong></article>
      <article className="outstanding-total"><span>Outstanding balance</span><strong>{formatMoney(totals.outstanding)}</strong></article>
    </div>
    {(yellowCount > 0 || redCount > 0) && <div className="payment-aging-summary">
      <span><i className="yellow"/>{yellowCount + redCount} order{yellowCount + redCount === 1 ? '' : 's'} over 7 days</span>
      {redCount > 0 && <span><i className="red"/>{redCount} order{redCount === 1 ? '' : 's'} over 15 days</span>}
    </div>}
  </section>
}

function getOrderAvailableBalance(order) {
  const pending = (order.payments || []).filter(payment => payment.status === 'Pending verification' || ['Razorpay payment processing', 'Cashfree payment processing'].includes(payment.status) || (['Awaiting Razorpay payment', 'Awaiting Cashfree payment'].includes(payment.status) && Date.parse(payment.expiresAt) > Date.now())).reduce((sum, payment) => sum + Number(payment.amount || 0), 0)
  const balance = order.status === 'Cancelled' ? 0 : Math.max(0, Number(order.amountDue || 0) - Number(order.amountPaid || 0) - pending)
  return Math.round(balance * 100) / 100
}

function DashboardClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const time = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }).format(now)
  const date = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' }).format(now)
  return <time className="dashboard-clock" dateTime={now.toISOString()} aria-label={`India time ${time}, ${date}`}>
    <i className="dashboard-clock-live" aria-hidden="true"/>
    <span><small>INDIA TIME · IST</small><strong aria-live="off">{time}</strong><span>{date}</span></span>
  </time>
}

function indiaDateKey(value) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function indiaMonthKey(value) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).formatToParts(date).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}`
}

function getMonthlyFinanceRows(orders) {
  const todayParts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).formatToParts(new Date()).map(part => [part.type, part.value]))
  const start = new Date(Date.UTC(Number(todayParts.year), Number(todayParts.month) - 1, 1))
  const rows = Array.from({ length: 6 }, (_, index) => {
    const date = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 5 + index, 1))
    return { key: date.toISOString().slice(0, 7), label: new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', month: 'short' }).format(date), billed: 0, collected: 0, orders: 0 }
  })
  const byMonth = new Map(rows.map(row => [row.key, row]))
  for (const order of orders) {
    const placed = byMonth.get(indiaMonthKey(order.date))
    if (placed && order.status !== 'Cancelled') {
      placed.billed += Number(order.amountDue || 0)
      placed.orders++
    }
    for (const payment of order.payments || []) {
      if (!['Paid', 'Verified'].includes(payment.status)) continue
      const received = byMonth.get(indiaMonthKey(payment.paidAt || payment.reviewedAt || payment.submittedAt))
      if (!received) continue
      received.collected += Math.max(0, Number(payment.amountApplied ?? payment.amount ?? 0) - Number(payment.amountRefunded || 0))
    }
  }
  return rows
}

function MonthlyFinanceChart({ orders, audience = 'admin' }) {
  const rows = getMonthlyFinanceRows(orders)
  const maxValue = Math.max(1, ...rows.flatMap(row => [row.billed, row.collected]))
  const billedTotal = rows.reduce((total, row) => total + row.billed, 0)
  const collectedTotal = rows.reduce((total, row) => total + row.collected, 0)
  const prefix = audience === 'client' ? 'client' : 'admin'
  const paidLabel = audience === 'client' ? 'Paid' : 'Collected'
  const chartTitle = audience === 'client' ? 'Billing and payments' : 'Billing and collections'
  const totalsNote = audience === 'client' ? 'Paid totals include confirmed payments, less recorded refunds.' : 'Collections use confirmed payments, less recorded refunds.'
  return <article className={`admin-overview-chart monthly-finance-chart ${prefix}-monthly-finance-chart`}>
    <div className="admin-overview-chart-heading"><div><span className="eyebrow">LAST 6 MONTHS</span><h3>{chartTitle}</h3></div><strong>{formatMoney(collectedTotal)} {paidLabel.toLowerCase()}</strong></div>
    <div className="monthly-finance-legend"><span><i className="billed"/>Billed {formatMoney(billedTotal)}</span><span><i className="collected"/>{paidLabel} {formatMoney(collectedTotal)}</span><small>{totalsNote}</small></div>
    <div className="monthly-finance-bars" role="img" aria-label={`Six month billing and ${paidLabel.toLowerCase()} totals: ${rows.map(row => `${row.label}, billed ${formatMoney(row.billed)}, ${paidLabel.toLowerCase()} ${formatMoney(row.collected)}`).join('; ')}`}>
      {rows.map(row => <div className="monthly-finance-column" key={row.key} title={`${row.label}: billed ${formatMoney(row.billed)}, ${paidLabel.toLowerCase()} ${formatMoney(row.collected)}, ${row.orders} orders`}>
        <div className="monthly-finance-track"><i className="billed" style={{ height: `${row.billed ? Math.max(3, row.billed / maxValue * 100) : 0}%` }}/><i className="collected" style={{ height: `${row.collected ? Math.max(3, row.collected / maxValue * 100) : 0}%` }}/></div>
        <strong>{row.label}</strong><span>{row.orders} order{row.orders === 1 ? '' : 's'}</span>
      </div>)}
    </div>
  </article>
}

function ClientOverviewCharts({ orders }) {
  const statuses = [
    { label: 'In progress', color: '#a6bd84', count: orders.filter(order => ['In progress', 'Pending approval'].includes(order.status) && !order.approvedAt).length },
    { label: 'Approved', color: '#658d72', count: orders.filter(order => order.status === 'Approved' || (order.status === 'In progress' && order.approvedAt)).length },
    { label: 'Complete', color: '#49705b', count: orders.filter(order => order.status === 'Complete').length },
    { label: 'Cancelled / rejected', color: '#c9877c', count: orders.filter(order => ['Cancelled', 'Rejected'].includes(order.status)).length }
  ]
  const total = statuses.reduce((sum, row) => sum + row.count, 0)
  let cursor = 0
  const slices = statuses.filter(row => row.count > 0).map(row => {
    const from = cursor
    cursor += row.count / Math.max(total, 1) * 100
    return `${row.color} ${from}% ${cursor}%`
  })
  const statusBackground = total ? `conic-gradient(${slices.join(', ')})` : '#edf1eb'
  return <section className="client-overview-graphs" aria-label="Your order and payment charts">
    <article className="admin-overview-chart client-status-chart"><div className="admin-overview-chart-heading"><div><span className="eyebrow">ORDER SNAPSHOT</span><h3>Orders by status</h3></div><strong>{orders.length} total</strong></div>
      <div className="client-status-chart-content"><div className="client-status-donut" role="img" aria-label={`${total} orders grouped by status`} style={{ background: statusBackground }}><div><strong>{total}</strong><span>orders</span></div></div><div className="admin-payment-donut-legend">{statuses.map(row => <span key={row.label}><i style={{ background: row.color }}/>{row.label}<strong>{row.count}</strong></span>)}</div></div>
    </article>
    <MonthlyFinanceChart orders={orders} audience="client"/>
  </section>
}

function AdminOverviewCharts({ orders }) {
  const activeOrders = orders.filter(order => order.status !== 'Cancelled')
  const totals = summarizeOrderPayments(activeOrders)
  const today = indiaDateKey(Date.now())
  const [year, month, day] = today.split('-').map(Number)
  const dailySales = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(Date.UTC(year, month - 1, day - 6 + index))
    const key = date.toISOString().slice(0, 10)
    const dayOrders = orders.filter(order => order.status !== 'Cancelled' && indiaDateKey(order.date) === key)
    return { key, label: new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short' }).format(date), sales: dayOrders.reduce((sum, order) => sum + Number(order.amountDue || 0), 0), count: dayOrders.length }
  })
  const maxDailySales = Math.max(1, ...dailySales.map(item => item.sales))
  const paidPercent = totals.due > 0 ? Math.min(100, Math.max(0, totals.paid / totals.due * 100)) : 0
  const statusRows = [
    { label: 'Awaiting approval', count: orders.filter(order => ['In progress', 'Pending approval'].includes(order.status) && !order.approvedAt).length, color: '#a6bd84' },
    { label: 'Approved', count: orders.filter(order => order.status === 'Approved' || (order.status === 'In progress' && order.approvedAt)).length, color: '#658d72' },
    { label: 'Complete', count: orders.filter(order => order.status === 'Complete').length, color: '#49705b' },
    { label: 'Cancelled', count: orders.filter(order => order.status === 'Cancelled').length, color: '#c9877c' }
  ]
  const maxStatusCount = Math.max(1, ...statusRows.map(item => item.count))
  return <section className="admin-overview-graphs" aria-label="Admin dashboard charts">
    <article className="admin-overview-chart sales-seven-day-chart"><div className="admin-overview-chart-heading"><div><span className="eyebrow">LAST 7 DAYS</span><h3>Daily sales</h3></div><strong>{formatMoney(dailySales.reduce((sum, item) => sum + item.sales, 0))}</strong></div><div className="admin-daily-bars" role="img" aria-label={`Daily sales for the last seven days: ${dailySales.map(item => `${item.label} ${formatMoney(item.sales)}`).join(', ')}`}>{dailySales.map(item => <div className="admin-daily-bar-column" key={item.key}><small>{item.sales ? formatMoney(item.sales) : '₹0'}</small><div className="admin-daily-bar-track"><i style={{ height: `${item.sales ? Math.max(8, item.sales / maxDailySales * 100) : 0}%` }}/></div><strong>{item.label}</strong><span>{item.count} order{item.count === 1 ? '' : 's'}</span></div>)}</div></article>
    <article className="admin-overview-chart admin-payment-chart"><div className="admin-overview-chart-heading"><div><span className="eyebrow">COLLECTION STATUS</span><h3>Paid vs outstanding</h3></div></div><div className="admin-payment-donut-row"><div className="admin-payment-donut" role="img" aria-label={`${paidPercent.toFixed(0)} percent of recorded dues paid`} style={{ background: `conic-gradient(#5f806a 0% ${paidPercent}%, #e9eee7 ${paidPercent}% 100%)` }}><div><strong>{paidPercent.toFixed(0)}%</strong><span>paid</span></div></div><div className="admin-payment-donut-legend"><span><i className="paid"/>Paid<strong>{formatMoney(totals.paid)}</strong></span><span><i className="outstanding"/>Outstanding<strong>{formatMoney(totals.outstanding)}</strong></span><small>Across {activeOrders.length} active orders</small></div></div></article>
    <article className="admin-overview-chart admin-order-status-chart"><div className="admin-overview-chart-heading"><div><span className="eyebrow">WORK QUEUE</span><h3>Orders by status</h3></div><strong>{orders.length} total</strong></div><div className="admin-status-bars">{statusRows.map(item => <div className="admin-status-bar-row" key={item.label}><span>{item.label}</span><div><i style={{ width: `${item.count / maxStatusCount * 100}%`, backgroundColor: item.color }}/></div><strong>{item.count}</strong></div>)}</div></article>
    <MonthlyFinanceChart orders={orders}/>
  </section>
}

function StatementDownload({ profile, orders, token, admin = false }) {
  const initialRange = getStatementPeriodRange('7d')
  const [period, setPeriod] = useState('7d')
  const [fromDate, setFromDate] = useState(initialRange.start)
  const [toDate, setToDate] = useState(initialRange.end)
  const [message, setMessage] = useState('')
  const [messageIsError, setMessageIsError] = useState(false)
  const [sendingEmail, setSendingEmail] = useState(false)
  const range = period === 'custom' ? { start: fromDate, end: toDate } : getStatementPeriodRange(period)
  const invalidRange = !range.start || !range.end || range.start > range.end
  const download = () => {
    setMessage(''); setMessageIsError(false)
    if (invalidRange) { setMessage('Choose a valid start and end date.'); setMessageIsError(true); return }
    try {
      const blob = createStatementPdf({ profile, orders, fromDate: range.start, toDate: range.end })
      const link = document.createElement('a')
      const url = URL.createObjectURL(blob)
      link.href = url
      link.download = `${safeArchiveName(profile.shopName || 'Client')}-statement-${range.start}-to-${range.end}.pdf`
      document.body.appendChild(link); link.click(); link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      notifyActionSuccess('Account statement downloaded.')
    } catch (error) {
      setMessage(error.message || 'Could not create this account statement.')
      setMessageIsError(true)
    }
  }
  const emailStatement = async () => {
    setMessage(''); setMessageIsError(false)
    if (invalidRange) { setMessage('Choose a valid start and end date.'); setMessageIsError(true); return }
    setSendingEmail(true)
    try {
      const endpoint = admin
        ? `${API}/admin/profiles/${encodeURIComponent(profile.id)}/statement/email`
        : `${API}/client/statement/email`
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ fromDate: range.start, toDate: range.end })
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not email this account statement.')
      if (data.emailStatus === 'needs_configuration') {
        setMessage(`Statement saved to the email outbox for ${data.to}, but Gmail is not configured on the server yet.`)
        setMessageIsError(true)
      } else if (data.emailStatus === 'sent') {
        setMessage(`Statement PDF sent to ${data.to}.`)
      } else {
        setMessage(`Statement PDF queued for ${data.to}.`)
      }
      if (data.emailStatus !== 'needs_configuration') notifyActionSuccess('Statement email submitted successfully.')
    } catch (error) {
      setMessage(error.message || 'Could not email this account statement.')
      setMessageIsError(true)
    } finally {
      setSendingEmail(false)
    }
  }
  return <section className="statement-download">
    <div className="statement-download-heading"><div><span className="eyebrow">ACCOUNT STATEMENT</span><strong>{admin ? 'Download or email client statement' : 'Download or email your statement'}</strong></div><ArrowDown size={18}/></div>
    <div className="statement-controls">
      <label className="statement-period-field">Statement period<select value={period} onChange={event => { setPeriod(event.target.value); setMessage(''); setMessageIsError(false) }}>
        <option value="7d">Last 7 days</option>
        <option value="15d">Last 15 days</option>
        <option value="1m">Last 1 month</option>
        <option value="6m">Last 6 months</option>
        <option value="current-fy">Current financial year</option>
        <option value="last-fy">Last financial year</option>
        <option value="custom">Custom date range</option>
      </select></label>
      {period === 'custom' && <div className="statement-custom-range"><label>From<input type="date" value={fromDate} max={toDate || undefined} onChange={event => { setFromDate(event.target.value); setMessage(''); setMessageIsError(false) }} /></label><label>To<input type="date" value={toDate} min={fromDate || undefined} onChange={event => { setToDate(event.target.value); setMessage(''); setMessageIsError(false) }} /></label></div>}
      <button className="button dark statement-download-button" type="button" disabled={invalidRange} onClick={download}>Download PDF <ArrowDown size={15}/></button>
      <button className="button outline statement-email-button" type="button" disabled={invalidRange || sendingEmail} onClick={emailStatement}>{sendingEmail ? <LoadingAction loading label="Sending email…"/> : <>Email PDF <Mail size={14}/></>}</button>
    </div>
    {message && <small className={`statement-download-message ${messageIsError ? 'error' : 'success'}`} role={messageIsError ? 'alert' : 'status'}>{message}</small>}
  </section>
}

function AdminPaymentControls({ order, token, onUpdated }) {
  const [due, setDue] = useState(String(order.amountDue || 0))
  const [cost, setCost] = useState(order.costAmount === undefined ? '' : String(order.costAmount))
  const [savingDue, setSavingDue] = useState(false)
  const [savingCost, setSavingCost] = useState(false)
  const [reviewing, setReviewing] = useState('')
  const [message, setMessage] = useState('')
  const [isError, setIsError] = useState(false)
  const lockedUntil = Date.parse(order.paymentEditLockedUntil || '')
  const locked = order.status === 'Cancelled' || (Number.isFinite(lockedUntil) && lockedUntil > Date.now())
  useEffect(() => setDue(String(order.amountDue || 0)), [order.amountDue])
  useEffect(() => setCost(order.costAmount === undefined ? '' : String(order.costAmount)), [order.costAmount])
  const saveDue = async event => {
    event.preventDefault(); setSavingDue(true); setMessage(''); setIsError(false)
    try {
      const response = await fetch(`${API}/orders/${encodeURIComponent(order.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ amountDue: Number(due) }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not update this order due.')
      onUpdated(data.order); setMessage('Order due updated.'); notifyActionSuccess(`Due updated for order ${order.id}.`)
    } catch (err) { setMessage(err.message || 'Could not update this order due.'); setIsError(true) }
    finally { setSavingDue(false) }
  }
  const saveCost = async event => {
    event.preventDefault(); setSavingCost(true); setMessage(''); setIsError(false)
    try {
      const costAmount = cost.trim() === '' ? null : Number(cost)
      const response = await fetch(`${API}/orders/${encodeURIComponent(order.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ costAmount }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not update the internal order cost.')
      onUpdated(data.order); setMessage(costAmount === null ? 'Internal order cost cleared.' : 'Internal order cost saved for sales analysis.'); notifyActionSuccess(`Order cost ${costAmount === null ? 'cleared' : 'saved'} for ${order.id}.`)
    } catch (err) { setMessage(err.message || 'Could not update the internal order cost.'); setIsError(true) }
    finally { setSavingCost(false) }
  }
  const reviewPayment = async (payment, status) => {
    setReviewing(payment.id); setMessage(''); setIsError(false)
    try {
      const response = await fetch(`${API}/orders/${encodeURIComponent(order.id)}/payments/${encodeURIComponent(payment.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ status }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not review this payment.')
      onUpdated(data.order)
      if (status === 'Verified') notifyActionSuccess(`Payment confirmed for order ${order.id}.`)
    } catch (err) { setMessage(err.message || 'Could not review this payment.'); setIsError(true) }
    finally { setReviewing('') }
  }
  const retryRefund = async payment => {
    setReviewing(`refund-${payment.id}`); setMessage(''); setIsError(false)
    try {
      const response = await fetch(`${API}/orders/${encodeURIComponent(order.id)}/payments/${encodeURIComponent(payment.id)}/refund-retry`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || `Could not retry this ${payment.provider || 'online payment'} refund.`)
      onUpdated(data.order)
      setMessage(`Refund retry submitted. Current status: ${paymentStatusLabel(data.payment)}.`)
      notifyActionSuccess(`Refund retry submitted for order ${order.id}.`)
    } catch (error) { setMessage(error.message || `Could not retry this ${payment.provider || 'online payment'} refund.`); setIsError(true) }
    finally { setReviewing('') }
  }
  const balance = order.status === 'Cancelled' ? 0 : Math.max(0, Number(order.amountDue || 0) - Number(order.amountPaid || 0))
  return <section className="admin-payment-controls">
    <form className="order-due-form" onSubmit={saveDue}><label>Order due total<input type="number" min="0" max="1000000000" step="0.01" value={due} onChange={event => setDue(event.target.value)} required disabled={locked} /></label><button className="button outline" disabled={savingDue || locked}>{savingDue ? <LoadingAction loading label="Saving due…"/> : 'Update due'}</button></form>
    <form className="order-cost-form" onSubmit={saveCost}><label>Internal order cost <small>Used for profit/loss analysis; hidden from the client.</small><input type="number" min="0" max="1000000000" step="0.01" value={cost} onChange={event => setCost(event.target.value)} placeholder="Enter purchase cost" disabled={locked || savingCost}/></label><button className="button outline" disabled={savingCost || locked}>{savingCost ? <LoadingAction loading label="Saving cost…"/> : 'Save cost'}</button></form>
    <div className="payment-totals"><span>Paid: <strong>{formatMoney(order.amountPaid)}</strong></span><span>Balance: <strong>{formatMoney(balance)}</strong></span>{order.lastPaymentAt && <span>Last payment: <strong>{formatTimestamp(order.lastPaymentAt)}</strong></span>}</div>
    {order.promoApplied && <div className="admin-promo-record"><span>Promo {order.promoApplied.code}</span><span>Discount −{formatMoney(order.promoApplied.discount)}</span><span>Original total {formatMoney(order.amountDueBeforePromo)}</span></div>}
    {locked && <div className="payment-lock-note">{order.status === 'Cancelled' ? 'This cancelled order is locked. Payment history and refund status remain available below.' : `This fully paid order is locked until ${formatTimestamp(order.paymentEditLockedUntil)}. Order edits and payment review are paused during this period.`}</div>}
    {!!order.payments?.length && <div className="payment-history"><strong>Client payment records</strong>{order.payments.map(payment => <article className="payment-record" key={payment.id}><div><b>{formatMoney(payment.transactionAmount ?? payment.amount)} received{payment.provider ? ` · ${payment.provider}` : ''}</b><span>Credited to dues: {formatMoney(paymentAppliedAmount(payment))}</span>{payment.chargeBreakdown?.length > 0 && <small>Charges: {payment.chargeBreakdown.map(item => `${item.reason} ${formatMoney(item.amount)}`).join(' · ')}</small>}<span>Ref: {payment.reference || payment.razorpayOrderId || payment.cashfreePaymentId || payment.cashfreeOrderId}</span>{paymentAllocationNote(payment) && <small>{paymentAllocationNote(payment)}</small>}{payment.batchId && <small>Combined checkout allocation · {payment.batchOrderIds?.length || 2} orders</small>}<small>{payment.paidAt ? `Paid ${formatTimestamp(payment.paidAt)}` : `Submitted ${formatTimestamp(payment.submittedAt)}`} · {paymentStatusLabel(payment)}</small></div><div className="payment-review-actions">{payment.status === 'Pending verification' && <><button type="button" className="button outline" disabled={Boolean(reviewing) || locked} onClick={() => reviewPayment(payment, 'Verified')}>{reviewing === payment.id ? <LoadingAction loading label="Saving payment…"/> : 'Confirm received'}</button><button type="button" className="button outline reject-payment" disabled={Boolean(reviewing) || locked} onClick={() => reviewPayment(payment, 'Rejected')}>Mark not received</button></>}{['Paid', 'Verified'].includes(payment.status) && <button type="button" className="button outline receipt-download-button" onClick={() => downloadProtectedPdf(`${API}/admin/orders/${encodeURIComponent(order.id)}/payments/${encodeURIComponent(payment.id)}/receipt`, token).catch(error => { setMessage(error.message); setIsError(true) })}>Download receipt <ArrowDown size={13}/></button>}</div></article>)}</div>}
    {order.payments?.filter(payment => payment.refundFailureReason).map(payment => <small key={`refund-error-${payment.id}`} className="payment-failure-reason">{payment.id}: {payment.refundFailureReason}</small>)}
    {order.payments?.flatMap(payment => (payment.refunds || []).map(refund => <small key={`refund-${payment.id}-${refund.id || refund.receipt}`} className="refund-record-detail">Refund {refund.id || refund.receipt}: {formatMoney(refund.amount)} · {refund.status}</small>))}
    {order.status === 'Cancelled' && order.payments?.filter(payment => payment.status === 'Paid' && (['Razorpay', 'Cashfree'].includes(payment.provider) || (payment.provider === 'Account credit' && ['Razorpay', 'Cashfree'].includes(payment.originalProvider))) && payment.refundStatus === 'failed').map(payment => <button key={`refund-retry-${payment.id}`} type="button" className="button outline refund-retry-button" disabled={Boolean(reviewing)} onClick={() => retryRefund(payment)}>{reviewing === `refund-${payment.id}` ? <LoadingAction loading label="Retrying refund…"/> : `Retry failed ${payment.originalProvider || payment.provider} refund`}</button>)}
    {message && <small className={`payment-message ${isError ? 'error' : ''}`} role={isError ? 'alert' : 'status'}>{message}</small>}
  </section>
}

function BankTransferSettings({ token }) {
  const [details, setDetails] = useState({ accountName: '', bankName: '', accountNumber: '', ifscCode: '', branch: '', instructions: '' })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [isError, setIsError] = useState(false)
  const [ifscLookup, setIfscLookup] = useState({ ifscCode: '', status: 'idle', message: '' })
  useEffect(() => {
    let cancelled = false
    fetch(`${API}/admin/payment-settings`, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not load bank details.'); if (!cancelled) setDetails(current => ({ ...current, ...data.bankTransferDetails })) })
      .catch(error => { if (!cancelled) { setMessage(error.message || 'Could not load bank details.'); setIsError(true) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [token])
  useEffect(() => {
    const ifscCode = details.ifscCode.trim().toUpperCase()
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscCode)) {
      setIfscLookup({ ifscCode, status: 'idle', message: '' })
      return
    }
    let cancelled = false
    const controller = new AbortController()
    setIfscLookup({ ifscCode, status: 'loading', message: 'Looking up bank and branch details…' })
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`${API}/ifsc/${encodeURIComponent(ifscCode)}`, { cache: 'no-store', signal: controller.signal })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'IFSC details are unavailable. Enter the bank and branch manually.')
        if (cancelled) return
        setDetails(current => current.ifscCode.trim().toUpperCase() === ifscCode ? { ...current, bankName: data.bankName, branch: data.branch } : current)
        setIfscLookup({ ifscCode, status: 'found', message: 'Bank and branch filled from the IFSC record and locked.' })
      } catch (error) {
        if (cancelled || error.name === 'AbortError') return
        setIfscLookup({ ifscCode, status: 'manual', message: error.message || 'IFSC lookup failed. Enter the bank and branch manually.' })
      }
    }, 350)
    return () => { cancelled = true; clearTimeout(timer); controller.abort() }
  }, [details.ifscCode])
  const save = async event => {
    event.preventDefault(); setSaving(true); setMessage(''); setIsError(false)
    try {
      const response = await fetch(`${API}/admin/payment-settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ bankTransferDetails: details }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not save bank details.')
      setDetails(current => ({ ...current, ...data.bankTransferDetails })); setMessage('Bank-transfer details saved. Clients will see these details in their payment options.'); notifyActionSuccess('Bank-transfer details saved.')
    } catch (error) { setMessage(error.message || 'Could not save bank details.'); setIsError(true) }
    finally { setSaving(false) }
  }
  const update = (field, value) => setDetails(current => ({ ...current, [field]: value }))
  const branchDetailsLocked = ifscLookup.status === 'found' && ifscLookup.ifscCode === details.ifscCode.trim().toUpperCase()
  return <section className="dash-panel bank-settings-panel">
    <div className="panel-heading"><div><span className="eyebrow">PAYMENT SETTINGS</span><h2>Bank transfer details</h2><p>These details appear in client payment options.</p></div><Package size={22}/></div>
    <form className="bank-settings-form" onSubmit={save}>
      <div className="bank-settings-grid">
        <label>Account holder name<input value={details.accountName} onChange={event => update('accountName', event.target.value)} required maxLength="100" /></label>
        <label>Bank name<input value={details.bankName} onChange={event => update('bankName', event.target.value)} required maxLength="100" readOnly={branchDetailsLocked} aria-readonly={branchDetailsLocked} /></label>
        <label>Account number<input value={details.accountNumber} onChange={event => update('accountNumber', event.target.value)} required maxLength="30" /></label>
        <label>IFSC code<input value={details.ifscCode} onChange={event => update('ifscCode', event.target.value.toUpperCase())} required minLength="11" maxLength="11" /></label>
        <label>Branch <span className="optional-label">Optional</span><input value={details.branch} onChange={event => update('branch', event.target.value)} maxLength="100" readOnly={branchDetailsLocked} aria-readonly={branchDetailsLocked} /></label>
        <label className="bank-instructions-field">Transfer instructions <span className="optional-label">Optional</span><textarea value={details.instructions} onChange={event => update('instructions', event.target.value)} rows="2" maxLength="500" placeholder="Add any transfer reference instructions for clients." /></label>
      </div>
      {ifscLookup.message && <small className={`ifsc-lookup-message ${ifscLookup.status === 'manual' ? 'manual' : ''}`} role="status">{ifscLookup.message}</small>}
      <button className="button dark" disabled={saving || loading}>{loading || saving ? <LoadingAction loading label={loading ? 'Loading bank details…' : 'Saving bank details…'}/> : <>Save bank details <ArrowUpRight size={15}/></>}</button>
      {message && <small className={`payment-message ${isError ? 'error' : ''}`} role={isError ? 'alert' : 'status'}>{message}</small>}
    </form>
  </section>
}

function PromoCodeSettings({ token }) {
  const [settings, setSettings] = useState({ enabled: false, code: '', discountType: 'percent', discountValue: '', emoji: '🎉', startsAt: '', endsAt: '' })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [isError, setIsError] = useState(false)
  useEffect(() => {
    let cancelled = false
    fetch(`${API}/admin/promo-code-settings`, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } })
      .then(async response => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Could not load promo-code settings.')
        if (!cancelled) setSettings({ ...data.promoCodeSettings, discountValue: data.promoCodeSettings?.discountValue ? String(data.promoCodeSettings.discountValue) : '', startsAt: promoDateTimeInputValue(data.promoCodeSettings?.startsAt), endsAt: promoDateTimeInputValue(data.promoCodeSettings?.endsAt) })
      })
      .catch(error => { if (!cancelled) { setMessage(error.message || 'Could not load promo-code settings.'); setIsError(true) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [token])
  const update = (field, value) => setSettings(current => ({ ...current, [field]: value }))
  const save = async event => {
    event.preventDefault(); setSaving(true); setMessage(''); setIsError(false)
    try {
      if (Boolean(settings.startsAt) !== Boolean(settings.endsAt)) throw new Error('Set both the offer start and end date/time, or leave both blank.')
      const startsAt = promoDateTimeInputToIso(settings.startsAt)
      const endsAt = promoDateTimeInputToIso(settings.endsAt)
      if (settings.startsAt && (!startsAt || !endsAt || Date.parse(endsAt) <= Date.parse(startsAt))) throw new Error('Choose a valid offer window and make the end date/time later than the start.')
      const response = await fetch(`${API}/admin/promo-code-settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ promoCodeSettings: { ...settings, discountValue: Number(settings.discountValue), startsAt, endsAt } }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not save promo-code settings.')
      setSettings({ ...data.promoCodeSettings, discountValue: data.promoCodeSettings.discountValue ? String(data.promoCodeSettings.discountValue) : '', startsAt: promoDateTimeInputValue(data.promoCodeSettings.startsAt), endsAt: promoDateTimeInputValue(data.promoCodeSettings.endsAt) })
      setMessage(!data.promoCodeSettings.enabled ? 'Promo code is turned off.' : data.promoCodeSettings.startsAt ? `Promo code ${data.promoCodeSettings.code} is scheduled for ${formatTimestamp(data.promoCodeSettings.startsAt)} to ${formatTimestamp(data.promoCodeSettings.endsAt)} IST.` : `Promo code ${data.promoCodeSettings.code} is live on client dashboards.`)
      notifyActionSuccess(!data.promoCodeSettings.enabled ? 'Promo code turned off.' : 'Promo offer schedule saved.')
    } catch (error) { setMessage(error.message || 'Could not save promo-code settings.'); setIsError(true) }
    finally { setSaving(false) }
  }
  return <section className="dash-panel promo-code-settings-panel">
    <div className="panel-heading"><div><span className="eyebrow">CLIENT PAYMENT OFFERS</span><h2>Promo code and discount</h2><p>Schedule when the offer appears to clients. The discount is applied to the outstanding balance.</p></div><Sparkles size={22}/></div>
    <form className="bank-settings-form" onSubmit={save}>
      <div className="due-reminder-toggle-row"><div><strong>Promo code visibility</strong><span>{settings.enabled ? 'On · clients can use this offer' : 'Off · hidden from client dashboards'}</span></div><button type="button" className={`professional-switch${settings.enabled ? ' is-on' : ''}`} role="switch" aria-checked={settings.enabled} aria-label="Show promo code to clients" disabled={loading || saving} onClick={() => { update('enabled', !settings.enabled); setMessage(''); setIsError(false) }}><i/></button></div>
      <div className="bank-settings-grid">
        <label>Promo code<input value={settings.code} onChange={event => update('code', event.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24))} placeholder="For example, GOURI10" maxLength="24" disabled={loading || saving}/><small>3–24 letters, numbers, hyphens, or underscores.</small></label>
        <label>Offer emoji<select value={settings.emoji} onChange={event => update('emoji', event.target.value)} disabled={loading || saving}><option value="🎉">🎉 Celebration</option><option value="💊">💊 Healthcare</option><option value="✨">✨ Special offer</option><option value="🏷️">🏷️ Discount</option></select></label>
        <label>Discount type<select value={settings.discountType} onChange={event => update('discountType', event.target.value)} disabled={loading || saving}><option value="percent">Percentage off</option><option value="fixed">Fixed amount off</option></select></label>
        <label>{settings.discountType === 'percent' ? 'Discount percentage' : 'Discount amount (₹)'}<input type="number" min="0.01" max={settings.discountType === 'percent' ? '100' : '1000000000'} step="0.01" value={settings.discountValue} onChange={event => update('discountValue', event.target.value)} placeholder={settings.discountType === 'percent' ? '10' : '100'} required={settings.enabled} disabled={loading || saving}/></label>
        <label>Offer starts (IST)<input type="datetime-local" value={settings.startsAt || ''} onChange={event => update('startsAt', event.target.value)} disabled={loading || saving}/></label>
        <label>Offer ends (IST)<input type="datetime-local" value={settings.endsAt || ''} onChange={event => update('endsAt', event.target.value)} disabled={loading || saving}/></label>
      </div>
      <p className="promo-code-admin-help">Set both dates and times to schedule the offer. It becomes visible and applicable automatically at the start time, and disappears when it ends. Leave both blank to make it available immediately until switched off. Times use India Standard Time (IST).</p>
      <p className="promo-code-admin-help">Clients enter the code on an order’s payment section. The reduction is saved to that order, its balance, and latest PDF. An applied discount remains on the order if you later turn the offer off.</p>
      <button className="button dark" type="submit" disabled={loading || saving}>{loading || saving ? <LoadingAction loading label={loading ? 'Loading promo settings…' : 'Saving promo settings…'}/> : <>Save promo offer <Check size={15}/></>}</button>
      {message && <small className={`payment-message ${isError ? 'error' : ''}`} role={isError ? 'alert' : 'status'}>{message}</small>}
    </form>
  </section>
}

function PaymentChargeSettings({ token }) {
  const [settings, setSettings] = useState({ enabled: false, scheduleEnabled: false, startsAt: '', endsAt: '', items: [] })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [isError, setIsError] = useState(false)
  useEffect(() => {
    let cancelled = false
    fetch(`${API}/admin/payment-charge-settings`, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } })
      .then(async response => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Could not load payment charges.')
        const saved = data.paymentChargeSettings || {}
        if (!cancelled) setSettings({ enabled: Boolean(saved.enabled), scheduleEnabled: Boolean(saved.scheduleEnabled), startsAt: promoDateTimeInputValue(saved.startsAt), endsAt: promoDateTimeInputValue(saved.endsAt), items: (saved.items || []).map(item => ({ ...item, value: String(item.value) })) })
      })
      .catch(error => { if (!cancelled) { setMessage(error.message || 'Could not load payment charges.'); setIsError(true) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [token])
  const update = (key, value) => setSettings(current => ({ ...current, [key]: value }))
  const updateItem = (id, key, value) => setSettings(current => ({ ...current, items: current.items.map(item => item.id === id ? { ...item, [key]: value } : item) }))
  const addItem = () => setSettings(current => ({ ...current, items: [...current.items, { id: globalThis.crypto?.randomUUID?.() || `charge-${Date.now()}-${Math.random().toString(16).slice(2)}`, reason: '', type: 'fixed', value: '' }] }))
  const removeItem = id => setSettings(current => ({ ...current, items: current.items.filter(item => item.id !== id) }))
  const save = async event => {
    event.preventDefault(); setSaving(true); setMessage(''); setIsError(false)
    try {
      if (settings.scheduleEnabled && (!settings.startsAt || !settings.endsAt)) throw new Error('Enter both the scheduled start and end date/time.')
      const startsAt = promoDateTimeInputToIso(settings.startsAt)
      const endsAt = promoDateTimeInputToIso(settings.endsAt)
      if (settings.scheduleEnabled && (!startsAt || !endsAt || Date.parse(endsAt) <= Date.parse(startsAt))) throw new Error('Choose a valid schedule and make the end date/time later than the start.')
      const items = settings.items.filter(item => item.reason.trim() || String(item.value).trim()).map(item => ({ ...item, reason: item.reason.trim(), value: Number(item.value) }))
      const response = await fetch(`${API}/admin/payment-charge-settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ paymentChargeSettings: { ...settings, startsAt, endsAt, items } }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not save payment charges.')
      const saved = data.paymentChargeSettings
      setSettings({ ...saved, startsAt: promoDateTimeInputValue(saved.startsAt), endsAt: promoDateTimeInputValue(saved.endsAt), items: (saved.items || []).map(item => ({ ...item, value: String(item.value) })) })
      setMessage(!saved.enabled ? 'Payment charges are switched off.' : saved.scheduleEnabled ? `Charges are scheduled from ${formatTimestamp(saved.startsAt)} to ${formatTimestamp(saved.endsAt)} IST.` : 'Payment charges are active for client payments.')
      notifyActionSuccess(!saved.enabled ? 'Payment charges switched off.' : 'Payment charge settings saved.')
    } catch (error) { setMessage(error.message || 'Could not save payment charges.'); setIsError(true) }
    finally { setSaving(false) }
  }
  return <section className="dash-panel payment-charge-settings-panel">
    <div className="panel-heading"><div><span className="eyebrow">CLIENT PAYMENT CHECKOUT</span><h2>Payment charges</h2><p>Add clear line items to client payments. Clients see the charge breakdown and total before continuing to checkout.</p></div><Package size={22}/></div>
    <form className="payment-charge-form" onSubmit={save}>
      <div className="due-reminder-toggle-row"><div><strong>Apply payment charges</strong><span>{settings.enabled ? 'On · active rules are included at checkout' : 'Off · no additional charges are applied'}</span></div><button type="button" className={`professional-switch${settings.enabled ? ' is-on' : ''}`} role="switch" aria-checked={settings.enabled} aria-label="Apply payment charges" disabled={loading || saving} onClick={() => update('enabled', !settings.enabled)}><i/></button></div>
      <div className="payment-charge-toolbar"><div><strong>Charge rows</strong><small>Each row needs a reason and a rupee amount or percentage.</small></div><button className="button outline" type="button" onClick={addItem} disabled={loading || saving || settings.items.length >= 100}>Add charge row <Plus size={14}/></button></div>
      {settings.items.length > 0 ? <div className="payment-charge-table"><div className="payment-charge-table-head"><span>Charge reason</span><span>Charge type</span><span>Amount / rate</span><span>Action</span></div>{settings.items.map(item => <div className="payment-charge-row" key={item.id}><label><span className="sr-only">Charge reason</span><input value={item.reason} onChange={event => updateItem(item.id, 'reason', event.target.value)} placeholder="For example, handling charge" maxLength="100" disabled={loading || saving}/></label><label><span className="sr-only">Charge type</span><select value={item.type} onChange={event => updateItem(item.id, 'type', event.target.value)} disabled={loading || saving}><option value="fixed">Fixed amount (₹)</option><option value="percent">Percentage (%)</option></select></label><label><span className="sr-only">Charge amount or percentage</span><input type="number" min="0.01" max={item.type === 'percent' ? '100' : '1000000000'} step="0.01" value={item.value} onChange={event => updateItem(item.id, 'value', event.target.value)} placeholder={item.type === 'percent' ? '5' : '50'} disabled={loading || saving}/></label><button type="button" className="button outline payment-charge-remove" onClick={() => removeItem(item.id)} disabled={loading || saving}>Remove</button></div>)}</div> : <p className="payment-charge-empty">No charge rows have been added.</p>}
      <div className="due-reminder-toggle-row payment-charge-schedule-toggle"><div><strong>Schedule charges</strong><span>{settings.scheduleEnabled ? 'Charges apply only during the selected date and time window' : 'When enabled above, charges apply immediately until switched off'}</span></div><button type="button" className={`professional-switch${settings.scheduleEnabled ? ' is-on' : ''}`} role="switch" aria-checked={settings.scheduleEnabled} aria-label="Schedule payment charges" disabled={loading || saving} onClick={() => update('scheduleEnabled', !settings.scheduleEnabled)}><i/></button></div>
      {settings.scheduleEnabled && <div className="payment-charge-schedule"><label>Starts at (IST)<input type="datetime-local" value={settings.startsAt} onChange={event => update('startsAt', event.target.value)} disabled={loading || saving} required/></label><label>Ends at (IST)<input type="datetime-local" value={settings.endsAt} onChange={event => update('endsAt', event.target.value)} disabled={loading || saving} required/></label></div>}
      <p className="payment-charge-help">Charge rules are calculated from the amount the client chooses to pay. Percentage charges are based on that amount; a fixed charge is added once per checkout. For combined bills, charges are allocated across the selected orders in the payment records. Charges are not credited as order dues.</p>
      <button className="button dark" type="submit" disabled={loading || saving}>{loading || saving ? <LoadingAction loading label={loading ? 'Loading charge settings…' : 'Saving charge settings…'}/> : <>Save charge settings <Check size={15}/></>}</button>
      {message && <small className={`payment-message ${isError ? 'error' : ''}`} role={isError ? 'alert' : 'status'}>{message}</small>}
    </form>
  </section>
}

function DueReminderSettings({ token }) {
  const [enabled, setEnabled] = useState(true)
  const [intervalDays, setIntervalDays] = useState('7')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [isError, setIsError] = useState(false)
  useEffect(() => {
    let cancelled = false
    fetch(`${API}/admin/payment-settings`, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } })
      .then(async response => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Could not load reminder settings.')
        if (!cancelled) {
          setEnabled(data.dueReminderSettings?.enabled !== false)
          setIntervalDays(String(data.dueReminderSettings?.intervalDays || 7))
        }
      })
      .catch(error => { if (!cancelled) { setMessage(error.message || 'Could not load reminder settings.'); setIsError(true) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [token])
  const save = async event => {
    event.preventDefault()
    const days = Number(intervalDays)
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      setMessage('Set a reminder interval from 1 to 365 days.')
      setIsError(true)
      return
    }
    setSaving(true); setMessage(''); setIsError(false)
    try {
      const response = await fetch(`${API}/admin/due-reminder-settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ enabled, intervalDays: days })
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not save reminder settings.')
      setEnabled(data.dueReminderSettings.enabled)
      setIntervalDays(String(data.dueReminderSettings.intervalDays))
      setMessage(data.dueReminderSettings.enabled
        ? `Outstanding-balance reminder emails are on and scheduled every ${data.dueReminderSettings.intervalDays} day${data.dueReminderSettings.intervalDays === 1 ? '' : 's'}.`
        : 'Outstanding-balance reminder emails are off.')
      notifyActionSuccess('Reminder email settings saved.')
    } catch (error) {
      setMessage(error.message || 'Could not save reminder settings.')
      setIsError(true)
    } finally { setSaving(false) }
  }
  return <section className="dash-panel due-reminder-settings">
    <div className="panel-heading"><div><span className="eyebrow">EMAIL NOTIFICATIONS</span><h2>Outstanding-balance reminders</h2><p>Reminders go only to clients with a remaining balance and stop when all dues are cleared.</p></div><Mail size={22}/></div>
    <form className="due-reminder-form" onSubmit={save}>
      <div className="due-reminder-toggle-row"><div><strong>Automatic reminder emails</strong><span>{enabled ? 'Enabled' : 'Disabled'}</span></div><button type="button" className={`professional-switch${enabled ? ' is-on' : ''}`} role="switch" aria-checked={enabled} aria-label="Automatic outstanding-balance reminder emails" disabled={loading || saving} onClick={() => { setEnabled(value => !value); setMessage(''); setIsError(false) }}><i/></button></div>
      <label className="reminder-interval-field">Days between reminders<input type="number" min="1" max="365" step="1" value={intervalDays} disabled={loading || saving} onChange={event => { setIntervalDays(event.target.value); setMessage(''); setIsError(false) }}/></label>
      <p className="due-reminder-help">A reminder is sent after the selected interval, then repeated at that interval while the client still has an outstanding balance. Paid and deleted orders are excluded.</p>
      <button className="button dark" type="submit" disabled={loading || saving}>{loading || saving ? <LoadingAction loading label={loading ? 'Loading settings…' : 'Saving settings…'}/> : <>Save reminder settings <Check size={15}/></>}</button>
      {message && <small className={`payment-message ${isError ? 'error' : ''}`} role={isError ? 'alert' : 'status'}>{message}</small>}
    </form>
  </section>
}

function OrderIntakeSettings({ token, onUpdated }) {
  const [enabled, setEnabled] = useState(true)
  const [closedMessage, setClosedMessage] = useState('Order requests are temporarily closed. Please contact Gouri Agency for assistance.')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [isError, setIsError] = useState(false)
  useEffect(() => {
    let cancelled = false
    fetch(`${API}/admin/order-intake-settings`, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } })
      .then(async response => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Could not load order intake settings.')
        if (!cancelled) {
          setEnabled(data.orderIntakeSettings?.enabled !== false)
          setClosedMessage(data.orderIntakeSettings?.message || 'Order requests are temporarily closed. Please contact Gouri Agency for assistance.')
        }
      })
      .catch(error => { if (!cancelled) { setMessage(error.message || 'Could not load order intake settings.'); setIsError(true) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [token])
  const save = async event => {
    event.preventDefault()
    setSaving(true); setMessage(''); setIsError(false)
    try {
      const response = await fetch(`${API}/admin/order-intake-settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ enabled, message: closedMessage })
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not save order intake settings.')
      const saved = data.orderIntakeSettings
      setEnabled(saved.enabled)
      setClosedMessage(saved.message)
      onUpdated?.(saved)
      setMessage(saved.enabled ? 'Order requests are open and ready to receive.' : 'Order requests are closed. The red notice is now shown on the order form.')
      notifyActionSuccess('Order intake settings saved.')
    } catch (error) {
      setMessage(error.message || 'Could not save order intake settings.')
      setIsError(true)
    } finally { setSaving(false) }
  }
  return <section className="dash-panel order-intake-settings">
    <div className="panel-heading"><div><span className="eyebrow">ORDER REQUESTS</span><h2>Order form availability</h2><p>Control whether new orders can be submitted from the portal.</p></div><Package size={22}/></div>
    <form className="due-reminder-form" onSubmit={save}>
      <div className="due-reminder-toggle-row"><div><strong>Accept new client orders</strong><span>{enabled ? 'Open · clients can submit orders' : 'Closed · client submissions are blocked'}</span></div><button type="button" className={`professional-switch${enabled ? ' is-on' : ''}`} role="switch" aria-checked={enabled} aria-label="Accept new client orders" disabled={loading || saving} onClick={() => { setEnabled(value => !value); setMessage(''); setIsError(false) }}><i/></button></div>
      <label className="order-intake-message-field">Closed order form notice<textarea rows="3" maxLength="300" value={closedMessage} disabled={loading || saving} onChange={event => { setClosedMessage(event.target.value); setMessage(''); setIsError(false) }}/></label>
      <p className="due-reminder-help">When closed, clients see this notice highlighted in red and cannot submit the form. Reopen order intake here to resume submissions.</p>
      <button className="button dark" type="submit" disabled={loading || saving}>{loading || saving ? <LoadingAction loading label={loading ? 'Loading order settings…' : 'Saving order settings…'}/> : <>Save order form settings <Check size={15}/></>}</button>
      {message && <small className={`payment-message ${isError ? 'error' : ''}`} role={isError ? 'alert' : 'status'}>{message}</small>}
    </form>
  </section>
}

function EmailDeliverySettings({ token }) {
  const [settings, setSettings] = useState({ fromName: 'Gouri Agency', fromAddress: 'donotreplygouriagencymailbox@gmail.com' })
  const [allowedFromAddresses, setAllowedFromAddresses] = useState([])
  const [ccText, setCcText] = useState('upadhyayjagneswar@gmail.com\ndbachchu@gmail.com')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [isError, setIsError] = useState(false)
  useEffect(() => {
    let cancelled = false
    fetch(`${API}/admin/email-settings`, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } })
      .then(async response => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Could not load email settings.')
        if (!cancelled) {
          setSettings(data.emailSettings)
          setAllowedFromAddresses(data.allowedFromAddresses || [])
          setCcText((data.emailSettings?.ccEmails || []).join('\n'))
        }
      })
      .catch(error => { if (!cancelled) { setMessage(error.message || 'Could not load email settings.'); setIsError(true) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [token])
  const save = async event => {
    event.preventDefault()
    const ccEmails = ccText.split(/[\n,;]+/).map(address => address.trim()).filter(Boolean)
    if (ccEmails.length > 20 || ccEmails.some(address => !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(address))) {
      setMessage('Enter up to 20 valid CC email addresses. Separate addresses with a comma or a new line.')
      setIsError(true)
      return
    }
    setSaving(true); setMessage(''); setIsError(false)
    try {
      const response = await fetch(`${API}/admin/email-settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...settings, ccEmails })
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not save email settings.')
      setSettings(data.emailSettings)
      setAllowedFromAddresses(data.allowedFromAddresses || [])
      setCcText((data.emailSettings.ccEmails || []).join('\n'))
      setMessage('Email sender and CC settings saved. They apply to all new and queued emails.')
      notifyActionSuccess('Email sender and CC settings saved.')
    } catch (error) {
      setMessage(error.message || 'Could not save email settings.')
      setIsError(true)
    } finally { setSaving(false) }
  }
  return <section className="dash-panel email-delivery-settings">
    <div className="panel-heading"><div><span className="eyebrow">EMAIL DELIVERY</span><h2>Sender and CC recipients</h2><p>All automated email notifications use this sender and copy the listed addresses.</p></div><Mail size={22}/></div>
    <form className="email-delivery-form" onSubmit={save}>
      <div className="email-delivery-grid">
        <label>Sender display name<input type="text" maxLength="80" value={settings.fromName} disabled={loading || saving} onChange={event => { setSettings(current => ({ ...current, fromName: event.target.value })); setMessage(''); setIsError(false) }} required /></label>
        <label>From email address<input type="email" list="gouri-authorized-senders" value={settings.fromAddress} disabled={loading || saving} onChange={event => { setSettings(current => ({ ...current, fromAddress: event.target.value })); setMessage(''); setIsError(false) }} required /><datalist id="gouri-authorized-senders">{allowedFromAddresses.map(address => <option key={address} value={address}/>)}</datalist></label>
        <label className="email-cc-field">CC email addresses<textarea rows="3" value={ccText} disabled={loading || saving} onChange={event => { setCcText(event.target.value); setMessage(''); setIsError(false) }} placeholder="team@example.com, accounts@example.com"/><small>Separate addresses with commas or new lines. Up to 20 addresses.</small></label>
      </div>
      <p className="email-delivery-help">The From address must be the authenticated Gmail mailbox or a verified Gmail “Send mail as” alias authorized on the server. To add a new sender, configure the alias in Gmail and add it to <code>GMAIL_ALLOWED_FROM_ADDRESSES</code>.</p>
      <button className="button dark" type="submit" disabled={loading || saving}>{loading || saving ? <LoadingAction loading label={loading ? 'Loading email settings…' : 'Saving email settings…'}/> : <>Save email settings <Check size={15}/></>}</button>
      {message && <small className={`payment-message ${isError ? 'error' : ''}`} role={isError ? 'alert' : 'status'}>{message}</small>}
    </form>
  </section>
}

function CommunicationsPanel({ token, role, profiles = [], profile = null }) {
  const isAdmin = role === 'admin'
  const [search, setSearch] = useState('')
  const [selectedProfileId, setSelectedProfileId] = useState('')
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [notice, setNotice] = useState('')
  const [isError, setIsError] = useState(false)
  const [downloading, setDownloading] = useState('')
  const conversationProfileId = isAdmin ? selectedProfileId : profile?.id || ''
  const selectedProfile = isAdmin ? profiles.find(item => item.id === selectedProfileId) : profile
  const matchingProfiles = isAdmin && search.trim() ? profiles.filter(item => [item.shopName, item.gstNumber, item.email, item.mobile].some(value => String(value || '').toLowerCase().includes(search.trim().toLowerCase()))).slice(0, 30) : []

  useEffect(() => {
    let cancelled = false
    if (!conversationProfileId) { setMessages([]); setLoading(false); return () => { cancelled = true } }
    let firstLoad = true
    let requestActive = false
    const loadMessages = async () => {
      if (requestActive || document.visibilityState === 'hidden') return
      requestActive = true
      if (!cancelled && firstLoad) setLoading(true)
      try {
        const path = isAdmin ? `${API}/admin/messages?profileId=${encodeURIComponent(conversationProfileId)}` : `${API}/client/messages`
        const response = await fetch(path, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Could not load this message thread.')
        if (!cancelled) { setMessages(data.messages || []); setNotice(''); setIsError(false) }
      } catch (error) {
        if (!cancelled) { setNotice(error.message || 'Could not load this message thread.'); setIsError(true) }
      } finally {
        requestActive = false
        if (!cancelled && firstLoad) { setLoading(false); firstLoad = false }
      }
    }
    loadMessages()
    const timer = window.setInterval(loadMessages, 12_000)
    const refreshWhenVisible = () => { if (document.visibilityState === 'visible') loadMessages() }
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => { cancelled = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', refreshWhenVisible) }
  }, [conversationProfileId, isAdmin, token])

  const send = async event => {
    event.preventDefault()
    if (isAdmin && !selectedProfile) { setNotice('Choose a registered client before sending.'); setIsError(true); return }
    const form = event.currentTarget
    setSending(true); setNotice(''); setIsError(false)
    try {
      const file = form.elements.attachment.files?.[0]
      const attachment = file ? await encodeUpload(file, 'Attachment', ['application/pdf', 'image/jpeg', 'image/png']) : null
      const payload = { subject, body, ...(isAdmin ? { profileId: selectedProfile.id } : {}), attachment }
      const path = isAdmin ? `${API}/admin/messages` : `${API}/client/messages`
      const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not send this message.')
      setMessages(current => [...current.filter(item => item.id !== data.message.id), data.message].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)))
      setSubject(''); setBody(''); form.reset()
      const delivery = data.message.deliveryStatus
      setNotice(delivery === 'needs_configuration' ? 'Message saved to this conversation, but outgoing email is not configured.' : 'Message saved in the conversation and queued for email delivery.')
      notifyActionSuccess(isAdmin ? `Message queued for ${selectedProfile.email}.` : 'Message sent to Gouri Agency and saved in your portal thread.')
    } catch (error) { setNotice(error.message || 'Could not send this message.'); setIsError(true) }
    finally { setSending(false) }
  }

  const downloadAttachment = async message => {
    setDownloading(message.id); setNotice(''); setIsError(false)
    try {
      const endpoint = isAdmin ? 'admin' : 'client'
      const response = await fetch(`${API}/${endpoint}/messages/${encodeURIComponent(message.id)}/attachment`, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } })
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || 'Could not download this attachment.') }
      const blob = await response.blob()
      const fileName = /filename="([^"]+)"/i.exec(response.headers.get('content-disposition') || '')?.[1] || message.attachment?.filename || 'message-document'
      const objectUrl = URL.createObjectURL(blob)
      const link = document.createElement('a'); link.href = objectUrl; link.download = fileName
      document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(objectUrl), 2000)
    } catch (error) { setNotice(error.message || 'Could not download this attachment.'); setIsError(true) }
    finally { setDownloading('') }
  }

  const deliveryLabel = status => ({ sent: 'Email sent', pending: 'Email queued', retry: 'Retrying email', failed: 'Email failed', needs_configuration: 'Email setup needed', saved: 'Saved in portal' }[status] || status || 'Saved in portal')
  return <section className="dash-panel communications-panel">
    <div className="panel-heading"><div><span className="eyebrow">PORTAL COMMUNICATIONS</span><h2>{isAdmin ? 'Client email inbox' : 'Messages to Gouri Agency'}</h2><p>{isAdmin ? 'Find a registered client and send a message or document to their profile email.' : 'Send a message to Gouri Agency. Your registered email, mobile, and GST details are included for reference.'}</p></div><Mail size={22}/></div>
    {isAdmin && <div className="communication-client-picker"><label className="profile-search-field"><span>Find a client by shop, GST, registered email, or mobile</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search GST, email, or mobile number"/></label>
      {matchingProfiles.length > 0 && <div className="communication-client-results">{matchingProfiles.map(item => <button type="button" key={item.id} className={`communication-client-result${selectedProfileId === item.id ? ' selected' : ''}`} onClick={() => { setSelectedProfileId(item.id); setSearch(''); setNotice(''); setIsError(false) }}><strong>{item.shopName}</strong><span>{item.gstNumber} · {item.email} · {item.mobile}</span></button>)}</div>}
      {search.trim() && matchingProfiles.length === 0 && <small className="communication-muted">No registered clients match this search.</small>}
      {selectedProfile && <div className="communication-selected-client"><div><small>RECIPIENT</small><strong>{selectedProfile.shopName}</strong><span>{selectedProfile.email}</span></div><button type="button" className="button outline" onClick={() => { setSelectedProfileId(''); setMessages([]) }}>Change client</button></div>}
    </div>}
    {!isAdmin && <div className="communication-recipient-note"><strong>To</strong><span>gouriagency185@gmail.com</span><strong>CC</strong><span>upadhyayjagneswar@gmail.com</span></div>}
    {conversationProfileId && <div className="communication-thread" aria-live="polite">
      <div className="communication-thread-heading"><strong>Conversation</strong><small>{loading ? 'Refreshing…' : `${messages.length} message${messages.length === 1 ? '' : 's'}`}</small></div>
      {!loading && messages.length === 0 && <p className="communication-empty">No messages yet. Send the first message below.</p>}
      {messages.map(message => <article className={`communication-message${message.senderRole === role ? ' own-message' : ''}`} key={message.id}>
        <div className="communication-message-heading"><div><strong>{message.senderName || (message.senderRole === 'admin' ? 'Gouri Agency' : selectedProfile?.shopName || 'Client')}</strong><small>{message.senderEmail}</small></div><time>{formatTimestamp(message.createdAt)}</time></div>
        <h3>{message.subject}</h3><p>{message.body}</p>
        {message.attachment && <button type="button" className="communication-attachment" disabled={downloading === message.id} onClick={() => downloadAttachment(message)}><ArrowDown size={14}/>{downloading === message.id ? 'Downloading…' : message.attachment.filename}</button>}
        <small className={`communication-delivery delivery-${String(message.deliveryStatus || '').replace(/[^a-z_]+/g, '-')}`}>{deliveryLabel(message.deliveryStatus)}</small>
      </article>)}
    </div>}
    {(isAdmin ? selectedProfile : profile) && <form className="communication-compose" onSubmit={send}>
      <h3>{isAdmin ? `Send to ${selectedProfile.email}` : 'Write a message'}</h3>
      <label>Subject<input type="text" maxLength="180" value={subject} onChange={event => setSubject(event.target.value)} placeholder="Enter the email subject" required disabled={sending}/></label>
      <label>Message<textarea rows="6" maxLength="12000" value={body} onChange={event => setBody(event.target.value)} placeholder="Write your message" required disabled={sending}/></label>
      <label className="communication-upload">Attach a document <span className="optional-label">Optional · PDF, JPG, or PNG · max 5 MB</span><input name="attachment" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" disabled={sending}/></label>
      <button type="submit" className="button dark" disabled={sending || !subject.trim() || !body.trim()}>{sending ? <LoadingAction loading label="Sending message…"/> : <>Send email and save conversation <ArrowUpRight size={15}/></>}</button>
    </form>}
    {isAdmin && !selectedProfile && <p className="communication-empty">Search for and select a registered client to open their conversation and compose an email.</p>}
    {!isAdmin && !profile && <p className="communication-empty">A registered client profile is required to use portal messages.</p>}
    {notice && <small className={`communication-notice${isError ? ' error' : ''}`} role={isError ? 'alert' : 'status'}>{notice}</small>}
  </section>
}

function AdminAccessSettings({ token }) {
  const [loginId, setLoginId] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [isError, setIsError] = useState(false)
  useEffect(() => {
    let cancelled = false
    fetch(`${API}/admin/access-settings`, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } })
      .then(async response => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Could not load admin access settings.')
        if (!cancelled) setLoginId(data.adminLoginId || '')
      })
      .catch(error => { if (!cancelled) { setMessage(error.message || 'Could not load admin access settings.'); setIsError(true) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [token])
  const save = async event => {
    event.preventDefault()
    if (!currentPassword) { setMessage('Enter your current password to confirm this change.'); setIsError(true); return }
    if (newPassword && newPassword.length < 12) { setMessage('Choose a new password with at least 12 characters.'); setIsError(true); return }
    if (newPassword !== confirmPassword) { setMessage('The new password and confirmation do not match.'); setIsError(true); return }
    setSaving(true); setMessage(''); setIsError(false)
    try {
      const response = await fetch(`${API}/admin/access-settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ loginId, currentPassword, newPassword, confirmPassword })
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not update admin access.')
      setLoginId(data.adminLoginId)
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('')
      setMessage('Admin login details updated. Other admin sessions have been signed out.'); notifyActionSuccess('Admin login details updated.')
    } catch (error) {
      setMessage(error.message || 'Could not update admin access.')
      setIsError(true)
    } finally { setSaving(false) }
  }
  return <section className="dash-panel admin-access-settings">
    <div className="panel-heading"><div><span className="eyebrow">ADMIN SECURITY</span><h2>Admin login details</h2><p>Change the admin login ID or password. Your current password confirms the change.</p></div><ShieldCheck size={22}/></div>
    <form className="admin-access-form" onSubmit={save}>
      <div className="admin-access-grid">
        <label>Admin login ID<input type="email" autoComplete="username" value={loginId} disabled={loading || saving} onChange={event => { setLoginId(event.target.value); setMessage(''); setIsError(false) }} required /></label>
        <label>Current password<input type="password" autoComplete="current-password" value={currentPassword} disabled={loading || saving} onChange={event => { setCurrentPassword(event.target.value); setMessage(''); setIsError(false) }} required /></label>
        <label>New password <span className="optional-label">Optional</span><input type="password" autoComplete="new-password" minLength="12" maxLength="128" value={newPassword} disabled={loading || saving} onChange={event => { setNewPassword(event.target.value); setMessage(''); setIsError(false) }} placeholder="At least 12 characters" /></label>
        <label>Confirm new password<input type="password" autoComplete="new-password" minLength="12" maxLength="128" value={confirmPassword} disabled={loading || saving} onChange={event => { setConfirmPassword(event.target.value); setMessage(''); setIsError(false) }} placeholder="Repeat the new password" /></label>
      </div>
      <p className="admin-access-help">Leave both new-password fields blank to change only the login ID. Other signed-in admin sessions are signed out after a successful update.</p>
      <button className="button dark" type="submit" disabled={loading || saving}>{loading || saving ? <LoadingAction loading label={loading ? 'Loading admin settings…' : 'Saving admin settings…'}/> : <>Update admin login <Check size={15}/></>}</button>
      {message && <small className={`payment-message ${isError ? 'error' : ''}`} role={isError ? 'alert' : 'status'}>{message}</small>}
    </form>
  </section>
}

function AdminNotices({ token }) {
  const [notices, setNotices] = useState([])
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [priority, setPriority] = useState('standard')
  const [scheduleEnabled, setScheduleEnabled] = useState(false)
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [startTime, setStartTime] = useState('')
  const [endTime, setEndTime] = useState('')
  const [editingId, setEditingId] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState('')
  const [downloadingId, setDownloadingId] = useState('')
  const [message, setMessage] = useState('')
  const [isError, setIsError] = useState(false)
  const formRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    fetch(`${API}/admin/notices`, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } })
      .then(async response => {
        const data = await readApiJson(response, 'Could not load saved notices.')
        if (!response.ok) throw new Error(data.error || 'Could not load saved notices.')
        if (!cancelled) setNotices(Array.isArray(data.notices) ? data.notices : [])
      })
      .catch(error => { if (!cancelled) { setMessage(error.message || 'Could not load saved notices.'); setIsError(true) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [token])

  const resetForm = () => {
    setTitle(''); setBody(''); setPriority('standard'); setScheduleEnabled(false)
    setStartDate(''); setEndDate(''); setStartTime(''); setEndTime(''); setEditingId('')
  }
  const edit = notice => {
    setTitle(notice.title || '')
    setBody(notice.body || '')
    setPriority(notice.priority === 'high' ? 'high' : 'standard')
    setScheduleEnabled(notice.scheduleEnabled === true)
    setStartDate(notice.startDate || '')
    setEndDate(notice.endDate || '')
    setStartTime(notice.startTime || '')
    setEndTime(notice.endTime || '')
    setEditingId(notice.id)
    setMessage('Editing this saved notice. Update its details or schedule, then save.')
    setIsError(false)
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const save = async event => {
    event.preventDefault()
    if (scheduleEnabled && Boolean(startTime) !== Boolean(endTime)) {
      setMessage('Enter both daily times, or leave both blank for all-day visibility.')
      setIsError(true)
      return
    }
    setSaving(true); setMessage(''); setIsError(false)
    const wasEditing = Boolean(editingId)
    const payload = {
      title, body, priority, scheduleEnabled,
      startDate: scheduleEnabled ? startDate : '',
      endDate: scheduleEnabled ? endDate : '',
      startTime: scheduleEnabled ? startTime : '',
      endTime: scheduleEnabled ? endTime : ''
    }
    try {
      const response = await fetch(`${API}/admin/notices${wasEditing ? `/${encodeURIComponent(editingId)}` : ''}`, {
        method: wasEditing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload)
      })
      const data = await readApiJson(response, wasEditing ? 'Could not update this notice.' : 'Could not publish this notice.')
      if (!response.ok) throw new Error(data.error || (wasEditing ? 'Could not update this notice.' : 'Could not publish this notice.'))
      setNotices(Array.isArray(data.notices) ? data.notices : wasEditing
        ? notices.map(item => item.id === data.notice?.id ? data.notice : item)
        : [data.notice, ...notices])
      resetForm()
      const success = wasEditing ? 'Notice updated and its schedule saved.' : 'Notice published on the home page.'
      setMessage(success); notifyActionSuccess(success)
    } catch (error) {
      setMessage(error.message || (wasEditing ? 'Could not update this notice.' : 'Could not publish this notice.'))
      setIsError(true)
    } finally { setSaving(false) }
  }
  const remove = async notice => {
    if (!window.confirm(`Delete the notice "${notice.title}" from the home page?`)) return
    setDeletingId(notice.id); setMessage(''); setIsError(false)
    try {
      const response = await fetch(`${API}/admin/notices/${encodeURIComponent(notice.id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      const data = await readApiJson(response, 'Could not delete this notice.')
      if (!response.ok) throw new Error(data.error || 'Could not delete this notice.')
      setNotices(Array.isArray(data.notices) ? data.notices : notices.filter(item => item.id !== notice.id))
      if (editingId === notice.id) resetForm()
      setMessage('Notice deleted from the home page.'); notifyActionSuccess('Notice deleted from the home page.')
    } catch (error) {
      setMessage(error.message || 'Could not delete this notice.')
      setIsError(true)
    } finally { setDeletingId('') }
  }
  const download = async notice => {
    setDownloadingId(notice.id); setMessage(''); setIsError(false)
    try { await downloadNoticePdf(notice) }
    catch (error) { setMessage(error.message || 'Could not create the notice PDF.'); setIsError(true) }
    finally { setDownloadingId('') }
  }
  return <section className="dash-panel admin-notices-panel">
    <div className="panel-heading"><div><span className="eyebrow">HOME PAGE CONTENT</span><h2>Notice board</h2><p>Publish important updates for visitors. The newest notice appears first and scrolls upward on the home page.</p></div><span className="admin-notice-count">{notices.length} saved</span></div>
    <form className="admin-notice-form" ref={formRef} onSubmit={save}>
      <div className="admin-notice-form-title"><strong>{editingId ? 'Edit notice' : 'Create a notice'}</strong>{editingId && <button className="button outline compact" type="button" disabled={saving} onClick={() => { resetForm(); setMessage('Edit cancelled.'); setIsError(false) }}>Cancel edit</button>}</div>
      <label>Notice heading<input type="text" maxLength={120} required value={title} disabled={saving} onChange={event => { setTitle(event.target.value); setMessage(''); setIsError(false) }} placeholder="Short, clear announcement"/></label>
      <label>Notice message<textarea maxLength={15000} rows={5} required value={body} disabled={saving} onChange={event => { setBody(event.target.value); setMessage(''); setIsError(false) }} placeholder="Write the complete notice for customers and visitors."/></label>
      <label className="admin-notice-priority"><input type="checkbox" checked={priority === 'high'} disabled={saving} onChange={event => setPriority(event.target.checked ? 'high' : 'standard')}/><span><strong>High priority alert</strong><small>Show a blinking alert mark beside this notice.</small></span></label>
      <label className="admin-notice-schedule-toggle"><input type="checkbox" checked={scheduleEnabled} disabled={saving} onChange={event => setScheduleEnabled(event.target.checked)}/><span><strong>Schedule this notice</strong><small>Choose a date range and/or daily hours. Leave both blank to show it every day, all day.</small></span></label>
      {scheduleEnabled && <div className="admin-notice-schedule-fields">
        <div className="admin-notice-schedule-group"><div><strong>Optional date range</strong><small>Leave either date blank for an open-ended schedule.</small></div><div className="admin-notice-schedule-inputs"><label>Start date<input type="date" value={startDate} max={endDate || undefined} disabled={saving} onChange={event => setStartDate(event.target.value)}/></label><label>End date<input type="date" value={endDate} min={startDate || undefined} disabled={saving} onChange={event => setEndDate(event.target.value)}/></label></div></div>
        <div className="admin-notice-schedule-group"><div><strong>Optional daily hours (IST)</strong><small>Set both times to limit visibility each day. Leave blank for all-day visibility.</small></div><div className="admin-notice-schedule-inputs"><label>Visible from<input type="time" value={startTime} disabled={saving} onChange={event => setStartTime(event.target.value)}/></label><label>Visible until<input type="time" value={endTime} disabled={saving} onChange={event => setEndTime(event.target.value)}/></label></div></div>
      </div>}
      <div className="admin-notice-form-footer"><small>{body.length}/15000 characters</small><button className="button dark" type="submit" disabled={saving || loading}>{saving ? <LoadingAction loading label={editingId ? 'Saving notice…' : 'Publishing notice…'}/>: editingId ? <>Save changes <Check size={15}/></> : <>Publish notice <Plus size={15}/></>}</button></div>
      {message && <p className={`admin-notice-feedback${isError ? ' is-error' : ''}`} role={isError ? 'alert' : 'status'}>{message}</p>}
    </form>
    <div className="admin-notice-list-heading"><h3>Published notices</h3><span>{notices.length}</span></div>
    {loading ? <p className="admin-notice-empty">Loading saved notices…</p> : notices.length ? <div className="admin-notice-list">{notices.map((notice, index) => <article className={`admin-notice-row${notice.priority === 'high' ? ' is-high-priority' : ''}`} key={notice.id}>
      <div className="admin-notice-row-copy"><div><strong>{notice.title}</strong>{notice.priority === 'high' && <span className="admin-notice-priority-pill"><i>!</i> High priority</span>}</div><p>{notice.body}</p><time dateTime={notice.createdAt}>{new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(notice.createdAt))} IST{index === 0 ? ' · Latest' : ''}</time><small className="admin-notice-schedule-summary">{noticeScheduleSummary(notice)}</small></div>
      <div className="admin-notice-row-actions"><button type="button" className="button outline" disabled={saving || downloadingId === notice.id || deletingId === notice.id} onClick={() => edit(notice)}><Pencil size={13}/> Edit</button><button type="button" className="button outline" disabled={downloadingId === notice.id || deletingId === notice.id} onClick={() => download(notice)}>{downloadingId === notice.id ? <LoadingAction loading label="Preparing PDF…"/> : <>Download PDF <ArrowDown size={14}/></>}</button><button type="button" className="button danger compact" disabled={deletingId === notice.id || downloadingId === notice.id} onClick={() => remove(notice)}>{deletingId === notice.id ? <LoadingAction loading label="Deleting…"/> : 'Delete notice'}</button></div>
    </article>)}</div> : <div className="admin-notice-empty">No notices have been published yet.</div>}
  </section>
}
function HomeSliderSettings({ token }) {
  const [settings, setSettings] = useState({ enabled: true, intervalSeconds: '10', images: Array(6).fill(null) })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [isError, setIsError] = useState(false)
  const fileInputs = useRef([])
  useEffect(() => {
    let cancelled = false
    fetch(`${API}/admin/home-slider`, { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } })
      .then(async response => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Could not load home slider settings.')
        if (cancelled) return
        const saved = data.homeSlider || {}
        setSettings({
          enabled: saved.enabled !== false,
          intervalSeconds: String(saved.intervalSeconds || 10),
          images: Array.from({ length: 6 }, (_, index) => saved.images?.[index] || null)
        })
      })
      .catch(error => { if (!cancelled) { setMessage(error.message || 'Could not load home slider settings.'); setIsError(true) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [token])
  const selectImage = async (index, file) => {
    if (!file) return
    setMessage(''); setIsError(false)
    try {
      const image = await encodeUpload(file, `Slide ${index + 1}`, ['image/jpeg', 'image/png'], MAX_HOME_SLIDER_IMAGE_BYTES)
      setSettings(current => ({ ...current, images: current.images.map((item, slot) => slot === index ? image : item) }))
    } catch (error) {
      setMessage(error.message || `Could not load slide ${index + 1}.`); setIsError(true)
      if (fileInputs.current[index]) fileInputs.current[index].value = ''
    }
  }
  const removeImage = index => {
    setSettings(current => ({ ...current, images: current.images.map((item, slot) => slot === index ? null : item) }))
    if (fileInputs.current[index]) fileInputs.current[index].value = ''
    setMessage(''); setIsError(false)
  }
  const save = async event => {
    event.preventDefault()
    const intervalSeconds = Number(settings.intervalSeconds)
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < 3 || intervalSeconds > 120) {
      setMessage('Set the image interval from 3 to 120 seconds.')
      setIsError(true)
      return
    }
    setSaving(true); setMessage(''); setIsError(false)
    try {
      const response = await fetch(`${API}/admin/home-slider`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          enabled: settings.enabled,
          intervalSeconds,
          images: settings.images.map(image => image?.data ? image : image?.id ? { id: image.id } : null)
        })
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not save home slider settings.')
      const saved = data.homeSlider
      setSettings({ enabled: saved.enabled, intervalSeconds: String(saved.intervalSeconds), images: saved.images })
      setMessage('Home page images and automation settings saved.'); notifyActionSuccess('Home page slider settings saved.')
    } catch (error) {
      setMessage(error.message || 'Could not save home slider settings.')
      setIsError(true)
    } finally { setSaving(false) }
  }
  return <section className="dash-panel home-slider-settings">
    <div className="panel-heading"><div><span className="eyebrow">HOME PAGE AUTOMATION</span><h2>Image slider</h2><p>Manage six homepage image slots and set how often the slideshow advances.</p></div><Package size={22}/></div>
    <form className="home-slider-settings-form" onSubmit={save}>
      <div className="due-reminder-toggle-row"><div><strong>Automatic home image slider</strong><span>{settings.enabled ? 'Enabled' : 'Disabled'}</span></div><button type="button" className={`professional-switch${settings.enabled ? ' is-on' : ''}`} role="switch" aria-checked={settings.enabled} aria-label="Automatic home image slider" disabled={loading || saving} onClick={() => { setSettings(current => ({ ...current, enabled: !current.enabled })); setMessage(''); setIsError(false) }}><i/></button></div>
      <label className="home-slider-interval-field">Change image every (seconds)<input type="number" min="3" max="120" step="1" required value={settings.intervalSeconds} disabled={loading || saving} onChange={event => { setSettings(current => ({ ...current, intervalSeconds: event.target.value })); setMessage(''); setIsError(false) }}/></label>
      <div className="home-slider-slots">{settings.images.map((image, index) => <article className="home-slider-slot" key={index}>
        <div className="home-slider-slot-heading"><strong>Image {String(index + 1).padStart(2, '0')}</strong><span>{image ? 'Ready' : 'Empty'}</span></div>
        <div className="home-slider-slot-preview">{image ? <img src={image.data || image.url} alt={image.name || `Home page image ${index + 1} preview`}/> : <span>Choose a JPG or PNG image</span>}</div>
        <label className="home-slider-file-label">{image ? 'Replace image' : 'Upload image'}<input ref={element => { fileInputs.current[index] = element }} type="file" accept=".jpg,.jpeg,.png,image/jpeg,image/png" disabled={loading || saving} onChange={event => selectImage(index, event.target.files?.[0])}/></label>
        {image && <button type="button" className="home-slider-remove" disabled={loading || saving} onClick={() => removeImage(index)}>Remove image</button>}
      </article>)}</div>
      <p className="home-slider-help">Use JPG or PNG files, up to 2 MB each. The slideshow cycles through uploaded images and keeps the selected interval between 3 and 120 seconds.</p>
      <button className="button dark" type="submit" disabled={loading || saving}>{loading || saving ? <LoadingAction label={loading ? 'Loading slider settings…' : 'Saving slider settings…'}/> : <>Save image settings <Check size={15}/></>}</button>
      {message && <small className={`payment-message ${isError ? 'error' : ''}`} role={isError ? 'alert' : 'status'}>{message}</small>}
    </form>
  </section>
}

function ClientPaymentOrder({ order, profileOrders = [], razorpayKeyId, cashfreeEnabled, cashfreeEnvironment, bankTransferDetails, promoCode, paymentCharges = [], token, onUpdated, onPaymentSuccess, currentTime }) {
  const [amount, setAmount] = useState('')
  const [promoInput, setPromoInput] = useState('')
  const [promoBusy, setPromoBusy] = useState(false)
  const [reference, setReference] = useState('')
  const [bankRail, setBankRail] = useState('NEFT')
  const [paymentMode, setPaymentMode] = useState('full')
  const [paymentMethod, setPaymentMethod] = useState(razorpayKeyId ? 'razorpay' : cashfreeEnabled ? 'cashfree' : 'bank')
  const [paymentOptionsOpen, setPaymentOptionsOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [cancelBusy, setCancelBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [isError, setIsError] = useState(false)
  const cancelled = order.status === 'Cancelled'
  const visibleStatus = ['Rejected', 'Cancelled'].includes(order.status) ? order.status : order.approvedAt || order.status === 'Approved' ? 'Approved' : ['In progress', 'Pending approval'].includes(order.status) ? 'In progress' : order.status
  const visibleStatusClass = String(visibleStatus || 'unknown').toLowerCase().replace(/[^a-z]+/g, '-')
  const cancelDisabledReason = getOrderCancellationDisabledReason(order, currentTime)
  const balance = cancelled ? 0 : Math.max(0, Number(order.amountDue || 0) - Number(order.amountPaid || 0))
  const paymentHistory = (order.payments || []).filter(payment => ['Paid', 'Verified'].includes(payment.status) && !payment.refundStatus && !(payment.refunds || []).length)
  const pending = (order.payments || []).filter(payment => payment.status === 'Pending verification' || ['Razorpay payment processing', 'Cashfree payment processing'].includes(payment.status) || (['Awaiting Razorpay payment', 'Awaiting Cashfree payment'].includes(payment.status) && Date.parse(payment.expiresAt) > Date.now())).reduce((sum, payment) => sum + payment.amount, 0)
  const payable = Math.max(0, balance - pending)
  const chargeBreakdown = calculateClientCharges(Number(amount) || 0, paymentCharges)
  const chargeTotal = sumClientCharges(chargeBreakdown)
  const transactionTotal = Math.round(((Number(amount) || 0) + chargeTotal) * 100) / 100
  const profilePayable = profileOrders.filter(item => !['Cancelled', 'Rejected'].includes(item.status)).reduce((sum, item) => {
    const reserved = (item.payments || []).filter(payment => payment.status === 'Pending verification' || ['Razorpay payment processing', 'Cashfree payment processing'].includes(payment.status) || (['Awaiting Razorpay payment', 'Awaiting Cashfree payment'].includes(payment.status) && Date.parse(payment.expiresAt) > Date.now())).reduce((total, payment) => total + Number(payment.amount || 0), 0)
    return sum + Math.max(0, Number(item.amountDue || 0) - Number(item.amountPaid || 0) - reserved)
  }, 0)
  useEffect(() => { if (paymentMode === 'full') setAmount(payable ? payable.toFixed(2) : '') }, [order.id, payable, paymentMode])
  useEffect(() => { if (!razorpayKeyId && !cashfreeEnabled) setPaymentMethod('bank'); else if (!razorpayKeyId && cashfreeEnabled) setPaymentMethod('cashfree') }, [razorpayKeyId, cashfreeEnabled])
  useEffect(() => { if (!order.promoApplied && promoCode?.code) setPromoInput(promoCode.code) }, [order.id, order.promoApplied?.code, promoCode?.code])
  const applyPromo = async event => {
    event.preventDefault(); setPromoBusy(true); setMessage(''); setIsError(false)
    try {
      const response = await fetch(`${API}/client/orders/${encodeURIComponent(order.id)}/promo`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ code: promoInput }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not apply this promo code.')
      onUpdated(data.order)
      setMessage(`Promo code ${data.promoApplied.code} applied. ${formatMoney(data.promoApplied.discount)} was deducted from this order.`)
      setIsError(false)
      notifyActionSuccess(`Promo code applied to order ${order.id}; ${formatMoney(data.promoApplied.discount)} discount.`)
    } catch (error) { setMessage(error.message || 'Could not apply this promo code.'); setIsError(true) }
    finally { setPromoBusy(false) }
  }
  const removePromo = async () => {
    setPromoBusy(true); setMessage(''); setIsError(false)
    try {
      const response = await fetch(`${API}/client/orders/${encodeURIComponent(order.id)}/promo`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not remove this promo code.')
      onUpdated(data.order)
      setMessage(`Promo code removed. The original order total is restored to ${formatMoney(data.order.amountDue)}.`)
      notifyActionSuccess(`Promo code removed from order ${order.id}; original total restored.`)
    } catch (error) { setMessage(error.message || 'Could not remove this promo code.'); setIsError(true) }
    finally { setPromoBusy(false) }
  }
  const reconcileCheckout = async razorpayOrderId => {
    const response = await fetch(`${API}/client/orders/${encodeURIComponent(order.id)}/payments/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ razorpayOrderId })
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Could not reconcile this Razorpay payment.')
    onUpdated(data.order)
    if (data.payment?.status === 'Paid') {
      setMessage('Payment received and reconciled successfully.')
      setIsError(false)
      if (data.refundSummary) setMessage(`Payment was received after cancellation. ${data.refundSummary}`)
      else onPaymentSuccess({ order: data.order, payment: data.payment, emailStatus: data.emailStatus })
    } else if (data.payment?.status === 'Failed') {
      setMessage(data.payment.failureReason || 'Razorpay did not receive this payment. You can retry from this page.')
      setIsError(true)
    } else {
      setMessage('Razorpay is still confirming this payment. Your balance will update as soon as it is verified.')
      setIsError(false)
    }
    return data
  }
  const reconcileCashfreeCheckout = async cashfreeOrderId => {
    const response = await fetch(`${API}/client/orders/${encodeURIComponent(order.id)}/cashfree-reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ cashfreeOrderId })
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Could not reconcile this Cashfree payment.')
    onUpdated(data.order)
    if (data.payment?.status === 'Paid') {
      if (data.refundSummary) { setMessage(`Payment was received after cancellation. ${data.refundSummary}`); setIsError(false) }
      else onPaymentSuccess({ order: data.order, payment: data.payment, emailStatus: data.emailStatus })
    } else if (data.payment?.status === 'Failed') {
      setMessage(data.payment.failureReason || 'Cashfree did not receive this payment. You can retry from this page.')
      setIsError(true)
    } else {
      setMessage('Cashfree is still confirming this payment. Your balance will update as soon as it is verified.')
      setIsError(false)
    }
    return data
  }
  const cancelOrder = async () => {
    const confirmed = window.confirm(`Cancel order ${order.id}? Any confirmed Razorpay or Cashfree payment will be submitted for an automatic refund. Refund timing depends on the payment provider and bank.`)
    if (!confirmed) return
    setCancelBusy(true); setMessage(''); setIsError(false)
    try {
      const response = await fetch(`${API}/client/orders/${encodeURIComponent(order.id)}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not cancel this order.')
      onUpdated(data.order)
      setPaymentOptionsOpen(false)
      setMessage(data.refundSummary || 'Order cancelled.')
      notifyActionSuccess(`Order ${order.id} cancelled. ${data.refundSummary || ''}`.trim())
    } catch (error) { setMessage(error.message || 'Could not cancel this order.'); setIsError(true) }
    finally { setCancelBusy(false) }
  }
  const startRazorpayCheckout = async () => {
    setBusy(true); setMessage(''); setIsError(false)
    try {
      const response = await fetch(`${API}/client/orders/${encodeURIComponent(order.id)}/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ amount: Number(amount) }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not start Razorpay Checkout.')
      onUpdated(data.order)
      await loadRazorpayCheckout()
      const checkout = new window.Razorpay({
        key: data.keyId,
        amount: data.amount,
        currency: data.currency,
        name: 'Gouri Agency',
        description: `Order ${order.id} due payment`,
        order_id: data.razorpayOrderId,
        prefill: { name: order.ownerName || order.shopName, email: order.email, contact: order.mobile },
        theme: { color: '#415c50' },
        handler: async result => {
          try {
            const verifyResponse = await fetch(`${API}/client/orders/${encodeURIComponent(order.id)}/payments/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(result) })
            const verified = await verifyResponse.json()
            if (!verifyResponse.ok) {
              if (verified.order) onUpdated(verified.order)
              if (verified.payment?.status === 'Failed') {
                setMessage(verified.payment.failureReason || verified.error || 'Razorpay marked this attempt as failed. You can retry the payment.')
                setIsError(true); setBusy(false); return
              }
              const reconciled = await reconcileCheckout(data.razorpayOrderId)
              if (reconciled.payment?.status !== 'Paid') { setBusy(false); return }
              setBusy(false); return
            }
            onUpdated(verified.order)
            setBusy(false)
            if (verified.refundSummary) setMessage(`Payment was received after cancellation. ${verified.refundSummary}`)
            else onPaymentSuccess({ order: verified.order, payment: verified.payment, emailStatus: verified.emailStatus })
          } catch (err) { setMessage(err.message || 'Payment verification is still pending. Refresh this page shortly.'); setIsError(true); setBusy(false) }
        },
        modal: { ondismiss: async () => {
          try { await reconcileCheckout(data.razorpayOrderId) }
          catch (error) { setMessage(error.message || 'Checkout closed. We are still checking the payment status.'); setIsError(false) }
          finally { setBusy(false) }
        } }
      })
      checkout.on('payment.failed', async failure => {
        setBusy(true)
        try { await reconcileCheckout(data.razorpayOrderId) }
        catch (error) { setMessage(failure.error?.description || error.message || 'Payment status is still being reconciled.'); setIsError(true) }
        finally { setBusy(false) }
      })
      checkout.open()
    } catch (err) { setMessage(err.message || 'Could not start Razorpay Checkout.'); setIsError(true); setBusy(false) }
  }
  const startCashfreeCheckout = async () => {
    setBusy(true); setMessage(''); setIsError(false)
    try {
      const response = await fetch(`${API}/client/orders/${encodeURIComponent(order.id)}/cashfree-checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ amount: Number(amount) }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not start Cashfree Checkout.')
      onUpdated(data.order)
      await loadCashfreeCheckout()
      const cashfree = window.Cashfree({ mode: data.environment || cashfreeEnvironment || 'production' })
      const result = await cashfree.checkout({ paymentSessionId: data.paymentSessionId, redirectTarget: '_modal' })
      if (result?.redirect) {
        setMessage('Cashfree is redirecting you to complete payment. Your order will update when Cashfree confirms the result.')
        setIsError(false)
        setBusy(false)
        return
      }
      await reconcileCashfreeCheckout(data.cashfreeOrderId)
      setBusy(false)
    } catch (err) {
      setMessage(err.message || 'Could not start Cashfree Checkout.')
      setIsError(true)
      setBusy(false)
    }
  }
  const submitReference = async event => {
    event.preventDefault(); setBusy(true); setMessage(''); setIsError(false)
    try {
      const response = await fetch(`${API}/client/orders/${encodeURIComponent(order.id)}/payments`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ amount: Number(amount), reference, provider: bankRail }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not submit this payment reference.')
      onUpdated(data.order); setReference(''); setPaymentOptionsOpen(false); setMessage('Bank transfer submitted. Your balance will update after Gouri Agency confirms receipt.'); notifyActionSuccess(`Transfer reference submitted for order ${order.id}.`)
    } catch (err) { setMessage(err.message || 'Could not submit this payment reference.'); setIsError(true) }
    finally { setBusy(false) }
  }
  return <article className={`client-payment-order${cancelled ? ' cancelled' : ''}`}>
    <div className="client-order-actions"><button className="button outline cancel-order-button" type="button" disabled={cancelBusy || busy || Boolean(cancelDisabledReason)} title={cancelDisabledReason || undefined} aria-describedby={cancelDisabledReason ? `cancel-locked-${order.id}` : undefined} onClick={cancelOrder}>{cancelled ? 'Order cancelled' : cancelBusy ? <LoadingAction loading label="Cancelling order…"/> : 'Cancel order'}</button>{cancelDisabledReason && !cancelled && <small id={`cancel-locked-${order.id}`} className="cancel-order-locked-note">{cancelDisabledReason}</small>}</div>
    {cancelled && <div className="cancelled-order-note"><strong>Order cancelled</strong><span>{(order.payments || []).some(payment => payment.refundStatus === 'failed') ? 'A refund needs agency review.' : (order.payments || []).some(payment => payment.refundStatus === 'manual_review') ? 'Account credit needs agency review for manual refund or future bill adjustment.' : (order.payments || []).some(payment => payment.refundStatus === 'pending') ? `${order.payments.find(payment => payment.refundStatus === 'pending')?.originalProvider || order.payments.find(payment => payment.refundStatus === 'pending')?.provider || 'The payment provider'} is processing the refund. The status will update automatically.` : (order.payments || []).some(payment => payment.creditMovedAmount > 0) ? `Carry-forward credit was moved to ${(order.payments.find(payment => payment.creditMovedAmount > 0)?.creditMovedTo || []).map(row => row.orderId).join(', ')}.` : (order.payments || []).some(payment => ['processed', 'partially_refunded'].includes(payment.refundStatus)) ? `${order.payments.find(payment => ['processed', 'partially_refunded'].includes(payment.refundStatus))?.originalProvider || order.payments.find(payment => ['processed', 'partially_refunded'].includes(payment.refundStatus))?.provider || 'The payment provider'} has processed the refund.` : 'No successful payment was recorded for this order.'}</span></div>}
    <div className="client-payment-heading"><div><span className="order-title"><strong>{order.id}</strong><DueAgeIndicator order={order}/></span><span className="client-order-status-line"><span className={`order-status-badge client-order-status status-${visibleStatusClass}`}>{visibleStatus}</span><small>Placed {formatTimestamp(order.date)}</small></span></div><span>{formatMoney(balance)} outstanding</span></div>
    {order.promoApplied && <div className="order-promo-breakdown"><span>Order total before promo <strong>{formatMoney(order.amountDueBeforePromo)}</strong></span><span>{order.promoApplied.emoji || '🎉'} Promo code {order.promoApplied.code} <strong className="promo-discount-value">−{formatMoney(order.promoApplied.discount)}</strong></span><span>Amount due after discount <strong>{formatMoney(order.amountDue)}</strong></span>{!cancelled && <button type="button" className="text-button promo-remove-button" onClick={removePromo} disabled={promoBusy || busy || pending > 0} title={pending > 0 ? 'Wait for pending payments to finish before removing this promo code.' : undefined}>{promoBusy ? <LoadingAction loading label="Removing…"/> : 'Remove code'}</button>}</div>}
    <div className="client-payment-summary"><span>{order.promoApplied ? 'Total after discount' : 'Total'}: {formatMoney(order.amountDue)}</span><span>Paid: {formatMoney(order.amountPaid)}</span>{pending > 0 && <span>Awaiting confirmation: {formatMoney(pending)}</span>}{order.lastPaymentAt && <span>Last payment: {formatTimestamp(order.lastPaymentAt)}</span>}</div>
    {!cancelled && payable > 0 && <div className="client-pay-area payment-choice-area">
      {order.promoApplied ? <div className="promo-applied-notice"><span>{order.promoApplied.emoji || '🎉'}</span><div><strong>Discount applied</strong><small>{order.promoApplied.code} reduced this order by {formatMoney(order.promoApplied.discount)}.</small></div></div> : promoCode?.enabled && promoCode.code && pending <= 0 && <form className="client-promo-apply" onSubmit={applyPromo}><div className="client-promo-offer"><span>{promoCode.emoji || '🎉'}</span><div><strong>{promoCode.discountType === 'percent' ? `${promoCode.discountValue}% off` : `${formatMoney(promoCode.discountValue)} off`}</strong><small>Use {promoCode.code} on this order</small></div></div><div className="client-promo-entry"><input aria-label="Promo code" autoCapitalize="characters" value={promoInput} onChange={event => setPromoInput(event.target.value.toUpperCase())} placeholder="Enter promo code" maxLength="24"/><button type="submit" className="button outline" disabled={promoBusy || busy || !promoInput.trim()}>{promoBusy ? <LoadingAction loading label="Applying…"/> : 'Apply code'}</button></div></form>}
      <div className="pay-now-bar"><div><strong>Payment due now: {formatMoney(payable)}</strong><small>You can pay the full balance or make a partial payment.</small></div><button type="button" className="button dark" disabled={busy} onClick={() => setPaymentOptionsOpen(open => !open)}>{paymentOptionsOpen ? 'Close payment options' : 'Pay now'} <ArrowUpRight size={15}/></button></div>
      {paymentOptionsOpen && <div className="payment-options-panel">
        <div className="payment-mode-options"><label><input type="radio" name={`payment-mode-${order.id}`} checked={paymentMode === 'full'} onChange={() => setPaymentMode('full')} /><span>Pay full outstanding <strong>{formatMoney(payable)}</strong></span></label><label><input type="radio" name={`payment-mode-${order.id}`} checked={paymentMode === 'partial'} onChange={() => { setPaymentMode('partial'); setAmount('') }} /><span>Pay a partial amount</span></label></div>
        {paymentMode === 'partial' && <label className="partial-payment-amount">Payment amount<input type="number" min={razorpayKeyId ? '1.00' : '0.01'} max={profilePayable.toFixed(2)} step="0.01" value={amount} onChange={event => setAmount(event.target.value)} placeholder="Enter amount" required /><small>You can pay up to {formatMoney(profilePayable)} across this profile. Any amount above this bill will be credited to the next open bill and listed in your statement and receipt.</small></label>}
        <div className="payment-method-options">
          <button type="button" className={`payment-method-card${paymentMethod === 'razorpay' ? ' selected' : ''}`} aria-pressed={paymentMethod === 'razorpay'} onClick={() => setPaymentMethod('razorpay')}><img src="https://razorpay.com/build/browser/static/static/razorpay-logo.svg" alt="Razorpay"/><small>Pay securely online</small></button>
          <button type="button" className={`payment-method-card${paymentMethod === 'cashfree' ? ' selected' : ''}`} aria-pressed={paymentMethod === 'cashfree'} onClick={() => setPaymentMethod('cashfree')}><img className="cashfree-payment-logo" src="https://cashfreelogo.cashfree.com/website/landings/homepage/cashfreeLogo.png" alt="Cashfree Payments"/><small>Pay securely online</small></button>
          <button type="button" className={`payment-method-card${paymentMethod === 'bank' ? ' selected' : ''}`} aria-pressed={paymentMethod === 'bank'} onClick={() => setPaymentMethod('bank')}><strong>IMPS · NEFT · RTGS</strong><small>Bank transfer, confirmed by Gouri Agency</small></button>
        </div>
        <PaymentChargeSummary baseAmount={Number(amount) || 0} charges={chargeBreakdown}/>
        {paymentMethod === 'razorpay' && <div className="razorpay-payment-action">{razorpayKeyId ? <button className="button dark" type="button" onClick={startRazorpayCheckout} disabled={busy || !Number(amount) || Number(amount) < 1 || Number(amount) > profilePayable}>{busy ? <LoadingAction loading label="Opening checkout…"/> : <>Continue to Razorpay · {formatMoney(transactionTotal)} <ArrowUpRight size={15}/></>}</button> : <p className="payment-setup-note">Razorpay checkout is not configured yet. Choose bank transfer or contact the agency.</p>}</div>}
        {paymentMethod === 'cashfree' && <div className="razorpay-payment-action">{cashfreeEnabled ? <button className="button dark" type="button" onClick={startCashfreeCheckout} disabled={busy || !Number(amount) || Number(amount) < 1 || Number(amount) > profilePayable}>{busy ? <LoadingAction loading label="Opening checkout…"/> : <>Continue to Cashfree · {formatMoney(transactionTotal)} <ArrowUpRight size={15}/></>}</button> : <p className="payment-setup-note">Cashfree checkout is not configured yet. The agency must add Cashfree API credentials to enable this option.</p>}</div>}
        {paymentMethod === 'bank' && <div className="bank-transfer-panel">
          <div className="bank-transfer-heading"><strong>Bank transfer details</strong><span>Order {order.id}</span></div>
          {bankTransferDetails?.accountNumber ? <dl className="bank-transfer-details"><div><dt>Account holder</dt><dd>{bankTransferDetails.accountName}</dd></div><div><dt>Bank</dt><dd>{bankTransferDetails.bankName}</dd></div><div><dt>Account number</dt><dd>{bankTransferDetails.accountNumber}</dd></div><div><dt>IFSC</dt><dd>{bankTransferDetails.ifscCode}</dd></div>{bankTransferDetails.branch && <div><dt>Branch</dt><dd>{bankTransferDetails.branch}</dd></div>}{bankTransferDetails.instructions && <div className="bank-transfer-instructions"><dt>Instructions</dt><dd>{bankTransferDetails.instructions}</dd></div>}</dl> : <p className="bank-details-unavailable">Bank details have not been added by the agency yet. Please call or email before transferring.</p>}
          <div className="manual-payment-disclaimer" role="status"><strong>MANUAL PAYMENT CONFIRMATION REQUIRED</strong><span>Please confirm your transfer by calling <a href="tel:8250558137">8250558137</a> or <a href="tel:8250589982">8250589982</a>, or email <a href="mailto:gouriagency185@gmail.com">gouriagency185@gmail.com</a>. Your balance updates after the agency confirms receipt.</span></div>
          <form className="bank-transfer-reference-form" onSubmit={submitReference}><label>Transfer type<select value={bankRail} onChange={event => setBankRail(event.target.value)}><option>NEFT</option><option>RTGS</option><option>IMPS</option></select></label><label>Amount before charges<input type="number" min="0.01" max={profilePayable.toFixed(2)} step="0.01" value={amount} onChange={event => { if (paymentMode === 'full') setPaymentMode('partial'); setAmount(event.target.value) }} required /><small>Transfer the total shown in the payment summary. Any excess will be applied to your next open bill after confirmation.</small></label><label>UTR / transaction reference<input value={reference} onChange={event => setReference(event.target.value)} minLength="6" maxLength="64" pattern="[A-Za-z0-9/-]{6,64}" placeholder="Enter bank reference" required /></label><button className="button outline" disabled={busy || !Number(amount) || Number(amount) > profilePayable}>{busy ? <LoadingAction loading label="Submitting transfer…"/> : 'Submit transfer for confirmation'}</button></form>
        </div>}
      </div>}
    </div>}
    {paymentHistory.length > 0 && <div className="client-payment-history"><strong>Paid payment history</strong>{paymentHistory.map(payment => <article key={payment.id}><div><span>{formatMoney(payment.transactionAmount ?? payment.amount)} received{payment.provider ? ` · ${payment.provider}` : ''}</span><small>Credited to bill: {formatMoney(paymentAppliedAmount(payment))}</small>{payment.chargeBreakdown?.length > 0 && <small>Charges: {payment.chargeBreakdown.map(item => `${item.reason} ${formatMoney(item.amount)}`).join(' · ')}</small>}<b className={`payment-status-label status-${payment.status.toLowerCase().replace(/[^a-z]+/g, '-')}`}>{paymentStatusLabel(payment)}</b><small>Paid {formatTimestamp(payment.paidAt || payment.reviewedAt || payment.submittedAt)} · Reference: {payment.reference || payment.razorpayPaymentId || payment.cashfreePaymentId || payment.razorpayOrderId || payment.cashfreeOrderId || '—'}</small>{paymentAllocationNote(payment) && <small>{paymentAllocationNote(payment)}</small>}{payment.batchId && <small>Combined checkout allocation · {payment.batchOrderIds?.length || 2} orders</small>}</div><button type="button" className="button outline receipt-download-button" onClick={() => downloadProtectedPdf(`${API}/client/orders/${encodeURIComponent(order.id)}/payments/${encodeURIComponent(payment.id)}/receipt`, token).catch(error => { setMessage(error.message); setIsError(true) })}>Download receipt <ArrowDown size={13}/></button></article>)}</div>}
    {message && <small className={`payment-message ${isError ? 'error' : ''}`} role={isError ? 'alert' : 'status'}>{message}</small>}
  </article>
}

function ClientPaymentBatch({ orders, razorpayKeyId, cashfreeEnabled, cashfreeEnvironment, paymentCharges = [], token, onOrdersUpdated, onPaymentSuccess }) {
  const [selectedIds, setSelectedIds] = useState([])
  const [provider, setProvider] = useState(razorpayKeyId ? 'Razorpay' : cashfreeEnabled ? 'Cashfree' : 'Razorpay')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [isError, setIsError] = useState(false)
  const availableOrders = orders.map(order => ({ order, balance: getOrderAvailableBalance(order) })).filter(item => item.balance > 0)
  const payableOrders = availableOrders.filter(item => item.order.status !== 'Cancelled')
  const selectedOrders = availableOrders.filter(item => selectedIds.includes(item.order.id) && item.order.status !== 'Cancelled')
  const total = Math.round(selectedOrders.reduce((sum, item) => sum + item.balance, 0) * 100) / 100
  const chargeBreakdown = calculateClientCharges(total, paymentCharges)
  const chargeTotal = sumClientCharges(chargeBreakdown)
  const transactionTotal = Math.round((total + chargeTotal) * 100) / 100
  const toggleOrder = orderId => setSelectedIds(current => current.includes(orderId) ? current.filter(id => id !== orderId) : [...current, orderId])
  const allPayableSelected = payableOrders.length > 0 && payableOrders.every(item => selectedIds.includes(item.order.id))
  const selectAll = () => setSelectedIds(allPayableSelected ? [] : payableOrders.map(item => item.order.id))
  const updateFromResponse = data => { if (Array.isArray(data.orders)) onOrdersUpdated(data.orders) }
  const reconcileBatch = async batchId => {
    const response = await fetch(`${API}/client/payment-batches/${encodeURIComponent(batchId)}/reconcile`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } })
    const data = await readApiJson(response, 'The combined payment status could not be refreshed yet.')
    if (!response.ok) throw new Error(data.error || 'Could not reconcile this combined payment.')
    updateFromResponse(data)
    if (data.status === 'Paid') {
      const allocations = data.allocations || []
      const totalPaid = allocations.reduce((sum, allocation) => sum + Number(allocation.payment?.transactionAmount ?? allocation.payment?.amount ?? 0), 0)
      const hasRefund = allocations.some(allocation => allocation.refundSummary)
      if (hasRefund) setMessage('The payment was received and allocated by order. A cancelled order allocation is being refunded.')
      else onPaymentSuccess({ batchId, provider: data.provider, allocations, total: totalPaid, emailStatus: data.emailStatus })
      setSelectedIds([])
    } else if (data.status === 'Failed') {
      setMessage(`${data.provider || provider} did not complete this payment. The selected order balances remain outstanding.`)
      setIsError(true)
    } else {
      setMessage(`${data.provider || provider} is still confirming this payment. The order balances will update when it is verified.`)
      setIsError(false)
    }
    return data
  }
  const startPayment = async () => {
    if (selectedOrders.length < 2) { setMessage('Select at least two orders with an outstanding balance.'); setIsError(true); return }
    if (provider === 'Razorpay' && !razorpayKeyId) { setMessage('Razorpay is not configured. Choose Cashfree if available.'); setIsError(true); return }
    if (provider === 'Cashfree' && !cashfreeEnabled) { setMessage('Cashfree is not configured yet. Choose Razorpay if available.'); setIsError(true); return }
    setBusy(true); setMessage(''); setIsError(false)
    try {
      const response = await fetch(`${API}/client/payment-batches/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ provider, orderIds: selectedOrders.map(item => item.order.id) }) })
      const data = await readApiJson(response, 'Could not start the combined payment.')
      if (!response.ok) throw new Error(data.error || 'Could not start the combined payment.')
      updateFromResponse(data)
      if (provider === 'Razorpay') {
        await loadRazorpayCheckout()
        const checkout = new window.Razorpay({
          key: data.keyId,
          amount: data.amountPaise,
          currency: data.currency,
          name: 'Gouri Agency',
          description: `Payment for ${selectedOrders.length} orders`,
          order_id: data.razorpayOrderId,
          prefill: { name: selectedOrders[0]?.order.ownerName || selectedOrders[0]?.order.shopName, email: selectedOrders[0]?.order.email, contact: selectedOrders[0]?.order.mobile },
          theme: { color: '#415c50' },
          handler: async () => { try { await reconcileBatch(data.batchId) } catch (error) { setMessage(error.message || 'Payment is being reconciled.'); setIsError(false) } finally { setBusy(false) } },
          modal: { ondismiss: async () => { try { await reconcileBatch(data.batchId) } catch (error) { setMessage(error.message || 'Checkout closed. We are still checking the payment status.'); setIsError(false) } finally { setBusy(false) } } }
        })
        checkout.on('payment.failed', async () => { try { await reconcileBatch(data.batchId) } catch (error) { setMessage(error.message || 'Payment status is still being reconciled.'); setIsError(true) } finally { setBusy(false) } })
        checkout.open()
      } else {
        await loadCashfreeCheckout()
        const cashfree = window.Cashfree({ mode: data.environment || cashfreeEnvironment || 'production' })
        const result = await cashfree.checkout({ paymentSessionId: data.paymentSessionId, redirectTarget: '_modal' })
        if (result?.redirect) {
          setMessage('Cashfree is redirecting you to complete payment. Your selected order balances will update when confirmed.')
          setIsError(false)
          setBusy(false)
          return
        }
        await reconcileBatch(data.batchId)
        setBusy(false)
      }
    } catch (error) {
      setMessage(error.message || 'Could not start the combined payment.')
      setIsError(true)
      setBusy(false)
    }
  }
  useEffect(() => { if (!razorpayKeyId && cashfreeEnabled) setProvider('Cashfree'); else if (razorpayKeyId && !cashfreeEnabled) setProvider('Razorpay') }, [razorpayKeyId, cashfreeEnabled])
  if (payableOrders.length < 2) return null
  return <section className="client-payment-batch" aria-labelledby="combined-payment-title">
    <div className="client-payment-batch-heading"><div><span className="eyebrow">ONE CHECKOUT · ORDER-WISE LEDGER</span><h3 id="combined-payment-title">Pay several orders together</h3><p>Select the order balances to combine. The payment will be split back to each order in both ledgers.</p></div><button type="button" className="text-button" onClick={selectAll}>{allPayableSelected ? 'Clear selection' : 'Select all payable'}</button></div>
    <div className="client-payment-batch-orders">{payableOrders.map(({ order, balance }) => <label className="client-payment-batch-order" key={order.id}><input type="checkbox" checked={selectedIds.includes(order.id)} onChange={() => toggleOrder(order.id)} disabled={busy}/><span><strong>{order.id}</strong><small>{order.status} · {formatTimestamp(order.date)}</small></span><b>{formatMoney(balance)}</b></label>)}</div>
    <PaymentChargeSummary baseAmount={total} charges={chargeBreakdown}/>
    <div className="client-payment-batch-footer"><div><small>{selectedOrders.length} order{selectedOrders.length === 1 ? '' : 's'} selected</small><strong>Combined total {formatMoney(transactionTotal)}</strong></div><div className="client-payment-batch-gateways"><button type="button" className={provider === 'Razorpay' ? 'selected' : ''} aria-pressed={provider === 'Razorpay'} onClick={() => setProvider('Razorpay')} disabled={!razorpayKeyId || busy}><img src="https://razorpay.com/build/browser/static/static/razorpay-logo.svg" alt="Razorpay"/></button><button type="button" className={provider === 'Cashfree' ? 'selected' : ''} aria-pressed={provider === 'Cashfree'} onClick={() => setProvider('Cashfree')} disabled={!cashfreeEnabled || busy}><img className="cashfree-payment-logo" src="https://cashfreelogo.cashfree.com/website/landings/homepage/cashfreeLogo.png" alt="Cashfree Payments"/></button><button type="button" className="button dark" onClick={startPayment} disabled={busy || selectedOrders.length < 2 || total < 1 || (provider === 'Razorpay' ? !razorpayKeyId : !cashfreeEnabled)}>{busy ? <LoadingAction loading label="Opening checkout…"/> : <>Pay selected orders <ArrowUpRight size={15}/></>}</button></div></div>
    {!razorpayKeyId && !cashfreeEnabled && <small className="payment-setup-note">Online payment gateways are not configured. Ask the agency to enable Razorpay or Cashfree.</small>}
    {message && <small className={`payment-message ${isError ? 'error' : ''}`} role={isError ? 'alert' : 'status'}>{message}</small>}
  </section>
}

function ClientDuesTab({ orders, razorpayKeyId, cashfreeEnabled, cashfreeEnvironment, bankTransferDetails, promoCode, paymentCharges = [], token, currentTime, onOrdersUpdated, onOrderUpdated, onPaymentSuccess, notice }) {
  const payableOrders = orders.filter(order => order.status !== 'Cancelled' && getOrderAvailableBalance(order) > 0)
  const awaitingOrders = orders.filter(order => order.status !== 'Cancelled' && Number(order.amountDue || 0) - Number(order.amountPaid || 0) > 0 && getOrderAvailableBalance(order) <= 0)
  return <section className="dash-panel client-dues-tab">
    <div className="panel-heading"><div><span className="eyebrow">BILL-WISE CHECKOUT</span><h2>Pay your outstanding bills</h2><p>Select order balances for one checkout, or pay the remaining bill directly.</p></div><Package size={22}/></div>
    <PaymentSummary orders={orders} title="Your overall balance" className="client-payment-overview"/>
    {notice && <div className="admin-notice" role="alert">{notice}</div>}
    {payableOrders.length > 1 && <ClientPaymentBatch orders={orders} razorpayKeyId={razorpayKeyId} cashfreeEnabled={cashfreeEnabled} cashfreeEnvironment={cashfreeEnvironment} paymentCharges={paymentCharges} token={token} onOrdersUpdated={onOrdersUpdated} onPaymentSuccess={onPaymentSuccess}/>}
    {payableOrders.length === 1 && <div className="client-single-due"><div className="client-single-due-heading"><span className="eyebrow">ONE BILL AVAILABLE</span><strong>{payableOrders[0].id} · {formatMoney(getOrderAvailableBalance(payableOrders[0]))}</strong></div><div className="client-payment-list"><ClientPaymentOrder order={payableOrders[0]} profileOrders={orders} razorpayKeyId={razorpayKeyId} cashfreeEnabled={cashfreeEnabled} cashfreeEnvironment={cashfreeEnvironment} bankTransferDetails={bankTransferDetails} promoCode={promoCode} paymentCharges={paymentCharges} token={token} currentTime={currentTime} onUpdated={onOrderUpdated} onPaymentSuccess={onPaymentSuccess}/></div></div>}
    {!payableOrders.length && orders.length > 0 && <div className="client-dues-empty"><strong>{awaitingOrders.length ? 'Payment confirmation is in progress' : 'No outstanding bills'}</strong><span>{awaitingOrders.length ? 'Your submitted payment is being reconciled. The bill will update when the gateway or agency confirms it.' : 'All recorded order balances are paid.'}</span></div>}
    {!orders.length && <div className="empty-state"><div className="empty-icon"><Sparkles/></div><h3>No bills are available yet.</h3><p>Outstanding order balances will appear here after the agency records them.</p></div>}
  </section>
}

const clientDashboardTabs = [
  { id: 'overview', label: 'Overview' },
  { id: 'pay-dues', label: 'Pay dues' },
  { id: 'orders', label: 'Orders & payments' },
  { id: 'in-progress-orders', label: 'In progress' },
  { id: 'cancelled-orders', label: 'Cancelled orders' },
  { id: 'failed-transactions', label: 'Failed transactions' },
  { id: 'refunds', label: 'Refunds' },
  { id: 'statements', label: 'Statements' },
  { id: 'messages', label: 'Messages' },
  { id: 'profile', label: 'Profile' }
]

function OrderRequestDisclaimer({ onAgree, onDisagree }) {
  const agreeButtonRef = useRef(null)
  useEffect(() => { agreeButtonRef.current?.focus() }, [])
  return <div className="order-disclaimer-backdrop">
    <section className="order-disclaimer-dialog" role="dialog" aria-modal="true" aria-labelledby="order-disclaimer-title" aria-describedby="order-disclaimer-copy">
      <div className="eyebrow"><span className="live-dot"/> BEFORE YOU ORDER</div>
      <h2 id="order-disclaimer-title" className="order-disclaimer-title"><span aria-hidden="true">!</span> Important Notice</h2>
      <div id="order-disclaimer-copy" className="terms-notice order-disclaimer-copy">
        <p>Online orders through this website are strictly limited to verified <strong>IndiaMART customers</strong> placing orders via IndiaMART. No other direct or external online orders will be accepted on this platform. For further details, inquiries, or order assistance, please contact <strong>Gouri Agency</strong>.</p>
      </div>
      <p className="order-disclaimer-prompt">Please confirm that you understand this restriction before opening the order form.</p>
      <div className="order-disclaimer-actions">
        <button type="button" className="button outline" onClick={onDisagree}>Disagree</button>
        <button ref={agreeButtonRef} type="button" className="button dark" onClick={onAgree}>Agree and open order form <ArrowRight size={15}/></button>
      </div>
    </section>
  </div>
}

function ClientTransactionsTab({ orders, kind }) {
  const isRefunds = kind === 'refunds'
  const seenTransactions = new Set()
  const transactions = orders.flatMap(order => (order.payments || []).flatMap(payment => {
    if (isRefunds) {
      const refunds = payment.refunds?.length
        ? payment.refunds
        : payment.refundStatus
          ? [{ id: payment.refundId || '', amount: payment.amountRefunded || payment.amount, status: payment.refundStatus, reason: payment.refundFailureReason || '' }]
          : []
      return refunds
        .filter(refund => !refund.allocationOrderId || refund.allocationOrderId === order.id)
        .map(refund => ({ order, payment, refund }))
    }
    return ['failed', 'rejected'].includes(String(payment.status || '').toLowerCase())
      ? [{ order, payment }]
      : []
  })).filter(({ order, payment, refund }) => {
    const key = isRefunds
      ? refund?.id || refund?.receipt || `${order.id}/${payment.id}/refund`
      : payment.batchId ? `batch/${payment.batchId}` : `${order.id}/${payment.id}/failed`
    if (seenTransactions.has(key)) return false
    seenTransactions.add(key)
    return true
  })

  const title = isRefunds ? 'Refund transactions' : 'Failed transactions'
  const subtitle = isRefunds
    ? 'Track refunds by order, payment method, amount, and current status.'
    : 'Payment attempts that were not completed or were marked as not received.'

  return <section className={`dash-panel client-transactions-panel ${isRefunds ? 'refund-transactions-panel' : 'failed-transactions-panel'}`}>
    <div className="panel-heading"><div><span className="eyebrow">PAYMENT RECORDS</span><h2>{title}</h2><p>{subtitle}</p></div><span className="count-pill">{transactions.length} {isRefunds ? 'refunds' : 'transactions'}</span></div>
    {transactions.length ? <div className="client-transaction-list">{transactions.map(({ order, payment, refund }, index) => {
      const status = isRefunds ? String(refund.status || payment.refundStatus || 'pending') : String(payment.status || 'Failed')
      const failedAt = payment.failedAt || payment.reviewedAt || payment.submittedAt || payment.paidAt
      const refundAt = refund?.processedAt || refund?.updatedAt || refund?.createdAt || payment.refundUpdatedAt || payment.paidAt || payment.submittedAt
      const reference = isRefunds
        ? refund?.id || refund?.receipt || payment.refundId || payment.reference || '—'
        : payment.reference || payment.razorpayPaymentId || payment.cashfreePaymentId || payment.razorpayOrderId || payment.cashfreeOrderId || '—'
      const amount = isRefunds ? refund?.amount ?? payment.amountRefunded ?? payment.amount : payment.batchTotalAmount ?? payment.transactionAmount ?? payment.amount
      const statusLabel = isRefunds
        ? ({ initiating: 'Starting refund', pending: 'Refund processing', processed: 'Refunded', partially_refunded: 'Partially refunded', failed: 'Refund failed', manual_review: 'Agency review required' }[status] || status)
        : paymentStatusLabel(payment)
      const reason = isRefunds ? refund?.reason || refund?.failureReason || payment.refundFailureReason : payment.failureReason
      return <article className="client-transaction-row" key={`${order.id}-${payment.id}-${isRefunds ? reference : 'failed'}-${index}`}>
        <div className="client-transaction-main"><div className="client-transaction-title"><strong>{payment.batchId && payment.batchOrderIds?.length > 1 ? payment.batchOrderIds.join(', ') : order.id}</strong><span className={`client-transaction-status status-${status.toLowerCase().replace(/[^a-z]+/g, '-')}`}>{statusLabel}</span></div>
          <small>{payment.provider || payment.originalProvider || 'Payment gateway'} · {isRefunds ? `Refund ${reference}` : `Payment ${reference}`}</small>
          {(isRefunds ? refundAt : failedAt) && <small>{isRefunds ? 'Refund updated' : 'Attempt recorded'} {formatTimestamp(isRefunds ? refundAt : failedAt)}</small>}
          {reason && <small className="client-transaction-reason">{reason}</small>}
          {isRefunds && refund?.arn && <small>Refund ARN: {refund.arn}</small>}
        </div>
        <strong className="client-transaction-amount">{formatMoney(amount)}</strong>
      </article>
    })}</div> : <div className="empty-state"><div className="empty-icon"><Package size={19}/></div><h3>{isRefunds ? 'No refunds recorded.' : 'No failed transactions.'}</h3><p>{isRefunds ? 'Any refund updates for your payments will appear here.' : 'Unsuccessful payment attempts will appear here. They are excluded from your statement and ledger PDFs.'}</p></div>}
  </section>
}

const adminDashboardTabs = [
  { id: 'overview', label: 'Overview' },
  { id: 'notices', label: 'Notice board' },
  { id: 'profiles', label: 'Clients' },
  { id: 'orders', label: 'Orders' },
  { id: 'sales', label: 'Sales analysis' },
  { id: 'bank', label: 'Bank transfer details' },
  { id: 'charges', label: 'Payment charges' },
  { id: 'promo', label: 'Promo codes' },
  { id: 'communications', label: 'Messages' },
  { id: 'email', label: 'Email settings' },
  { id: 'access', label: 'Admin access' },
  { id: 'settings', label: 'Images & automation' },
  { id: 'courier', label: 'Courier' },
  { id: 'eway', label: 'E-way bill' },
  { id: 'trash', label: 'Trash bin' }
]
const adminClientTabs = [
  { id: 'overview', label: 'Overview' },
  { id: 'orders', label: 'Orders' },
  { id: 'dues', label: 'Dues' },
  { id: 'statements', label: 'Statements' },
  { id: 'profile', label: 'Profile & documents' }
]

const ADMIN_EXTERNAL_PORTALS = {
  courier: {
    title: 'Courier booking portal',
    name: 'Delhivery One',
    url: 'https://one.delhivery.com/v2/login',
    description: 'You are leaving Gouri Agency to book and manage courier shipments on Delhivery One.'
  },
  eway: {
    title: 'E-way bill portal',
    name: 'GST e-Way Bill Portal',
    url: 'https://ewaybillgst.gov.in/',
    description: 'You are leaving Gouri Agency to create or manage an e-way bill on the GST portal.'
  }
}

function AdminExternalPortalPanel({ portalKey, onOpen }) {
  const portal = ADMIN_EXTERNAL_PORTALS[portalKey]
  return <section className="dash-panel external-portal-panel">
    <div className="panel-heading"><div><span className="eyebrow">THIRD-PARTY SERVICE</span><h2>{portal.title}</h2><p>Continue to {portal.name} for this service.</p></div><ArrowUpRight size={22}/></div>
    <div className="external-portal-content">
      <p>{portal.description}</p>
      <p className="external-portal-inline-warning"><strong>Third-party website:</strong> Please agree to the disclaimer before continuing.</p>
      <button className="button dark" type="button" onClick={onOpen}>Open {portal.name} <ArrowUpRight size={15}/></button>
    </div>
  </section>
}

function AdminExternalPortalDialog({ portalKey, onCancel, onAgree }) {
  const portal = ADMIN_EXTERNAL_PORTALS[portalKey]
  if (!portal) return null
  return <div className="payment-redirect-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onCancel() }}>
    <section className="payment-redirect-dialog external-portal-dialog" role="dialog" aria-modal="true" aria-labelledby="external-portal-title">
      <span className="eyebrow"><span className="live-dot"/> EXTERNAL PORTAL</span>
      <h2 id="external-portal-title">Continue to {portal.name}?</h2>
      <p>{portal.description}</p>
      <div className="external-portal-warning" role="alert"><strong>IMPORTANT: THIRD-PARTY WEBSITE</strong><span>This service is operated by a third party and is outside Gouri Agency's control. Please agree to continue.</span></div>
      <div className="payment-redirect-actions"><button type="button" className="button dark" onClick={onAgree}>Agree and continue <ArrowUpRight size={15}/></button><button type="button" className="button outline" onClick={onCancel}>Cancel</button></div>
    </section>
  </div>
}

function DashboardTabBar({ tabs, active, idPrefix, label, onChange }) {
  return <div className="dashboard-tabs" role="tablist" aria-label={label}>
    {tabs.map(tab => <button key={tab.id} id={`${idPrefix}-${tab.id}-tab`} type="button" role="tab" aria-selected={active === tab.id} aria-controls={`${idPrefix}-panel`} className={active === tab.id ? 'selected' : ''} onClick={() => onChange(tab.id)}>{tab.label}</button>)}
  </div>
}

function PaymentSuccessPage({ details, token, email, onReturn }) {
  const [receiptMessage, setReceiptMessage] = useState('Preparing your receipt download…')
  const [receiptError, setReceiptError] = useState(false)
  const order = details?.order
  const payment = details?.payment
  const allocations = details?.allocations || []
  const receiptPath = order && payment
    ? `${API}/client/orders/${encodeURIComponent(order.id)}/payments/${encodeURIComponent(payment.id)}/receipt`
    : ''
  useEffect(() => {
    let cancelled = false
    if (!receiptPath) return undefined
    downloadProtectedPdf(receiptPath, token)
      .then(() => { if (!cancelled) setReceiptMessage('Receipt download started. If it did not appear, select Download receipt below.') })
      .catch(error => {
        if (cancelled) return
        setReceiptMessage(error.message || 'The receipt could not be downloaded automatically.')
        setReceiptError(true)
      })
    return () => { cancelled = true }
  }, [receiptPath, token])
  const emailMessage = details?.emailStatus === 'sent'
    ? `The receipt PDF was emailed to ${email}.`
    : details?.emailStatus === 'needs_configuration'
      ? 'The receipt email is saved for delivery, but the mail service is not configured yet.'
      : `The receipt PDF is queued for ${email}.`
  const downloadReceipt = async () => {
    try {
      await downloadProtectedPdf(receiptPath, token)
      setReceiptMessage('Receipt download started.')
      setReceiptError(false)
    } catch (error) {
      setReceiptMessage(error.message || 'Could not download the receipt.')
      setReceiptError(true)
    }
  }
  return <main className="inner-page payment-success-page">
    <section className="payment-success-card" aria-labelledby="payment-success-title">
      <div className="payment-success-check"><Check size={25}/></div>
      <span className="eyebrow">PAYMENT SUCCESSFUL</span>
      <h1 id="payment-success-title">Payment received.</h1>
      <p>{allocations.length > 0 ? 'The received amount was allocated to each selected order. Each client and admin ledger now shows its order-level payment.' : Number(payment?.amountCarriedForward || 0) > 0 ? `We applied ${formatMoney(paymentAppliedAmount(payment))} to ${order?.id} and carried ${formatMoney(payment.amountCarriedForward)} to the next open bill(s). Your statement and receipt show the allocation.` : 'Your payment has been verified and the order balance has been updated.'}</p>
      {order && payment && <dl className="payment-success-details">
        <div><dt>Order number</dt><dd>{order.id}</dd></div>
        <div><dt>Applied to this bill</dt><dd>{formatMoney(paymentAppliedAmount(payment))}</dd></div>
        {Number(payment.transactionAmount ?? payment.amount ?? 0) !== paymentAppliedAmount(payment) && <div><dt>Total transaction</dt><dd>{formatMoney(payment.transactionAmount ?? payment.amount)}</dd></div>}
        {Number(payment.chargeAmount || 0) > 0 && <div><dt>Additional charges</dt><dd>{formatMoney(payment.chargeAmount)}</dd></div>}
        {(payment.chargeBreakdown || []).map((charge, index) => <div key={charge.id || `${charge.reason}-${index}`}><dt>{charge.reason}</dt><dd>{formatMoney(charge.amount)}</dd></div>)}
        {(payment.allocations || []).filter(row => row.role === 'carry-forward').map(row => <div key={row.orderId}><dt>Credit to {row.orderId}</dt><dd>{formatMoney(row.amount)}</dd></div>)}
        <div><dt>Outstanding balance</dt><dd>{formatMoney(order.status === 'Cancelled' ? 0 : Math.max(0, Number(order.amountDue || 0) - Number(order.amountPaid || 0)))}</dd></div>
        <div><dt>Payment date and time</dt><dd>{formatTimestamp(payment.paidAt || payment.reviewedAt)}</dd></div>
      </dl>}
      {allocations.length > 0 && <><dl className="payment-success-details payment-batch-success-total"><div><dt>Gateway</dt><dd>{details.provider}</dd></div><div><dt>Total received</dt><dd>{formatMoney(details.total)}</dd></div><div><dt>Orders reconciled</dt><dd>{allocations.length}</dd></div></dl><div className="payment-success-allocation-list"><strong>Payment allocation by order</strong>{allocations.map(({ order: allocatedOrder, orderId, payment: allocatedPayment }) => <article key={`${orderId || allocatedOrder?.id}-${allocatedPayment?.id}`}><div><b>{orderId || allocatedOrder?.id}</b><small>{formatTimestamp(allocatedPayment?.paidAt || allocatedPayment?.submittedAt)} · {allocatedPayment?.provider || details.provider}{Number(allocatedPayment?.chargeAmount || 0) > 0 ? ` · Charges ${formatMoney(allocatedPayment.chargeAmount)}` : ''}</small></div><strong>{formatMoney(allocatedPayment?.transactionAmount ?? allocatedPayment?.amount)}</strong><button type="button" className="button outline" onClick={() => downloadProtectedPdf(`${API}/client/orders/${encodeURIComponent(orderId || allocatedOrder.id)}/payments/${encodeURIComponent(allocatedPayment.id)}/receipt`, token).catch(error => { setReceiptMessage(error.message || 'Could not download this order receipt.'); setReceiptError(true) })}>Receipt <ArrowDown size={13}/></button></article>)}</div></>}
      <p className={`payment-success-message${receiptError ? ' error' : ''}`} role={receiptError ? 'alert' : 'status'}>{allocations.length > 0 ? 'Payment was reconciled order by order. Download each receipt below.' : receiptMessage}</p>
      <p className="payment-success-email">{allocations.length > 0 ? details.emailStatus === 'sent' ? `Order-wise receipt PDFs were emailed for each selected order to ${email}.` : `Order-wise receipt PDFs are queued for ${email}.` : emailMessage}</p>
      <div className="payment-success-actions">{receiptPath && <button className="button dark" type="button" onClick={downloadReceipt}>Download receipt <ArrowDown size={15}/></button>}<button className="button outline" type="button" onClick={onReturn}>Return to dashboard <ArrowRight size={15}/></button></div>
    </section>
  </main>
}

const shopDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const shopTimeZone = 'Asia/Kolkata'
function ShopHours() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    let timer
    const updateAtNextMinute = () => {
      const delay = 60000 - (Date.now() % 60000) + 20
      timer = window.setTimeout(() => { setNow(new Date()); updateAtNextMinute() }, delay)
    }
    updateAtNextMinute()
    return () => window.clearTimeout(timer)
  }, [])
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: shopTimeZone, weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).map(part => [part.type, part.value]))
  const today = parts.weekday
  const currentMinutes = Number(parts.hour) * 60 + Number(parts.minute)
  const todayText = new Intl.DateTimeFormat('en-IN', {
    timeZone: shopTimeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', hourCycle: 'h12'
  }).format(now)
  const status = today === 'Monday'
    ? { tone: 'closed', label: 'Closed today' }
    : currentMinutes < 720
      ? { tone: 'before-open', label: 'Opens at 12:00 PM' }
      : currentMinutes >= 1140
        ? { tone: 'closed', label: 'Closed today' }
        : currentMinutes >= 990
          ? { tone: 'closing-soon', label: 'Closing soon' }
          : { tone: 'open', label: 'Open now' }
  return <>
    <p className="shop-clock-readout">Durgapur time · {todayText} IST</p>
    <div className="shop-hours">
      {shopDays.map(day => {
        const isToday = day === today
        const dayStatus = day === 'Monday' ? 'Closed' : '12:00 PM – 7:00 PM'
        return <div className={`shop-hour-row${isToday ? ` today ${status.tone}` : ''}`} key={day}>
          <span className="shop-hour-day">{day}{isToday && <small>TODAY</small>}</span>
          <strong>{dayStatus}</strong>
          {isToday ? <span className={`shop-status ${status.tone}`} aria-live="polite">{status.label}</span> : <span />}
        </div>
      })}
    </div>
  </>
}

function App() {
  const [page, setPage] = useState('home')
  const [siteVisitorCount, setSiteVisitorCount] = useState(null)
  const siteVisitRequestRef = useRef(null)
  const [currentTime, setCurrentTime] = useState(Date.now())
  const [orderIntakeSettings, setOrderIntakeSettings] = useState({ enabled: true, message: 'Order requests are temporarily closed. Please contact Gouri Agency for assistance.' })
  const [orderDisclaimerAccepted, setOrderDisclaimerAccepted] = useState(false)
  const [preloaderVisible, setPreloaderVisible] = useState(true)
  const [preloaderLeaving, setPreloaderLeaving] = useState(false)
  const [clientTab, setClientTab] = useState('overview')
  const [adminTab, setAdminTab] = useState('overview')
  const [externalPortal, setExternalPortal] = useState(null)
  const [paymentSuccess, setPaymentSuccess] = useState(null)
  const [role, setRole] = useState('client')
  const [loginCaptcha, setLoginCaptcha] = useState(null)
  const [loginCaptchaAnswer, setLoginCaptchaAnswer] = useState('')
  const [loginCaptchaLoading, setLoginCaptchaLoading] = useState(false)
  const [loginCaptchaError, setLoginCaptchaError] = useState('')
  const [loginCaptchaRevision, setLoginCaptchaRevision] = useState(0)
  const [clientTermsAccepted, setClientTermsAccepted] = useState(false)
  const [user, setUser] = useState(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [orders, setOrders] = useState([])
  const [profiles, setProfiles] = useState([])
  const [trash, setTrash] = useState([])
  const [trashSearch, setTrashSearch] = useState('')
  const [profileSearch, setProfileSearch] = useState('')
  const [profileOrderSearch, setProfileOrderSearch] = useState({})
  const [adminOrderSearch, setAdminOrderSearch] = useState('')
  const [clientProfileTabs, setClientProfileTabs] = useState({})
  const [orderNotice, setOrderNotice] = useState('')
  const [updatingOrder, setUpdatingOrder] = useState('')
  const [updatingClientAccess, setUpdatingClientAccess] = useState('')
  const [items, setItems] = useState([{ name: '', quantity: '' }])
  const [indiaMartCustomer, setIndiaMartCustomer] = useState('')
  const [bulkImportReset, setBulkImportReset] = useState(0)
  const [gstVerification, setGstVerification] = useState(null)
  const [gstLookupStatus, setGstLookupStatus] = useState({ state: 'idle', message: '' })
  const gstLookupAttemptRef = useRef('')
  const gstLookupTimerRef = useRef(null)
  const [pincodeLookupStatus, setPincodeLookupStatus] = useState({ state: 'idle', message: '' })
  const pincodeLookupAttemptRef = useRef('')
  const pincodeLookupTimerRef = useRef(null)
  const [notice, setNotice] = useState('')
  const [noticeIsError, setNoticeIsError] = useState(false)
  const [businessType, setBusinessType] = useState('')
  const [partnerOneName, setPartnerOneName] = useState('')
  const [partnerTwoName, setPartnerTwoName] = useState('')
  const [authorizedSignatoryPartner, setAuthorizedSignatoryPartner] = useState('')
  const [partnerUploadOpen, setPartnerUploadOpen] = useState(false)
  const [partnerPhotoReady, setPartnerPhotoReady] = useState(false)
  const [partnerPhotoFileName, setPartnerPhotoFileName] = useState('')
  const [busy, setBusy] = useState(false)
  const [previewDocument, setPreviewDocument] = useState(null)
  const [downloadingArchive, setDownloadingArchive] = useState('')
  const [clientOrders, setClientOrders] = useState([])
  const [razorpayKeyId, setRazorpayKeyId] = useState('')
  const [cashfreeEnabled, setCashfreeEnabled] = useState(false)
  const [cashfreeEnvironment, setCashfreeEnvironment] = useState('production')
  const cashfreeReturnHandledRef = useRef('')
  const [bankTransferDetails, setBankTransferDetails] = useState({})
  const [clientPaymentCharges, setClientPaymentCharges] = useState([])
  const [clientPromoCode, setClientPromoCode] = useState(null)
  const [clientOrderNotice, setClientOrderNotice] = useState('')
  const [signaturePreview, setSignaturePreview] = useState(null)
  const [signatureError, setSignatureError] = useState('')
  const [processingSignature, setProcessingSignature] = useState(false)
  const [deletingProfile, setDeletingProfile] = useState(false)
  const [trashAction, setTrashAction] = useState('')
  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 15_000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    if (page !== 'login' || role !== 'client') {
      setLoginCaptcha(null)
      setLoginCaptchaAnswer('')
      setLoginCaptchaError('')
      setLoginCaptchaLoading(false)
      return undefined
    }
    let active = true
    setLoginCaptcha(null)
    setLoginCaptchaAnswer('')
    setLoginCaptchaError('')
    setLoginCaptchaLoading(true)
    const loadCaptcha = async () => {
      try {
        const response = await fetch(`${API}/client/login-captcha`, { cache: 'no-store', signal: AbortSignal.timeout(9000) })
        const data = await readApiJson(response, 'The CAPTCHA service could not be reached. Please try again.')
        if (!response.ok) throw new Error(data.error || 'A CAPTCHA code could not be loaded.')
        if (active) setLoginCaptcha(data)
      } catch (error) {
        if (active) setLoginCaptchaError(error.message || 'A CAPTCHA code could not be loaded.')
      } finally {
        if (active) setLoginCaptchaLoading(false)
      }
    }
    loadCaptcha()
    return () => { active = false }
  }, [page, role, loginCaptchaRevision])
  useEffect(() => {
    if (page !== 'home') return
    if (!siteVisitRequestRef.current) {
      let alreadyCountedThisSession = false
      try {
        alreadyCountedThisSession = window.sessionStorage.getItem('gouri-agency-home-visit-counted') === '1'
        if (!alreadyCountedThisSession) window.sessionStorage.setItem('gouri-agency-home-visit-counted', '1')
      } catch {}
      siteVisitRequestRef.current = fetch(`${API}${alreadyCountedThisSession ? '/public-stats' : '/public-stats/visit'}`, {
        method: alreadyCountedThisSession ? 'GET' : 'POST', cache: 'no-store'
      }).then(response => readApiJson(response, 'Visitor count could not be loaded.'))
    }
    let cancelled = false
    siteVisitRequestRef.current.then(data => {
      if (!cancelled) setSiteVisitorCount(Number(data.visitorCount || 0))
    }).catch(() => {})
    return () => { cancelled = true }
  }, [page])
  useEffect(() => {
    let cancelled = false
    const refreshOrderIntake = async () => {
      try {
        const response = await fetch(`${API}/order-intake-status`, { cache: 'no-store' })
        const data = await response.json()
        if (response.ok && !cancelled && typeof data.enabled === 'boolean') setOrderIntakeSettings(data)
      } catch {}
    }
    refreshOrderIntake()
    const timer = window.setInterval(refreshOrderIntake, 10_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [])
  const selectedPartnerName = authorizedSignatoryPartner === 'partnerTwo' ? partnerTwoName.trim() : authorizedSignatoryPartner === 'partnerOne' ? partnerOneName.trim() : ''
  const savedPartnerDocumentsMatch = Boolean(selectedPartnerName && user?.profile?.authorizedSignatoryName === selectedPartnerName && user.profile.attachments?.ownerPhoto && user.profile.attachments?.signature)
  const uploadedPartnerDocumentsReady = partnerPhotoReady && Boolean(signaturePreview)
  const selectedPartnerDocumentsReady = savedPartnerDocumentsMatch || uploadedPartnerDocumentsReady

  useEffect(() => {
    const fadeTimer = window.setTimeout(() => setPreloaderLeaving(true), 700)
    const removeTimer = window.setTimeout(() => setPreloaderVisible(false), 1250)
    return () => { window.clearTimeout(fadeTimer); window.clearTimeout(removeTimer) }
  }, [])

  useEffect(() => {
    if (user?.role !== 'admin') return
    let cancelled = false
    let requestActive = false
    const loadOrders = async () => {
      if (requestActive || document.visibilityState === 'hidden') return
      requestActive = true
      try {
        const headers = { Authorization: `Bearer ${user.token}` }
        const [response, trashResponse] = await Promise.all([
          fetch(`${API}/orders`, { cache: 'no-store', headers }),
          fetch(`${API}/trash`, { cache: 'no-store', headers })
        ])
        const [data, trashData] = await Promise.all([response.json(), trashResponse.json()])
        if (!response.ok) throw new Error(data.error || 'Could not load orders.')
        if (!trashResponse.ok) throw new Error(trashData.error || 'Could not load the trash bin.')
        if (!cancelled) {
          setOrders(data.orders || [])
          setProfiles(data.profiles || [])
          setTrash(trashData.trash || [])
          setOrderNotice('')
        }
      } catch (err) {
        if (!cancelled) setOrderNotice(err.message || 'Could not load orders.')
      } finally {
        requestActive = false
      }
    }
    loadOrders()
    const refreshTimer = window.setInterval(loadOrders, 10_000)
    const refreshWhenVisible = () => { if (document.visibilityState === 'visible') loadOrders() }
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => { cancelled = true; window.clearInterval(refreshTimer); document.removeEventListener('visibilitychange', refreshWhenVisible) }
  }, [user])
  useEffect(() => {
    if (user?.role !== 'client' || !user.token) return
    let cancelled = false
    let requestActive = false
    const loadClientOrders = async () => {
      if (requestActive || document.visibilityState === 'hidden') return
      requestActive = true
      try {
        let response
        let data
        for (let attempt = 0; attempt < 2; attempt += 1) {
          response = await fetch(`${API}/client/orders`, { cache: 'no-store', headers: { Authorization: `Bearer ${user.token}` } })
          try {
            data = await readApiJson(response, 'Could not refresh your orders right now. Your latest order information is still shown, and the portal will retry automatically.')
            break
          } catch (error) {
            if (attempt === 1) throw error
            await new Promise(resolve => window.setTimeout(resolve, 700))
          }
        }
        if (response.status === 403 && data?.errorCode === 603) {
          if (!cancelled) {
            setClientOrders([])
            setUser(null)
            setRole('client')
            setPage('login')
            setNotice(data.error || 'Access denied. Contact Gouri Agency administration. Error code: 603.')
            setNoticeIsError(true)
            setClientOrderNotice('')
            window.scrollTo({ top: 0, behavior: 'smooth' })
          }
          return
        }
        if (!response.ok) throw new Error(data.error || 'Could not load your orders.')
        if (!cancelled) {
          setClientOrders(data.orders || [])
          setRazorpayKeyId(data.razorpayKeyId || '')
          setCashfreeEnabled(Boolean(data.cashfreeEnabled))
          setCashfreeEnvironment(data.cashfreeEnvironment || 'production')
          setBankTransferDetails(data.bankTransferDetails || {})
          setClientPaymentCharges(Array.isArray(data.paymentCharges) ? data.paymentCharges : [])
          setClientPromoCode(data.promoCode || null)
          if (data.profile) setUser(current => current?.token === user.token ? { ...current, profile: data.profile, name: data.profile.ownerName || data.profile.shopName, email: data.profile.email } : current)
          setClientOrderNotice('')
        }
      } catch (err) {
        if (!cancelled) setClientOrderNotice(err.message || 'Could not load your orders.')
      } finally {
        requestActive = false
      }
    }
    loadClientOrders()
    const refreshTimer = window.setInterval(loadClientOrders, 10_000)
    const refreshWhenVisible = () => { if (document.visibilityState === 'visible') loadClientOrders() }
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => { cancelled = true; window.clearInterval(refreshTimer); document.removeEventListener('visibilitychange', refreshWhenVisible) }
  }, [user?.role, user?.token])
  const go = (next) => {
    if (next === 'orders') setOrderDisclaimerAccepted(false)
    if (next === 'orders' && user?.profile) {
      setBusinessType(user.profile.businessType)
      setPartnerOneName(user.profile.partnerOne || '')
      setPartnerTwoName(user.profile.partnerTwo || '')
      setAuthorizedSignatoryPartner('')
      if (user.role === 'client') {
        setItems([{ name: '', quantity: '' }])
        setNotice('')
        setNoticeIsError(false)
      }
    }
    setPage(next); setMenuOpen(false); window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const lookupPincode = async (value, formElement, preferred = {}) => {
    const pincode = String(value || '').trim()
    if (!/^\d{6}$/.test(pincode) || !formElement?.isConnected) return null
    if (pincodeLookupAttemptRef.current === pincode) return null
    pincodeLookupAttemptRef.current = pincode
    setPincodeLookupStatus({ state: 'checking', message: 'Finding the city and state for this PIN code…' })
    try {
      const response = await fetch(`${API}/pincode/${pincode}`, { cache: 'no-store' })
      const data = await response.json()
      const requestIsCurrent = formElement.isConnected && String(formElement.elements.pincode.value || '').trim() === pincode
      if (!requestIsCurrent) return null
      if (!response.ok) throw new Error(data.error || 'PIN code details could not be found.')
      const location = {
        pincode,
        city: String(preferred.city || data.city || '').trim(),
        state: String(preferred.state || data.state || '').trim(),
        country: String(preferred.country || data.country || 'India').trim()
      }
      if (location.city) formElement.elements.city.value = location.city
      if (location.state) formElement.elements.state.value = location.state
      if (location.country) formElement.elements.country.value = location.country
      setPincodeLookupStatus({ state: 'verified', message: `Location found: ${[location.city, location.state, location.country].filter(Boolean).join(', ')}.` })
      return location
    } catch (error) {
      const requestIsCurrent = formElement?.isConnected && String(formElement.elements.pincode.value || '').trim() === pincode
      if (!requestIsCurrent) return null
      pincodeLookupAttemptRef.current = ''
      setPincodeLookupStatus({ state: 'manual', message: error.message || 'Enter the city, state, and country manually.' })
      return null
    }
  }
  const handlePincodeInput = event => {
    const input = event.currentTarget
    const formElement = input.form
    const pincode = input.value.trim()
    pincodeLookupAttemptRef.current = ''
    setPincodeLookupStatus({ state: 'idle', message: '' })
    if (formElement) {
      formElement.elements.city.value = ''
      formElement.elements.state.value = ''
      formElement.elements.country.value = 'India'
    }
    window.clearTimeout(pincodeLookupTimerRef.current)
    if (/^\d{6}$/.test(pincode)) pincodeLookupTimerRef.current = window.setTimeout(() => lookupPincode(pincode, formElement), 300)
  }
  const handlePincodeBlur = event => {
    window.clearTimeout(pincodeLookupTimerRef.current)
    lookupPincode(event.currentTarget.value, event.currentTarget.form)
  }
  const verifyOrderGst = async (value, formElement) => {
    const gstin = String(value || '').trim().toUpperCase().replace(/\s+/g, '')
    if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin) || user?.profile) return
    if (gstLookupAttemptRef.current === gstin) return
    gstLookupAttemptRef.current = gstin
    setGstLookupStatus({ state: 'checking', message: 'Checking GST registration…' })
    try {
      const response = await fetch(`${API}/gst/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gstin }) })
      const data = await response.json()
      const requestIsCurrent = formElement?.isConnected && String(formElement.elements.gstNumber.value || '').trim().toUpperCase().replace(/\s+/g, '') === gstin
      if (!requestIsCurrent) return null
      if (data.verified) {
        formElement.elements.shopName.value = data.registeredName
        formElement.elements.shopAddress.value = data.address
        if (data.pincode) {
          formElement.elements.pincode.value = data.pincode
          pincodeLookupAttemptRef.current = ''
          lookupPincode(data.pincode, formElement, { city: data.city, state: data.state, country: data.country || 'India' })
        }
        if (data.city) formElement.elements.city.value = data.city
        if (data.state) formElement.elements.state.value = data.state
        formElement.elements.country.value = data.country || 'India'
        setGstVerification({ gstin, proof: data.proof, registeredName: data.registeredName, address: data.address, pincode: data.pincode, city: data.city, state: data.state, country: data.country || 'India' })
        setGstLookupStatus({ state: 'verified', message: `Verified as ${data.registeredName}${data.status ? ` · ${data.status}` : ''}. Shop name, address, and GSTIN are locked.` })
        return { proof: data.proof }
      } else if (!response.ok || !data.verified) {
        const messages = {
          not_configured: 'We could not verify this GSTIN automatically. Please enter your shop details manually.',
          not_found: 'We could not find this GSTIN. Please check the number or enter your shop details manually.',
          quota: 'GST verification is temporarily unavailable. Please enter your shop details manually.',
          configuration: 'GST verification is temporarily unavailable. Please enter your shop details manually.',
          unavailable: 'GST verification is temporarily unavailable. Please enter your shop details manually.'
        }
        setGstVerification(null)
      setGstLookupStatus({ state: 'manual', message: messages[data.reason] || 'We could not verify this GSTIN automatically. Please enter your shop details manually.' })
        return null
      }
    } catch {
      const requestIsCurrent = formElement?.isConnected && String(formElement.elements.gstNumber.value || '').trim().toUpperCase().replace(/\s+/g, '') === gstin
      if (!requestIsCurrent) return null
      setGstVerification(null)
      setGstLookupStatus({ state: 'manual', message: 'GST verification is temporarily unavailable. Please enter your shop details manually.' })
      return null
    }
    return null
  }
  const handleGstNumberInput = event => {
    const input = event.currentTarget
    const gstin = input.value.trim().toUpperCase().replace(/\s+/g, '')
    if (gstin !== gstLookupAttemptRef.current) {
      gstLookupAttemptRef.current = ''
      setGstVerification(null)
      setGstLookupStatus({ state: 'idle', message: '' })
    }
    window.clearTimeout(gstLookupTimerRef.current)
    if (!user?.profile && /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) {
      const formElement = input.form
      gstLookupTimerRef.current = window.setTimeout(() => verifyOrderGst(gstin, formElement), 500)
    }
  }
  const handleGstNumberBlur = event => {
    window.clearTimeout(gstLookupTimerRef.current)
    verifyOrderGst(event.currentTarget.value, event.currentTarget.form)
  }
  const showPaymentSuccess = details => { setPaymentSuccess(details); setPage('payment-success'); setMenuOpen(false); notifyActionSuccess('Payment received. Your receipt and confirmation email are ready.'); window.scrollTo({ top: 0, behavior: 'smooth' }) }
  const cashfreeReturnOrderId = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('cashfree_order_id') || '' : ''
  const cashfreeReturnOrder = cashfreeReturnOrderId
    ? clientOrders.find(order => (order.payments || []).some(payment => payment.provider === 'Cashfree' && payment.cashfreeOrderId === cashfreeReturnOrderId))
    : null
  const cashfreeReturnBatchPayment = cashfreeReturnOrderId
    ? clientOrders.flatMap(order => (order.payments || []).filter(payment => payment.provider === 'Cashfree' && payment.cashfreeOrderId === cashfreeReturnOrderId && payment.batchId).map(payment => ({ order, payment })))[0]
    : null
  useEffect(() => {
    if (user?.role !== 'client' || !user.token || !cashfreeReturnOrderId || !cashfreeReturnOrder) return
    const returnKey = `${user.token}:${cashfreeReturnOrderId}`
    if (cashfreeReturnHandledRef.current === returnKey) return
    cashfreeReturnHandledRef.current = returnKey
    const params = new URLSearchParams(window.location.search)
    params.delete('cashfree_order_id')
    const query = params.toString()
    window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`)
    let cancelled = false
    const reconcileReturnedCheckout = async () => {
      try {
        const response = await fetch(cashfreeReturnBatchPayment
          ? `${API}/client/payment-batches/${encodeURIComponent(cashfreeReturnBatchPayment.payment.batchId)}/reconcile`
          : `${API}/client/orders/${encodeURIComponent(cashfreeReturnOrder.id)}/cashfree-reconcile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
          ...(!cashfreeReturnBatchPayment ? { body: JSON.stringify({ cashfreeOrderId: cashfreeReturnOrderId }) } : {})
        })
        const data = await readApiJson(response, 'Cashfree returned you to the portal, but payment status could not be refreshed yet.')
        if (!response.ok) throw new Error(data.error || 'Could not confirm the Cashfree payment yet.')
        if (cancelled) return
        if (cashfreeReturnBatchPayment) {
          setClientOrders(current => current.map(order => data.orders?.find(updated => updated.id === order.id) || order))
          if (data.status === 'Paid') {
            const allocations = data.allocations || []
            if (allocations.some(allocation => allocation.refundSummary)) setClientOrderNotice('The combined payment was allocated by order. A cancelled order allocation is being refunded.')
            else showPaymentSuccess({ batchId: data.batchId, provider: data.provider, allocations, total: allocations.reduce((sum, item) => sum + Number(item.payment?.amount || 0), 0), emailStatus: data.emailStatus })
          } else if (data.status === 'Failed') setClientOrderNotice('Cashfree did not complete this combined payment. The order balances remain outstanding.')
          else setClientOrderNotice('Cashfree is still confirming this combined payment. The balances will update as soon as it is verified.')
        } else {
          setClientOrders(current => current.map(order => order.id === data.order.id ? data.order : order))
          if (data.payment?.status === 'Paid' && !data.refundSummary) {
            showPaymentSuccess({ order: data.order, payment: data.payment, emailStatus: data.emailStatus })
          } else if (data.payment?.status === 'Paid') {
            setClientOrderNotice(`Payment arrived after cancellation. ${data.refundSummary}`)
          } else if (data.payment?.status === 'Failed') {
            setClientOrderNotice(data.payment.failureReason || 'Cashfree did not complete this payment. You can retry from your orders.')
          } else {
            setClientOrderNotice('Cashfree is still confirming this payment. Your balance will update as soon as the payment is verified.')
          }
        }
      } catch (error) {
        if (!cancelled) setClientOrderNotice(error.message || 'Cashfree payment status is still being reconciled.')
      }
    }
    reconcileReturnedCheckout()
    return () => { cancelled = true }
  }, [user?.role, user?.token, cashfreeReturnOrderId, cashfreeReturnOrder?.id, cashfreeReturnBatchPayment?.payment.batchId])
  const logout = async () => {
    if (user?.token) await fetch(`${API}/logout`, { method: 'POST', headers: { Authorization: `Bearer ${user.token}` } }).catch(() => {})
    setExternalPortal(null); setUser(null); setPaymentSuccess(null); go('home')
  }
  const login = async (e) => {
    e.preventDefault(); setBusy(true); setNotice(''); setNoticeIsError(false)
    const form = new FormData(e.currentTarget)
    try {
      const body = { identifier: form.get('identifier'), password: form.get('password'), role }
      if (role === 'client') {
        body.termsAccepted = form.get('termsAccepted') === 'on'
        if (!loginCaptcha?.challengeId) throw new Error('Wait for the CAPTCHA code to load, then try again.')
        body.captchaId = loginCaptcha.challengeId
        body.captchaAnswer = loginCaptchaAnswer
      }
      const requestBody = JSON.stringify(body)
      const response = await fetch(`${API}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: requestBody, signal: AbortSignal.timeout(9000) })
      const data = await response.json().catch(() => null)
      if (!data) {
        if (response.status === 502 || response.status === 503) throw new Error('The sign-in API is unavailable. It could not connect to MongoDB Atlas; check Atlas Network Access and restart the portal server.')
        throw new Error(`The sign-in service returned an invalid response (HTTP ${response.status}). Please restart the portal server and try again.`)
      }
      if (!response.ok) throw new Error(data.error || 'Sign-in failed.')
      setUser(data.user); setClientTab('overview'); setAdminTab('overview'); setPaymentSuccess(null); go(data.user.role === 'admin' ? 'admin' : 'client'); notifyActionSuccess('You are signed in successfully.')
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      const unreachable = err instanceof TypeError
      setNotice(timedOut ? 'Sign-in is taking too long. Check the portal server and database connection, then try again.' : unreachable ? 'The portal API is unavailable. Start the portal with npm run dev and try again.' : err.message || 'Could not connect to the portal. Please try again.')
      setNoticeIsError(true)
      if (role === 'client') {
        setLoginCaptchaAnswer('')
        setLoginCaptchaRevision(value => value + 1)
      }
    } finally { setBusy(false) }
  }
  const changeLoginRole = nextRole => {
    if (nextRole === role) return
    setRole(nextRole)
    setClientTermsAccepted(false)
    setNotice('')
    setNoticeIsError(false)
  }
  const submitOrder = async (e) => {
    e.preventDefault()
    if (!orderIntakeSettings.enabled) { setNotice(orderIntakeSettings.message); setNoticeIsError(true); return }
    const quickClientOrder = user?.role === 'client' && user.profile
    if (!quickClientOrder && indiaMartCustomer !== 'yes') { setNotice('Select Yes for IndiaMART customer to unlock and submit the order form.'); setNoticeIsError(true); return }
    if (quickClientOrder && user.profile.indiaMartCustomer === false) { setNotice('This profile is marked as not being an IndiaMART customer, so online orders are locked.'); setNoticeIsError(true); return }
    if (!quickClientOrder && gstLookupStatus.state === 'checking') { setNotice('Please wait for GST verification to finish, or complete the details manually if it is unavailable.'); setNoticeIsError(true); return }
    if (!quickClientOrder && businessType === 'Partnership' && (!authorizedSignatoryPartner || !selectedPartnerDocumentsReady)) {
      setNotice('Upload the selected partner’s photo and signature before submitting this order.')
      setNoticeIsError(true)
      setPartnerUploadOpen(true)
      return
    }
    setBusy(true); setNotice(''); setNoticeIsError(false)
    const formElement = e.currentTarget
    try {
      let payload
      if (quickClientOrder) {
        const profile = user.profile
        const signatory = profile.authorizedSignatoryName || (profile.businessType === 'Partnership' ? profile.partnerOne : profile.ownerName)
        payload = {
          ownerName: profile.ownerName || '', email: profile.email || user.email || '', mobile: profile.mobile || '',
          shopName: profile.shopName || '', businessType: profile.businessType || 'Sole proprietorship',
          partnerOne: profile.partnerOne || '', partnerTwo: profile.partnerTwo || '',
          authorizedSignatoryName: signatory || '',
          partnerDocumentSignatory: profile.businessType === 'Partnership' ? (signatory || '') : '',
          shopAddress: profile.shopAddress || '', pincode: profile.pincode || '', city: profile.city || '',
          state: profile.state || '', country: profile.country || 'India', gstNumber: profile.gstNumber || '',
          indiaMartCustomer: profile.indiaMartCustomer !== false,
          drugLicenseNumber: profile.drugLicenseNumber || '', drugLicenseExpiresAt: profile.drugLicenseExpiresAt || '',
          items: items.map(item => ({ name: item.name.trim(), quantity: item.quantity.trim() })),
          remarks: '', declarationAccepted: true, attachments: {}
        }
      } else {
        let gstProof = gstVerification?.proof
        const currentGstin = String(formElement.elements.gstNumber.value || '').trim().toUpperCase().replace(/\s+/g, '')
        if (!user?.profile && !gstProof && /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(currentGstin) && !gstLookupAttemptRef.current) {
          window.clearTimeout(gstLookupTimerRef.current)
          const verification = await verifyOrderGst(currentGstin, formElement)
          gstProof = verification?.proof || null
        }
        const form = new FormData(formElement)
        const signatureFile = formElement.elements.signature.files[0]
        const signatureKey = signatureFile ? `${signatureFile.name}|${signatureFile.size}|${signatureFile.lastModified}` : ''
        const savedAttachments = user?.profile?.attachments || {}
        const mayReuseSavedSignatoryDocuments = businessType !== 'Partnership' || savedPartnerDocumentsMatch
        const [profilePhoto, drugLicense, gstCopy, signature] = await Promise.all([
          encodeUpload(formElement.elements.profilePhoto.files[0], businessType === 'Partnership' ? 'Partner photo' : 'Owner photo', ['image/jpeg', 'image/png']).then(upload => upload || (mayReuseSavedSignatoryDocuments ? savedAttachments.ownerPhoto || savedAttachments.profilePhoto || null : null)),
          encodeUpload(formElement.elements.drugLicense.files[0], 'Drug license', ['application/pdf', 'image/jpeg']).then(upload => upload || savedAttachments.drugLicense || null),
          encodeUpload(formElement.elements.gstCopy.files[0], 'GST copy', ['application/pdf', 'image/jpeg']).then(upload => upload || savedAttachments.gstCopy || null),
          signatureFile ? (signaturePreview?.key === signatureKey ? signaturePreview.upload : extractSignature(signatureFile)) : Promise.resolve(mayReuseSavedSignatoryDocuments ? savedAttachments.signature || null : null)
        ])
        payload = {
          ownerName: form.get('ownerName'), email: form.get('email'), mobile: form.get('mobile'),
          shopName: form.get('shopName'), businessType: form.get('businessType'),
          partnerOne: form.get('partnerOne'), partnerTwo: form.get('partnerTwo'),
          authorizedSignatoryName: form.get('businessType') === 'Partnership'
            ? (form.get('authorizedSignatoryPartner') === 'partnerTwo' ? form.get('partnerTwo') : form.get('partnerOne'))
            : form.get('ownerName'),
          partnerDocumentSignatory: businessType === 'Partnership' ? selectedPartnerName : '',
          shopAddress: form.get('shopAddress'), pincode: form.get('pincode'), city: form.get('city'),
          state: form.get('state'), country: form.get('country'), gstNumber: form.get('gstNumber'),
          indiaMartCustomer: form.get('indiaMartCustomer') === 'yes',
          gstVerificationProof: gstProof, drugLicenseNumber: form.get('drugLicenseNumber'),
          drugLicenseExpiresAt: form.get('drugLicenseExpiresAt'),
          items: items.map(item => ({ name: item.name.trim(), quantity: item.quantity.trim() })),
          remarks: form.get('remarks'), declarationAccepted: form.get('declarationAccepted') === 'on',
          attachments: { profilePhoto, drugLicense, gstCopy, signature }
        }
      }
      const headers = { 'Content-Type': 'application/json' }
      if (user?.token && ['client', 'admin'].includes(user.role)) headers.Authorization = `Bearer ${user.token}`
      const response = await fetch(`${API}/orders`, { method: 'POST', headers, body: JSON.stringify(payload) })
      const data = await response.json(); if (!response.ok) throw new Error(data.error)
      const downloaded = downloadPdfDataUrl(data.latestLedgerPdf)
      const emailMessage = data.emailStatus === 'needs_configuration'
        ? ' Email sending needs mail service setup.'
        : ' The PDF was emailed or queued for delivery.'
      setNotice(`Order ${data.order.id} submitted and is waiting for admin approval.${downloaded ? ' Your order and profile PDF was downloaded.' : ''}${emailMessage}`); formElement.reset()
      notifyActionSuccess(`Order ${data.order.id} submitted and is awaiting admin approval.`)
      setItems([{ name: '', quantity: '' }])
      if (!quickClientOrder) setIndiaMartCustomer('')
      if (quickClientOrder) setBulkImportReset(value => value + 1)
      setBusinessType('')
      setPartnerOneName(''); setPartnerTwoName(''); setAuthorizedSignatoryPartner('')
      setPartnerUploadOpen(false); setPartnerPhotoReady(false); setPartnerPhotoFileName('')
      setGstVerification(null); setGstLookupStatus({ state: 'idle', message: '' }); gstLookupAttemptRef.current = ''
      setPincodeLookupStatus({ state: 'idle', message: '' }); pincodeLookupAttemptRef.current = ''; window.clearTimeout(pincodeLookupTimerRef.current)
      setSignaturePreview(null); setSignatureError('')
      if (user?.role === 'admin') {
        setOrders(prev => [data.order, ...prev])
        setProfiles(prev => {
          const existingIndex = prev.findIndex(profile => profile.id === data.profile.id)
          return existingIndex === -1
            ? [data.profile, ...prev]
            : prev.map((profile, index) => index === existingIndex ? data.profile : profile)
        })
      } else if (user?.role === 'client') {
        setUser(current => ({ ...current, profile: data.profile, name: data.profile.ownerName || data.profile.shopName, email: data.profile.email }))
        setClientOrders(prev => [data.order, ...prev])
      }
    } catch (err) { setNotice(err.message || 'Could not send your request. Is the API server running?'); setNoticeIsError(true) } finally { setBusy(false) }
  }
  const updateItem = (index, field, value) => {
    setItems(prev => prev.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item))
  }
  const prepareSignature = async event => {
    const file = event.currentTarget.files?.[0]
    setSignaturePreview(null); setSignatureError('')
    if (!file) return
    setProcessingSignature(true)
    try {
      const upload = await extractSignature(file)
      setSignaturePreview({ key: `${file.name}|${file.size}|${file.lastModified}`, upload })
    } catch (err) {
      setSignatureError(err.message || 'Could not extract the signature.')
    } finally { setProcessingSignature(false) }
  }
  const clearPartnerDocumentUploads = form => {
    for (const name of ['profilePhoto', 'signature']) {
      const input = form?.elements.namedItem(name)
      if (input) input.value = ''
    }
    setPartnerPhotoReady(false); setPartnerPhotoFileName('')
    setSignaturePreview(null); setSignatureError('')
  }
  const changeOrderBusinessType = event => {
    clearPartnerDocumentUploads(event.currentTarget.form)
    setBusinessType(event.target.value)
    setAuthorizedSignatoryPartner('')
    setPartnerUploadOpen(false)
  }
  const chooseAuthorizedPartner = event => {
    const value = event.target.value
    if (value !== authorizedSignatoryPartner) {
      clearPartnerDocumentUploads(event.currentTarget.form)
    }
    setAuthorizedSignatoryPartner(value)
    setNotice(''); setNoticeIsError(false)
    if (value) setPartnerUploadOpen(true)
  }
  const updateOrderStatus = async (orderId, status) => {
    setUpdatingOrder(orderId)
    setOrderNotice('')
    try {
      const response = await fetch(`${API}/orders/${encodeURIComponent(orderId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
        body: JSON.stringify({ status })
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not update this request.')
      if (data.deleted) {
        setOrders(prev => prev.filter(order => order.id !== orderId))
        if (data.profile) setProfiles(prev => prev.map(profile => profile.id === data.profile.id ? data.profile : profile))
        if (data.trash) setTrash(prev => [data.trash, ...prev.filter(item => item.id !== data.trash.id)])
        setOrderNotice(`Order ${orderId} was rejected and moved to the trash bin for 30 days.`)
        notifyActionSuccess(`Order ${orderId} rejected and moved to the recovery bin.`)
      } else {
        setOrders(prev => prev.map(order => order.id === orderId ? data.order : order))
        notifyActionSuccess(`Order ${orderId} ${status === 'Approved' ? 'approved' : `updated to ${status.toLowerCase()}`}.`)
      }
    } catch (err) {
      setOrderNotice(err.message || 'Could not update this request.')
    } finally {
      setUpdatingOrder('')
    }
  }
  const updateClientAccess = async profile => {
    const blocked = !Boolean(profile.accessBlocked)
    setUpdatingClientAccess(profile.id)
    setOrderNotice('')
    try {
      const response = await fetch(`${API}/admin/profiles/${encodeURIComponent(profile.id)}/access`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
        body: JSON.stringify({ blocked })
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not update client access.')
      setProfiles(current => current.map(item => item.id === data.profile.id ? data.profile : item))
      notifyActionSuccess(blocked ? `${profile.shopName} portal access blocked.` : `${profile.shopName} portal access restored.`)
    } catch (error) {
      setOrderNotice(error.message || 'Could not update client access.')
    } finally {
      setUpdatingClientAccess('')
    }
  }
  const cancelAdminOrder = async orderId => {
    if (!window.confirm(`Cancel order ${orderId}? Any confirmed Razorpay or Cashfree payment will be submitted for an automatic refund.`)) return
    setUpdatingOrder(orderId); setOrderNotice('')
    try {
      const response = await fetch(`${API}/orders/${encodeURIComponent(orderId)}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${user.token}` } })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not cancel this order.')
      setOrders(prev => prev.map(order => order.id === orderId ? data.order : order))
      const message = `Order ${orderId} cancelled. ${data.refundSummary || ''}`.trim()
      setOrderNotice(message)
      notifyActionSuccess(message)
    } catch (error) { setOrderNotice(error.message || 'Could not cancel this order.') }
    finally { setUpdatingOrder('') }
  }
  const deleteAdminOrder = async orderId => {
    if (!window.confirm(`Move order ${orderId} to the admin trash bin for 30 days?`)) return
    setUpdatingOrder(orderId); setOrderNotice('')
    try {
      const response = await fetch(`${API}/orders/${encodeURIComponent(orderId)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${user.token}` } })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not move this order to trash.')
      setOrders(prev => prev.filter(order => order.id !== orderId))
      if (data.profile) setProfiles(prev => prev.map(profile => profile.id === data.profile.id ? data.profile : profile))
      if (data.trash) setTrash(prev => [data.trash, ...prev.filter(item => item.id !== data.trash.id)])
      setOrderNotice(`Order ${orderId} moved to trash. It will be deleted permanently after 30 days unless restored.`)
      notifyActionSuccess(`Order ${orderId} moved to the recovery bin.`)
    } catch (err) { setOrderNotice(err.message || 'Could not move this order to trash.') }
    finally { setUpdatingOrder('') }
  }
  const deleteAdminProfile = async profile => {
    if (!window.confirm(`Move ${profile.shopName} and all ${profile.orderIds?.length || 0} active order(s) to the admin trash bin for 30 days?`)) return
    setTrashAction(profile.id); setOrderNotice('')
    try {
      const response = await fetch(`${API}/profiles/${encodeURIComponent(profile.id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${user.token}` } })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not move this profile to trash.')
      setProfiles(prev => prev.filter(item => item.id !== profile.id))
      setOrders(prev => prev.filter(order => order.profileId !== profile.id))
      if (data.trash) setTrash(prev => [data.trash, ...prev.filter(item => item.id !== data.trash.id)])
      setOrderNotice(`${profile.shopName} and its active orders moved to trash for 30 days.`)
      notifyActionSuccess(`${profile.shopName} and its orders moved to the recovery bin.`)
    } catch (err) { setOrderNotice(err.message || 'Could not move this profile to trash.') }
    finally { setTrashAction('') }
  }
  const restoreTrashItem = async item => {
    setTrashAction(item.id); setOrderNotice('')
    try {
      const response = await fetch(`${API}/trash/${encodeURIComponent(item.id)}/restore`, { method: 'POST', headers: { Authorization: `Bearer ${user.token}` } })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not restore this record.')
      if (data.profile) setProfiles(prev => prev.some(profile => profile.id === data.profile.id) ? prev.map(profile => profile.id === data.profile.id ? data.profile : profile) : [data.profile, ...prev])
      const restoredOrders = data.orders || (data.order ? [data.order] : [])
      if (restoredOrders.length) setOrders(prev => [...restoredOrders.filter(order => !prev.some(current => current.id === order.id)), ...prev])
      setTrash(prev => prev.filter(record => !(data.deletedIds || [item.id]).includes(record.id)))
      setOrderNotice(`${item.label} restored to active records.`)
      notifyActionSuccess(`${item.label} restored successfully.`)
    } catch (err) { setOrderNotice(err.message || 'Could not restore this record.') }
    finally { setTrashAction('') }
  }
  const permanentlyDeleteTrashItem = async item => {
    if (!window.confirm(`Permanently delete ${item.label}? This cannot be undone.`)) return
    setTrashAction(item.id); setOrderNotice('')
    try {
      const response = await fetch(`${API}/trash/${encodeURIComponent(item.id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${user.token}` } })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not permanently delete this record.')
      setTrash(prev => prev.filter(record => !(data.deletedIds || [item.id]).includes(record.id)))
      setOrderNotice(`${item.label} permanently deleted.`)
      notifyActionSuccess(`${item.label} permanently deleted.`)
    } catch (err) { setOrderNotice(err.message || 'Could not permanently delete this record.') }
    finally { setTrashAction('') }
  }
  const deleteClientProfile = async () => {
    const profile = user?.profile
    if (!profile || !window.confirm(`Delete your profile and move it with all ${clientOrders.length} active order(s) to the agency admin's 30-day recovery bin?`)) return
    setDeletingProfile(true); setClientOrderNotice('')
    try {
      const response = await fetch(`${API}/profile`, { method: 'DELETE', headers: { Authorization: `Bearer ${user.token}` } })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not delete your profile.')
      setClientOrders([]); setUser(null); setRole('client'); setNoticeIsError(false)
      setNotice('Your profile and active orders were moved to the agency recovery bin for 30 days.')
      notifyActionSuccess('Your profile was moved to the recovery bin for 30 days.')
      go('login')
    } catch (err) { setClientOrderNotice(err.message || 'Could not delete your profile.') }
    finally { setDeletingProfile(false) }
  }
  const downloadProfileDocuments = async (profile = null) => {
    const target = profile?.id || 'all'
    setDownloadingArchive(target); setOrderNotice('')
    try {
      const { RarWriter } = await import('@bitplane/rars')
      const selectedProfiles = profile ? [profile] : profiles
      const writer = new RarWriter({ format: 'rar50', level: 5 })
      const documents = [
        ['Owner photo', 'ownerPhoto', item => item.attachments?.ownerPhoto],
        ['Authorized signature', 'signature', item => item.attachments?.signature],
        ['Drug license', 'drugLicense', item => item.attachments?.drugLicense],
        ['GST copy', 'gstCopy', item => item.attachments?.gstCopy]
      ]
      let fileCount = 0
      for (const item of selectedProfiles) {
        const shopName = safeArchiveName(item.shopName)
        const folderName = `${shopName} (${safeArchiveName(item.id)})`
        const availableDocuments = documents.map(([label, key, getUpload]) => ({ label, key, upload: getUpload(item) })).filter(document => document.upload?.name && document.upload?.type)
        const archiveFiles = await Promise.all(availableDocuments.map(async ({ label, key, upload }) => {
          let bytes
          if (upload.data?.startsWith('data:')) bytes = uploadBytes(upload)
          else {
            const response = await fetch(`${API}/profiles/${encodeURIComponent(item.id)}/documents/${key}`, { cache: 'force-cache', headers: { Authorization: `Bearer ${user.token}` } })
            if (!response.ok) throw new Error(`Could not retrieve ${label.toLowerCase()} for ${item.shopName}.`)
            bytes = new Uint8Array(await (await response.blob()).arrayBuffer())
          }
          return { label, upload, bytes }
        }))
        for (const { label, upload, bytes } of archiveFiles) {
          const archivePath = `${folderName}/${shopName} - ${label}.${uploadExtension(upload)}`
          writer.add(archivePath, bytes, { modifiedAt: new Date(item.updatedAt || item.createdAt || Date.now()) })
          fileCount++
        }
      }
      if (!fileCount) throw new Error('No profile documents are available to download.')
      const bytes = await writer.bytes()
      const blob = new Blob([bytes], { type: 'application/vnd.rar' })
      const link = document.createElement('a')
      const archiveName = profile ? `${profile.shopName}.rar` : 'Gouri Agency - Customer Profile Documents.rar'
      link.href = URL.createObjectURL(blob)
      link.download = safeArchiveName(archiveName.replace(/\.rar$/i, '')) + '.rar'
      document.body.appendChild(link); link.click(); link.remove()
      window.setTimeout(() => URL.revokeObjectURL(link.href), 1000)
      notifyActionSuccess('Profile documents downloaded successfully.')
    } catch (err) {
      setOrderNotice(err.message || 'Could not download these documents.')
    } finally { setDownloadingArchive('') }
  }
  const hasProfileDocuments = profile => Boolean(profile.attachments?.ownerPhoto || profile.attachments?.signature || profile.attachments?.drugLicense || profile.attachments?.gstCopy)
  const normalizedProfileSearch = profileSearch.trim().toLowerCase()
  const normalizedProfileGstSearch = profileSearch.trim().toUpperCase().replace(/\s+/g, '')
  const normalizedProfilePhoneSearch = profileSearch.replace(/\D/g, '')
  const visibleProfiles = profiles.filter(profile => !normalizedProfileSearch ||
    [profile.shopName, profile.ownerName, profile.email, profile.partnerOne, profile.partnerTwo]
      .some(value => String(value || '').toLowerCase().includes(normalizedProfileSearch)) ||
    (normalizedProfileGstSearch && String(profile.gstNumber || '').toUpperCase().replace(/\s+/g, '').includes(normalizedProfileGstSearch)) ||
    (normalizedProfilePhoneSearch && String(profile.mobile || '').replace(/\D/g, '').includes(normalizedProfilePhoneSearch))
  )
  const normalizedAdminOrderSearch = adminOrderSearch.trim().toLowerCase()
  const visibleAdminOrders = orders.filter(order => !normalizedAdminOrderSearch || [
    order.id, order.shopName, order.ownerName, order.email, order.mobile, order.gstNumber,
    ...(order.items || []).map(item => item.name)
  ].some(value => String(value || '').toLowerCase().includes(normalizedAdminOrderSearch)))
  const normalizedTrashSearch = trashSearch.trim().toLowerCase()
  const normalizedTrashPhoneSearch = trashSearch.replace(/\D/g, '')
  const visibleTrash = trash.filter(item => !normalizedTrashSearch ||
    [item.label, item.orderId, item.profileId, item.email, item.mobile, item.gstNumber, ...(item.orderIds || [])]
      .some(value => String(value || '').toLowerCase().includes(normalizedTrashSearch)) ||
    (normalizedTrashPhoneSearch && String(item.mobile || '').replace(/\D/g, '').includes(normalizedTrashPhoneSearch))
  )
  const visibleOrdersForProfile = profileId => {
    const query = String(profileOrderSearch[profileId] || '').trim().toLowerCase()
    return orders.filter(order => order.profileId === profileId && (!query || [
      order.id, order.shopName, order.ownerName, order.partnerOne, order.partnerTwo,
      ...(order.items || []).map(item => item.name)
    ].some(value => String(value || '').toLowerCase().includes(query))))
  }
  const inProgressClientOrders = clientOrders.filter(order => ['In progress', 'Pending approval'].includes(order.status) && !order.approvedAt)
  const activeClientOrders = clientOrders.filter(order => order.status !== 'Cancelled' && !(['In progress', 'Pending approval'].includes(order.status) && !order.approvedAt))
  const cancelledClientOrders = clientOrders.filter(order => order.status === 'Cancelled')

  return <>
    <div className="site-shell">
      <header className="topbar">
        <button className="brand" onClick={() => go('home')}><Mark /><span className="brand-text">GOURI <b>AGENCY</b></span></button>
        <button className="mobile-menu" onClick={() => setMenuOpen(!menuOpen)} aria-label={menuOpen ? 'Close menu' : 'Open menu'} aria-expanded={menuOpen}>{menuOpen ? <X /> : <Menu />}</button>
        <nav className={menuOpen ? 'open' : ''} aria-label="Main navigation">
          <button className={page === 'home' ? 'nav-active' : ''} aria-current={page === 'home' ? 'page' : undefined} onClick={() => go('home')}>Home</button>
          <button className={page === 'orders' ? 'nav-active' : ''} aria-current={page === 'orders' ? 'page' : undefined} onClick={() => go('orders')}>Order request</button>
          <button className={page === 'holidays' ? 'nav-active' : ''} aria-current={page === 'holidays' ? 'page' : undefined} onClick={() => go('holidays')}>Public holidays</button>
          <button className={page === 'pay-online' ? 'nav-active' : ''} aria-current={page === 'pay-online' ? 'page' : undefined} onClick={() => go('pay-online')}>Pay Online</button>
          <button className={page === 'contact' ? 'nav-active' : ''} aria-current={page === 'contact' ? 'page' : undefined} onClick={() => go('contact')}>Contact us</button>
          <button className={page === 'refund-policy' ? 'nav-active' : ''} aria-current={page === 'refund-policy' ? 'page' : undefined} onClick={() => go('refund-policy')}>Refund Policy</button>
          <button className={page === 'terms' ? 'nav-active' : ''} aria-current={page === 'terms' ? 'page' : undefined} onClick={() => go('terms')}>Terms &amp; Conditions</button>
          <button className={page === 'privacy' ? 'nav-active' : ''} aria-current={page === 'privacy' ? 'page' : undefined} onClick={() => go('privacy')}>Privacy Policy</button>
          {user ? <button className="nav-login" onClick={() => go(user.role === 'admin' ? 'admin' : 'client')}>{user.role === 'admin' ? 'Admin panel' : 'My workspace'} <ArrowRight size={14} /></button> : <button className="nav-login" onClick={() => go('login')}>Sign in <ArrowRight size={14} /></button>}
        </nav>
      </header>

      {page === 'orders' && user?.role !== 'client' && !orderDisclaimerAccepted && <OrderRequestDisclaimer onAgree={() => setOrderDisclaimerAccepted(true)} onDisagree={() => go('home')}/>}

      {page === 'home' && <HomeImageSlider/>}
      {page === 'holidays' && <main className="holiday-page"><PublicHolidayCalendar/></main>}
      {page === 'pay-online' && <PayOnlinePage/>}
      {page === 'home' && <main className="portal-home">
        <HomeNoticeBoard/>
        <section className="portal-welcome">
          <div className="eyebrow"><span className="live-dot" /> GOURI AGENCY PORTAL</div>
          <h1>We are here to<br /><em>serve you.</em></h1>
          <p>Submit an order request, sign in to your workspace, or manage incoming orders from one simple place.</p>
        </section>
        <section className="portal-links" aria-label="Portal shortcuts">
          <article className="portal-link-card">
            <span className="portal-step">01 / ORDER REQUEST</span>
            <div className="portal-link-icon"><Plus size={20} /></div>
            <h2>Submit an order</h2>
            <p>Add your shop details, medicine items, and required documents.</p>
            <button className="button dark portal-link-action" onClick={() => go('orders')}>Open order form <ArrowUpRight size={15} /></button>
          </article>
          <article className="portal-link-card">
            <span className="portal-step">02 / YOUR ACCOUNT</span>
            <div className="portal-link-icon"><ArrowRight size={20} /></div>
            <h2>{user ? 'Open your workspace' : 'Sign in'}</h2>
            <p>{user ? 'Continue to your client workspace or studio admin panel.' : 'Access your client workspace or sign in as a studio admin.'}</p>
            <button className="button outline portal-link-action" onClick={() => go(user ? (user.role === 'admin' ? 'admin' : 'client') : 'login')}>{user ? 'Open workspace' : 'Go to sign in'} <ArrowUpRight size={15} /></button>
          </article>
        </section>
      </main>}

      {page === 'contact' && <main className="inner-page contact-page">
        <div className="eyebrow"><span className="live-dot"/> GET IN TOUCH</div>
        <h1 className="inner-title">Contact <em>us.</em></h1>
        <p className="inner-lede">Reach the Gouri Agency team by phone, email, or visit our shop.</p>
        <div className="contact-grid">
          <section className="contact-card">
            <span className="contact-kicker">PHONE</span>
            <h2>Call our team</h2>
            <div className="contact-detail-list">{[
              ['8250589982', 'tel:+918250589982'],
              ['8250558137', 'tel:+918250558137'],
              ['7908911952', 'tel:+917908911952']
            ].map(([phone, href]) => <a key={phone} href={href}><span className="contact-method-value"><Phone size={15}/>{phone}</span><ArrowUpRight size={14}/></a>)}</div>
          </section>
          <section className="contact-card">
            <span className="contact-kicker">EMAIL</span>
            <h2>Contact by level</h2>
            <div className="contact-detail-list contact-email-list">
              <a href="mailto:gouriagency185@gmail.com"><span className="contact-email-value"><Mail size={15}/><span><small>LEVEL 1</small>gouriagency185@gmail.com</span></span><ArrowUpRight size={14}/></a>
              <a href="mailto:dbachchu@gmail.com"><span className="contact-email-value"><Mail size={15}/><span><small>LEVEL 2</small>dbachchu@gmail.com</span></span><ArrowUpRight size={14}/></a>
              <a href="mailto:upadhyayjagneswar@gmail.com"><span className="contact-email-value"><Mail size={15}/><span><small>LEVEL 3</small>upadhyayjagneswar@gmail.com</span></span><ArrowUpRight size={14}/></a>
            </div>
          </section>
          <section className="contact-card contact-whatsapp-card">
            <span className="contact-kicker">WHATSAPP</span>
            <h2>Chat with our team</h2>
            <div className="contact-detail-list">{[
              ['8250589982', '918250589982'],
              ['8250558137', '918250558137']
            ].map(([phone, whatsappNumber]) => <a key={phone} href={`https://wa.me/${whatsappNumber}?text=${encodeURIComponent('*Hi, I am an IndiaMART customer.*')}`} target="_blank" rel="noopener noreferrer"><span className="contact-method-value"><WhatsApp size={15}/>{phone}</span><ArrowUpRight size={14}/></a>)}</div>
          </section>
          <section className="contact-card contact-card-wide">
            <span className="contact-kicker">VISIT THE SHOP</span>
            <h2>Our address</h2>
            <p>1st Floor, Benachity Agrani Gali,<br/>Durgapur - 13, West Bengal,<br/>PIN - 713213</p>
          </section>
          <section className="contact-card contact-card-wide contact-hours-card">
            <span className="contact-kicker">SHOP HOURS</span>
            <h2>We’re open</h2>
            <ShopHours />
          </section>
        </div>
      </main>}

      {page === 'refund-policy' && <main className="inner-page policy-page">
        <div className="eyebrow"><span className="live-dot"/> CUSTOMER INFORMATION</div>
        <h1 className="inner-title">Refund <em>& return policy.</em></h1>
        <section className="policy-section">
          <h2>Refund &amp; Return Policy</h2>
          <p>At Gouri Agency, we maintain strict protocols regarding the wholesale distribution of medicinal products to ensure the safety, efficacy, and integrity of the pharmaceutical supply chain. Accordingly, all goods once sold are strictly non-returnable and non-refundable, and we do not accept returns, replacements, or credit notes for expired stock or post-delivery breakage. As an exception, if you receive a damaged shipment, a product with a broken manufacturer seal, or an incorrect item, you must report the issue to us within 24 hours of delivery along with clear photographic or video proof. Upon verification of your claim, a replacement will be processed within 15 business days, provided that the affected item is physically returned to us in its original packaging.</p>
        </section>
        <section className="policy-section">
          <h2>Terms of Sale</h2>
          <p>All wholesale pharmaceutical supply transactions with Gouri Agency are governed by strict quality assurance standards to maintain regulatory compliance across the supply chain. Buyers are responsible for inspecting all shipments immediately upon receipt for external damage, seal integrity, and product accuracy before signing the delivery receipt, after which the buyer assumes full responsibility for maintaining proper pharmaceutical storage conditions. By placing an order and accepting delivery from Gouri Agency, the buyer acknowledges and agrees to our final sale, non-returnable, and non-refundable policy.</p>
        </section>
      </main>}

      {page === 'terms' && <main className="inner-page policy-page terms-page">
        <div className="eyebrow"><span className="live-dot"/> CUSTOMER INFORMATION</div>
        <h1 className="inner-title">Terms &amp; <em>conditions.</em></h1>
        <section className="terms-notice">
          <strong>IMPORTANT</strong>
          <p>We are a licensed pharmaceutical wholesaler. We only sell to registered pharmacies, hospitals, and licensed medical practitioners with valid Drug Licenses (Form 20/21/20B/21B).</p>
        </section>
        <p className="terms-intro">These terms and conditions govern the wholesale distribution of pharmaceutical products by Gouri Agency. By engaging with our services, you acknowledge and agree to the following principles of professional reliability and administrative transparency.</p>
        <section className="policy-section terms-service-section">
          <h2>Service Terms</h2>
          <article className="terms-clause"><h3>1. Scope of Services</h3><p>Gouri Agency provides a comprehensive wholesale distribution network for essential medical supplies. Our services include logistics management, inventory coordination, and administrative support for wholesale distributors.</p></article>
          <article className="terms-clause"><h3>2. Professional Reliability</h3><p>We maintain a high standard of professional reliability in all our operations. This includes strict adherence to pharmaceutical supply chain regulations and the provision of transparent, accurate, and timely information to our clients.</p></article>
          <article className="terms-clause"><h3>3. Administrative Transparency</h3><p>Transparency is a cornerstone of our business model. We ensure that all administrative processes, including billing, payment terms, and distribution schedules, are clearly communicated and executed with absolute integrity.</p></article>
          <article className="terms-clause"><h3>4. Compliance &amp; Liability</h3><p>Gouri Agency is not liable for any direct or indirect damages arising from the use of our distribution services. All parties must comply with applicable laws and regulations governing the pharmaceutical industry.</p></article>
        </section>
        <section className="policy-section">
          <h2>Compliance &amp; Liability</h2>
          <p>Gouri Agency maintains the highest standards of regulatory compliance and professional integrity. Our wholesale distribution services are governed by strict pharmaceutical laws and industry regulations to ensure the safety and reliability of every supply chain transaction.</p>
        </section>
      </main>}

      {page === 'privacy' && <main className="privacy-page">
        <section className="privacy-data">
          <h1>Data Privacy</h1>
          <p>Gouri Agency uses distributor information to support its wholesale services. We collect contact and shop details, GST and Drug License information, order and payment records, and documents submitted through this portal. This information is used to process orders, coordinate services, and provide administrative support.</p>
        </section>
        <section className="privacy-security">
          <h2>Security &amp;<br/>Compliance</h2>
          <p className="privacy-lede">We support the integrity of the pharmaceutical supply chain through responsible data handling and clear account access information.</p>
          <div className="privacy-cards">
            <article className="privacy-card">
              <LockKeyhole size={36} strokeWidth={1.8}/>
              <h3>Data Storage</h3>
              <p>Submitted profiles, orders, payment records, and documents are stored by the portal server. Deleted records move to an admin recovery bin and are permanently removed after 30 days unless restored sooner.</p>
            </article>
            <article className="privacy-card">
              <ShieldCheck size={36} strokeWidth={1.8}/>
              <h3>Account Access</h3>
              <p>Admin actions require admin sign-in. Client access is matched using the registered email, phone number, or GST number entered at sign-in.</p>
            </article>
          </div>
        </section>
      </main>}

      {page === 'orders' && user?.role === 'client' && user.profile && <main className="inner-page order-page quick-client-order-page">
        <div className="eyebrow"><span className="live-dot"/> NEW CLIENT ORDER</div>
        <h1 className="inner-title">Place a new<br/><em>order.</em></h1>
        <p className="inner-lede">Add the medicines and quantities. Your saved shop profile and documents will be attached automatically.</p>
        {notice && <div className={`notice ${noticeIsError ? 'error' : ''}`} role={noticeIsError ? 'alert' : 'status'}>{noticeIsError ? <CircleHelp size={16}/> : <Check size={16}/>} {notice}</div>}
        {!orderIntakeSettings.enabled && <div className="order-intake-closed-notice" role="alert"><strong>ORDER REQUESTS ARE TEMPORARILY CLOSED</strong><span>{orderIntakeSettings.message}</span></div>}
        {user.profile.profileFrozen && <div className="license-freeze-alert" role="alert"><strong>Order access is frozen</strong><span>{user.profile.drugLicenseExpiryMissing ? 'The drug license expiry date is missing.' : `The drug license expired on ${user.profile.drugLicenseExpiresAt}.`} Ask an admin to record a valid expiry date before placing an order.</span></div>}
        <div className="quick-order-profile-summary"><strong>{user.profile.shopName}</strong><span>GSTIN: {user.profile.gstNumber}</span><small>Profile details, regulatory documents, and saved signature are reused for this order.</small></div>
        <form className="order-form quick-order-form" onSubmit={submitOrder}>
          <label className="indiamart-customer-field"><span className="required-field-label">Are you an IndiaMART customer? <RequiredMark/></span><span className="select-wrap"><select name="indiaMartCustomer" value={user.profile.indiaMartCustomer === false ? 'no' : 'yes'} disabled required><option value="yes">Yes</option><option value="no">No</option></select><ChevronDown size={15}/></span><small>This registration setting is fixed and cannot be edited in the client dashboard.</small></label>
          {user.profile.indiaMartCustomer === false && <div className="indiamart-customer-blocked" role="alert">Online order access is locked because this profile is marked “No” for IndiaMART customer status. Contact Gouri Agency.</div>}
          <fieldset className="order-form-fields" disabled={!orderIntakeSettings.enabled || Boolean(user.profile.profileFrozen) || user.profile.indiaMartCustomer === false}>
            <ClientBulkOrderUpload resetToken={bulkImportReset} disabled={!orderIntakeSettings.enabled || Boolean(user.profile.profileFrozen) || busy} onImport={importedItems => setItems(importedItems)}/>
            <section className="medicine-section" aria-label="Medicine items">
              <div className="medicine-heading"><div><h2>Medicine items</h2><p>Add a row for each medicine. Quantity can be boxes, pieces, or a combination.</p></div><button className="button outline add-item" type="button" onClick={() => setItems(prev => [...prev, { name: '', quantity: '' }])}><Plus size={15}/> Add item</button></div>
              <div className="medicine-table-head"><span>Medicine name <RequiredMark/></span><span>Quantity / pcs <RequiredMark/></span><span className="sr-only">Remove item</span></div>
              {items.map((item, index) => <div className="medicine-row" key={index}>
                <label className="sr-only" htmlFor={`quick-item-name-${index}`}>Medicine name {index + 1}</label>
                <input id={`quick-item-name-${index}`} value={item.name} onChange={event => updateItem(index, 'name', event.target.value)} placeholder="Medicine name" required />
                <label className="sr-only" htmlFor={`quick-item-quantity-${index}`}>Quantity or pieces for item {index + 1}</label>
                <input id={`quick-item-quantity-${index}`} type="text" inputMode="text" maxLength={60} value={item.quantity} onChange={event => updateItem(index, 'quantity', event.target.value)} placeholder="e.g. 10 boxes or 20 pcs" title="Enter a number, words, or both (up to 60 characters)." required />
                <button className="remove-item" type="button" aria-label={`Remove item ${index + 1}`} disabled={items.length === 1} onClick={() => setItems(prev => prev.filter((_, itemIndex) => itemIndex !== index))}><X size={15}/></button>
              </div>)}
            </section>
            <p className="quick-order-terms">Your registered profile agreement and order terms apply. Every order is submitted for admin approval.</p>
            <button className="button dark" disabled={!orderIntakeSettings.enabled || busy || Boolean(user.profile.profileFrozen) || user.profile.indiaMartCustomer === false}>{busy ? <LoadingAction loading label="Submitting order…"/> : <>Submit order for approval <ArrowUpRight size={16}/></>}</button>
          </fieldset>
        </form>
      </main>}

      {page === 'orders' && (user?.role === 'client' || orderDisclaimerAccepted) && !(user?.role === 'client' && user.profile) && <main className="inner-page order-page">
        <div className="eyebrow"><span className="live-dot"/> ORDER REQUEST</div>
        <h1 className="inner-title">Shop order<br /><em>details.</em></h1>
        <p className="inner-lede">Add your shop information, medicine items, and required documents.</p>
        {notice && <div className={`notice ${noticeIsError ? 'error' : ''}`} role={noticeIsError ? 'alert' : 'status'}>{noticeIsError ? <CircleHelp size={16} /> : <Check size={16} />}{notice}</div>}
        {!orderIntakeSettings.enabled && <div className="order-intake-closed-notice" role="alert"><strong>ORDER REQUESTS ARE TEMPORARILY CLOSED</strong><span>{orderIntakeSettings.message}</span></div>}
        <form className="order-form" onSubmit={submitOrder}>
          <label className="indiamart-customer-field"><span className="required-field-label">Are you an IndiaMART customer? <RequiredMark/></span><span className="select-wrap"><select name="indiaMartCustomer" value={user?.profile ? (user.profile.indiaMartCustomer === false ? 'no' : 'yes') : indiaMartCustomer} onChange={event => setIndiaMartCustomer(event.target.value)} disabled={Boolean(user?.profile) || !orderIntakeSettings.enabled} required><option value="" disabled>Select Yes or No</option><option value="yes">Yes</option><option value="no">No</option></select><ChevronDown size={15}/></span>{user?.profile ? <small>This profile setting is fixed and cannot be changed from the dashboard.</small> : <small>Select “Yes” to unlock the rest of the order form.</small>}</label>
          {!user?.profile && indiaMartCustomer === 'no' && <div className="indiamart-customer-blocked" role="alert">Online order requests are available only to IndiaMART customers. The remaining form is locked.</div>}
          {user?.role === 'client' && user.profile?.profileFrozen && <div className="license-freeze-alert" role="alert"><strong>Order access is frozen</strong><span>{user.profile.drugLicenseExpiryMissing ? 'The drug license expiry date is missing.' : `The drug license expired on ${user.profile.drugLicenseExpiresAt}.`} Update the license copy and number in your profile, then ask an admin to record a valid expiry date.</span></div>}
          <fieldset className="order-form-fields" disabled={!orderIntakeSettings.enabled || (!user?.profile && indiaMartCustomer !== 'yes')}>
          <div className="gst-verification-field">
            <label><span className="required-field-label">GST number <RequiredMark/></span><input name="gstNumber" placeholder="GSTIN" defaultValue={user?.profile?.gstNumber || ''} readOnly={Boolean(user?.profile || gstVerification)} onChange={handleGstNumberInput} onBlur={handleGstNumberBlur} required /></label>
            {gstLookupStatus.message && <small className={`gst-verification-note ${gstLookupStatus.state}`} role="status">{gstLookupStatus.message}</small>}
            {gstLookupStatus.state === 'manual' && !user?.profile && <button className="gst-retry-button" type="button" onClick={event => { const formElement = event.currentTarget.form; if (!formElement) return; gstLookupAttemptRef.current = ''; verifyOrderGst(formElement.elements.gstNumber.value, formElement) }}>Retry GST verification</button>}
          </div>
          <div className="form-row">
            <label><span className="required-field-label">Shop name <RequiredMark/></span><input name="shopName" placeholder="Registered shop name" defaultValue={user?.profile?.shopName || ''} readOnly={Boolean(gstVerification || user?.profile?.gstVerifiedAt)} required /></label>
            <label><span className="required-field-label">Shop address <RequiredMark/></span><textarea name="shopAddress" rows="2" placeholder="Full shop address" defaultValue={user?.profile?.shopAddress || ''} readOnly={Boolean(gstVerification || user?.profile?.gstVerifiedAt)} required /></label>
          </div>
          <div className="form-row location-fields">
            <label><span className="required-field-label">PIN code <RequiredMark/></span><input name="pincode" inputMode="numeric" autoComplete="postal-code" maxLength="6" pattern="[0-9]{6}" title="Enter a six-digit Indian PIN code." placeholder="Six-digit PIN code" defaultValue={user?.profile?.pincode || ''} readOnly={Boolean(gstVerification?.pincode)} onChange={handlePincodeInput} onBlur={handlePincodeBlur} required /></label>
            <label><span className="required-field-label">City / district <RequiredMark/></span><input name="city" autoComplete="address-level2" placeholder="City or district" defaultValue={user?.profile?.city || ''} required /></label>
          </div>
          <div className="form-row location-fields">
            <label><span className="required-field-label">State <RequiredMark/></span><input name="state" autoComplete="address-level1" placeholder="State" defaultValue={user?.profile?.state || ''} required /></label>
            <label><span className="required-field-label">Country <RequiredMark/></span><input name="country" autoComplete="country-name" placeholder="Country" defaultValue={user?.profile?.country || 'India'} required /></label>
          </div>
          {pincodeLookupStatus.message && <small className={`gst-verification-note ${pincodeLookupStatus.state}`} role="status">{pincodeLookupStatus.message}</small>}
          <label><span className="required-field-label">Business type <RequiredMark/></span><span className="select-wrap"><select name="businessType" value={businessType} onChange={changeOrderBusinessType} required><option value="" disabled>Select business type</option><option>Sole proprietorship</option><option>Partnership</option></select><ChevronDown size={15}/></span></label>
          {businessType === 'Sole proprietorship' && <label><span className="required-field-label">Shop owner name <RequiredMark/></span><input name="ownerName" placeholder="Shop owner's full name" defaultValue={user?.profile?.ownerName || ''} required /></label>}
          {businessType === 'Partnership' && <div className="form-row partner-fields">
            <label><span className="required-field-label">Partner 1 name <RequiredMark/></span><input name="partnerOne" placeholder="First partner's full name" value={partnerOneName} onChange={event => { setPartnerOneName(event.target.value); if (authorizedSignatoryPartner === 'partnerOne') { setAuthorizedSignatoryPartner(''); setPartnerUploadOpen(false); clearPartnerDocumentUploads(event.currentTarget.form) } }} required /></label>
            <label><span className="required-field-label">Partner 2 name <RequiredMark/></span><input name="partnerTwo" placeholder="Second partner's full name" value={partnerTwoName} onChange={event => { setPartnerTwoName(event.target.value); if (authorizedSignatoryPartner === 'partnerTwo') { setAuthorizedSignatoryPartner(''); setPartnerUploadOpen(false); clearPartnerDocumentUploads(event.currentTarget.form) } }} required /></label>
          </div>}
          {businessType === 'Partnership' && <><label><span className="required-field-label">Authorized signatory <RequiredMark/></span><span className="select-wrap"><select name="authorizedSignatoryPartner" value={authorizedSignatoryPartner} onChange={chooseAuthorizedPartner} required><option value="" disabled>Select the partner signing this order</option><option value="partnerOne" disabled={!partnerOneName.trim()}>Partner 1{partnerOneName.trim() ? ` — ${partnerOneName.trim()}` : ' — enter name above'}</option><option value="partnerTwo" disabled={!partnerTwoName.trim()}>Partner 2{partnerTwoName.trim() ? ` — ${partnerTwoName.trim()}` : ' — enter name above'}</option></select><ChevronDown size={15}/></span></label><div className={`partner-document-status${selectedPartnerDocumentsReady ? ' ready' : ''}`}><div><strong>{selectedPartnerName ? `Documents for ${selectedPartnerName}` : 'Partner verification documents'}</strong><span>{selectedPartnerDocumentsReady ? 'Partner photo and signature are ready for this order.' : 'Select the signing partner, then add their photo and signature.'}</span></div>{selectedPartnerName && <button type="button" className="button outline" onClick={() => setPartnerUploadOpen(true)}>{selectedPartnerDocumentsReady ? 'Review documents' : 'Upload documents'}</button>}</div></>}
          <div className="form-row">
            <label><span className="required-field-label">Email address <RequiredMark/></span><input name="email" type="email" autoComplete="email" placeholder="you@yourshop.com" defaultValue={user?.email || ''} required /></label>
            <label><span className="required-field-label">Mobile number <RequiredMark/></span><input name="mobile" type="tel" inputMode="tel" autoComplete="tel" placeholder="10-digit mobile number" defaultValue={user?.profile?.mobile || ''} pattern="[+]?[0-9 ()-]{10,20}" title="Enter a valid mobile number with 10 to 15 digits." required /></label>
          </div>
          <label><span className="required-field-label">Drug license number <RequiredMark/></span><input name="drugLicenseNumber" placeholder="Drug license number" defaultValue={user?.profile?.drugLicenseNumber || ''} readOnly={Boolean(user?.profile)} required /></label>
          <label><span className="required-field-label">Drug license expiry date <RequiredMark/></span><input type="date" name="drugLicenseExpiresAt" defaultValue={user?.profile?.drugLicenseExpiresAt || ''} readOnly={Boolean(user?.profile)} required /><small className="locked-field-note">Enter the expiry date printed on the license. Expired licenses cannot be used to submit an order.</small></label>
          <section className="medicine-section" aria-label="Medicine items">
            <div className="medicine-heading"><div><h2>Medicine items</h2><p>Add one row for each medicine.</p></div><button className="button outline add-item" type="button" onClick={() => setItems(prev => [...prev, { name: '', quantity: '' }])}><Plus size={15}/> Add item</button></div>
            <div className="medicine-table-head"><span>Item name <RequiredMark/></span><span>Quantity / pack <RequiredMark/></span><span className="sr-only">Remove item</span></div>
            {items.map((item, index) => <div className="medicine-row" key={index}>
              <label className="sr-only" htmlFor={`item-name-${index}`}>Item name {index + 1}</label>
              <input id={`item-name-${index}`} value={item.name} onChange={event => updateItem(index, 'name', event.target.value)} placeholder="Medicine name" required />
              <label className="sr-only" htmlFor={`item-quantity-${index}`}>Quantity or pack description for item {index + 1}</label>
              <input id={`item-quantity-${index}`} type="text" inputMode="text" maxLength={60} value={item.quantity} onChange={event => updateItem(index, 'quantity', event.target.value)} placeholder="e.g. 2 boxes" title="Enter a number, words, or both (up to 60 characters)." required />
              <button className="remove-item" type="button" aria-label={`Remove item ${index + 1}`} disabled={items.length === 1} onClick={() => setItems(prev => prev.filter((_, itemIndex) => itemIndex !== index))}><X size={15}/></button>
            </div>)}
          </section>
          <section className="order-declaration" aria-labelledby="order-declaration-title">
            <div className="order-declaration-copy">
              <span className="eyebrow">REQUIRED BEFORE SUBMISSION</span>
              <h2 id="order-declaration-title">Pre-order declaration &amp; acknowledgment (Gouri Agency)</h2>
              <p>I/We hereby declare that before placing this wholesale order for medicinal products, I/we are fully aware of and agree to Gouri Agency’s strict protocols maintained to ensure the safety, efficacy, and integrity of the pharmaceutical supply chain. Accordingly, I/we understand that all goods once sold are strictly non-returnable and non-refundable, and that Gouri Agency does not accept returns, offer replacements, or issue credit notes for expired stock or post-delivery breakage. As an exception, if I/we receive a damaged shipment, a product with a broken manufacturer seal, or an incorrect item, I/we agree to report the issue within 24 hours of delivery along with clear photographic or video proof, understanding that upon claim verification, a replacement will be processed within 15 business days strictly subject to the physical return of the affected item in its original packaging.</p>
            </div>
            <label className="declaration-accept"><input type="checkbox" name="declarationAccepted" required /><span>I have read, understood, and agree to the above terms prior to placing this medicine order. <RequiredMark/></span></label>
          </section>
          <div className="file-upload-grid order-upload-grid">
            {businessType !== 'Partnership' && <label className="file-upload">Owner photo <span className="optional-label">Optional</span><input name="profilePhoto" type="file" accept=".jpg,.jpeg,.png,image/jpeg,image/png" /><small>{user?.profile?.attachments?.ownerPhoto ? 'Saved profile photo will be attached unless replaced.' : 'JPG or PNG · up to 5 MB'}</small></label>}
            <label className="file-upload"><span className="required-field-label">Drug license <RequiredMark/></span><span className="required-label">{user?.profile?.attachments?.drugLicense ? 'Saved copy' : 'Required'}</span><input name="drugLicense" type="file" accept=".pdf,.jpg,.jpeg,application/pdf,image/jpeg" required={!user?.profile?.attachments?.drugLicense} /><small>{user?.profile?.attachments?.drugLicense ? 'Saved profile license will be attached unless replaced.' : 'PDF or JPG · up to 5 MB'}</small></label>
            <label className="file-upload">GST copy <span className="optional-label">Optional</span><input name="gstCopy" type="file" accept=".pdf,.jpg,.jpeg,application/pdf,image/jpeg" /><small>{user?.profile?.attachments?.gstCopy ? 'Saved profile GST copy will be attached unless replaced.' : 'PDF or JPG · up to 5 MB'}</small></label>
            {businessType !== 'Partnership' && <label className="file-upload signature-upload"><span className="required-field-label">Authorized signature <RequiredMark/></span><span className="required-label">{user?.profile?.attachments?.signature ? 'Saved signature' : 'Required'}</span><input name="signature" type="file" accept=".jpg,.jpeg,.png,image/jpeg,image/png" onChange={prepareSignature} required={!user?.profile?.attachments?.signature} />{processingSignature && <small role="status">Extracting signature…</small>}{signatureError && <small className="signature-error" role="alert">{signatureError}</small>}{signaturePreview && <span className="signature-upload-preview"><img src={signaturePreview.upload.data} alt="Extracted black-ink signature preview"/></span>}<small>{user?.profile?.attachments?.signature ? 'Saved profile signature will be attached unless replaced.' : 'JPG or PNG on light paper · extracted as black ink'}</small></label>}
          </div>
          {businessType === 'Partnership' && <div className="partner-upload-backdrop" hidden={!partnerUploadOpen} role="presentation"><section className="partner-upload-dialog" role="dialog" aria-modal="true" aria-labelledby="partner-upload-title"><button type="button" className="partner-upload-close" aria-label="Close partner document dialog" onClick={() => setPartnerUploadOpen(false)}><X size={18}/></button><span className="eyebrow">PARTNERSHIP SIGNATORY</span><h2 id="partner-upload-title">Photo and signature</h2><p>Upload documents for <strong>{selectedPartnerName || 'the selected partner'}</strong>. These will be attached to the order agreement.</p>{savedPartnerDocumentsMatch && <div className="saved-partner-documents"><span>Saved documents match this signatory.</span><div>{user.profile.attachments.ownerPhoto?.data && <img src={user.profile.attachments.ownerPhoto.data} alt={`${selectedPartnerName} profile`} />}{user.profile.attachments.signature?.data && <img src={user.profile.attachments.signature.data} alt={`${selectedPartnerName} saved signature`} />}</div></div>}<div className="partner-upload-fields"><label className="file-upload"><span className="required-field-label">{savedPartnerDocumentsMatch ? 'Replace partner photo' : 'Partner photo'}{savedPartnerDocumentsMatch ? <span className="optional-label">Optional</span> : <RequiredMark/>}</span><input name="profilePhoto" type="file" accept=".jpg,.jpeg,.png,image/jpeg,image/png" required={partnerUploadOpen && Boolean(selectedPartnerName) && !savedPartnerDocumentsMatch && !partnerPhotoReady} onChange={event => { const file = event.currentTarget.files?.[0]; setPartnerPhotoReady(Boolean(file)); setPartnerPhotoFileName(file?.name || '') }} /><small>{partnerPhotoFileName || (savedPartnerDocumentsMatch ? 'Saved photo will be reused unless replaced.' : 'JPG or PNG · up to 5 MB')}</small></label><label className="file-upload"><span className="required-field-label">{savedPartnerDocumentsMatch ? 'Replace partner signature' : 'Partner signature'}{savedPartnerDocumentsMatch ? <span className="optional-label">Optional</span> : <RequiredMark/>}</span><input name="signature" type="file" accept=".jpg,.jpeg,.png,image/jpeg,image/png" required={partnerUploadOpen && Boolean(selectedPartnerName) && !savedPartnerDocumentsMatch && !signaturePreview} onChange={prepareSignature} /><small>{processingSignature ? 'Extracting signature…' : signatureError || (savedPartnerDocumentsMatch ? 'Saved signature will be reused unless replaced.' : 'JPG or PNG on light paper · extracted as black ink')}</small>{signaturePreview && <span className="signature-upload-preview"><img src={signaturePreview.upload.data} alt="Extracted partner signature preview"/></span>}</label></div><div className="partner-upload-actions"><button type="button" className="button outline" onClick={() => setPartnerUploadOpen(false)}>Cancel</button><button type="button" className="button dark" disabled={!selectedPartnerDocumentsReady || processingSignature} onClick={() => { setPartnerUploadOpen(false); setNotice(''); setNoticeIsError(false) }}>Use these documents <Check size={15}/></button></div></section></div>}
          <label>Remarks <span className="optional-label">Optional</span><textarea name="remarks" rows="3" placeholder="Anything else we should know?" /></label>
          <button className="button dark" disabled={!orderIntakeSettings.enabled || busy || processingSignature || gstLookupStatus.state === 'checking' || (user?.role === 'client' && user.profile?.profileFrozen)}>{processingSignature ? <LoadingAction loading label="Extracting signature…"/> : busy ? <LoadingAction loading label="Submitting order…"/> : gstLookupStatus.state === 'checking' ? <LoadingAction loading label="Verifying GST…"/> : <>Submit order request <ArrowUpRight size={16}/></>}</button>
          <small className="form-note"><ShieldCheck size={14}/> Your documents are submitted with this order request.</small>
          </fieldset>
        </form>
      </main>}

      {page === 'login' && <main className="login-page"><div className="login-card"><div className="login-mark"><Mark/></div><div className="eyebrow"><span className="live-dot"/> CLIENT OR ADMIN</div><h1>Sign in</h1><p>Choose your account type and enter your details.</p><div className="role-tabs" role="group" aria-label="Sign-in type"><button type="button" aria-pressed={role === 'client'} className={role === 'client' ? 'selected' : ''} onClick={() => changeLoginRole('client')}>Client</button><button type="button" aria-pressed={role === 'admin'} className={role === 'admin' ? 'selected' : ''} onClick={() => changeLoginRole('admin')}>Admin</button></div><form key={role} onSubmit={login}>
        <label>{role === 'admin' ? 'Email address' : 'Registered email, phone, or GST'}<input type="text" name="identifier" autoComplete="username" placeholder={role === 'admin' ? 'Admin email address' : 'Email, mobile number, or GSTIN'} required/></label>
        {role === 'admin' && <label>Password<input type="password" name="password" autoComplete="current-password" placeholder="Your password" required/></label>}
        {role === 'client' && <>
          <section className="login-captcha" aria-labelledby="login-captcha-title"><div className="login-captcha-heading"><div><span className="eyebrow">HUMAN VERIFICATION</span><strong id="login-captcha-title">Quick security check</strong></div><button type="button" className="captcha-refresh" onClick={() => setLoginCaptchaRevision(value => value + 1)} disabled={loginCaptchaLoading}><Sparkles size={14}/> New code</button></div><div className="login-captcha-body"><div className="captcha-image-frame">{loginCaptchaLoading ? <span>Loading secure code…</span> : loginCaptcha?.image ? <img src={loginCaptcha.image} alt="Five-character CAPTCHA code. Enter the characters shown."/> : <span>Code unavailable</span>}</div><label htmlFor="client-captcha-answer">Enter the code<input id="client-captcha-answer" name="captchaAnswer" type="text" autoComplete="off" autoCapitalize="characters" spellCheck="false" maxLength={5} value={loginCaptchaAnswer} onChange={event => setLoginCaptchaAnswer(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} placeholder="5 characters" required aria-describedby="login-captcha-help"/></label></div><p id="login-captcha-help">Enter the five letters and numbers shown. The code expires in four minutes.</p>{loginCaptchaError && <small className="login-captcha-error" role="alert">{loginCaptchaError} <button type="button" onClick={() => setLoginCaptchaRevision(value => value + 1)}>Try again</button></small>}</section>
          <div className="login-terms-row"><label className="login-terms-accept"><input type="checkbox" name="termsAccepted" required checked={clientTermsAccepted} onChange={event => setClientTermsAccepted(event.target.checked)}/><span>I have read and accept the Terms &amp; Conditions.</span></label><button type="button" className="login-terms-link" onClick={() => go('terms')}>Read terms</button></div>
        </>}
        {noticeIsError && notice && <div className="error-note" role="alert">{notice}</div>}
        <button className="button dark full" disabled={busy || (role === 'client' && (!loginCaptcha || loginCaptchaLoading || Boolean(loginCaptchaError) || !clientTermsAccepted))}>{busy ? <LoadingAction loading label="Signing in…"/> : <>Sign in <ArrowRight size={16}/></>}</button>
      </form><div className="login-help"><CircleHelp size={14}/> Need help? <a href="mailto:gouriagency185@gmail.com">Contact us</a></div></div></main>}

      {page === 'payment-success' && user?.role === 'client' && paymentSuccess && <PaymentSuccessPage details={paymentSuccess} token={user.token} email={user.profile?.email || user.email} onReturn={() => { setClientTab('orders'); go('client') }}/>}

      {page === 'client' && <main className="inner-page dashboard"><div className="dash-head"><div><div className="eyebrow"><span className="live-dot"/> CLIENT WORKSPACE</div><h1 className="inner-title">Hello, <em>{user?.name || 'there'}.</em></h1><p className="inner-lede">Manage your profile, place orders, and track each request here.</p>{user?.profile?.lastLoginAt && <p className="client-last-login">Last login <time dateTime={user.profile.lastLoginAt}>{formatTimestamp(user.profile.lastLoginAt)} IST</time></p>}</div><div className="dashboard-head-tools"><button type="button" className="button outline dashboard-back-button" onClick={() => clientTab === 'overview' ? go('home') : setClientTab('overview')}><ArrowLeft size={15}/>{clientTab === 'overview' ? 'Back to home' : 'Back to overview'}</button><DashboardClock/><div className="workspace-actions"><button className="button dark" disabled={Boolean(user?.profile?.profileFrozen)} onClick={() => go('orders')}>Place order <Plus size={16}/></button><button className="button outline" disabled={Boolean(user?.profile?.profileFrozen)} onClick={() => go('orders')}>Bulk upload <ArrowUpRight size={15}/></button><button className="button outline" onClick={logout}>Sign out</button></div></div></div>
        <DashboardTabBar tabs={clientDashboardTabs} active={clientTab} idPrefix="client-dashboard" label="Client dashboard sections" onChange={setClientTab}/>
        {clientPromoCode?.enabled && clientPromoCode.code && <aside className="client-promo-banner"><span aria-hidden="true">{clientPromoCode.emoji || '🎉'}</span><div><strong>{clientPromoCode.discountType === 'percent' ? `${clientPromoCode.discountValue}% off` : `${formatMoney(clientPromoCode.discountValue)} off`} with promo code {clientPromoCode.code}</strong><small>Enter this code in an eligible order’s payment section to deduct the discount from its outstanding balance.</small></div></aside>}
        <div className="dashboard-tab-panel" id="client-dashboard-panel" role="tabpanel" tabIndex={0} aria-labelledby={`client-dashboard-${clientTab}-tab`}>
        {clientTab === 'overview' && <section className="dash-panel client-overview-panel"><div className="panel-heading"><div><span className="eyebrow">ACCOUNT OVERVIEW</span><h2>Your balance at a glance</h2></div><Package size={22}/></div><PaymentSummary orders={clientOrders} title="Your overall balance" className="client-payment-overview"/><ClientOverviewCharts orders={clientOrders}/><div className="dashboard-overview-actions"><button type="button" className="button dark" onClick={() => setClientTab('orders')}>View orders and payments <ArrowRight size={14}/></button><button type="button" className="button outline" onClick={() => setClientTab('statements')}>Email a statement <ArrowRight size={14}/></button></div></section>}
        {clientTab === 'pay-dues' && <ClientDuesTab orders={clientOrders} razorpayKeyId={razorpayKeyId} cashfreeEnabled={cashfreeEnabled} cashfreeEnvironment={cashfreeEnvironment} bankTransferDetails={bankTransferDetails} promoCode={clientPromoCode} paymentCharges={clientPaymentCharges} token={user.token} currentTime={currentTime} notice={clientOrderNotice} onOrdersUpdated={updatedOrders => setClientOrders(prev => prev.map(item => updatedOrders.find(updated => updated.id === item.id) || item))} onOrderUpdated={updated => setClientOrders(prev => prev.map(item => item.id === updated.id ? updated : item))} onPaymentSuccess={showPaymentSuccess}/>}
        {clientTab === 'orders' && <div className="dash-panel client-orders-panel">
          <div className="panel-heading"><div><span className="eyebrow">ORDERS & PAYMENTS</span><h2>Your orders and dues</h2></div><Package size={22}/></div>
          <PaymentSummary orders={activeClientOrders} title="Your overall balance" className="client-payment-overview"/>
          {clientOrderNotice && <div className="admin-notice" role="alert">{clientOrderNotice}</div>}
          {activeClientOrders.length ? <div className="client-payment-list">{activeClientOrders.map(order => <ClientPaymentOrder key={order.id} order={order} profileOrders={clientOrders} razorpayKeyId={razorpayKeyId} cashfreeEnabled={cashfreeEnabled} cashfreeEnvironment={cashfreeEnvironment} bankTransferDetails={bankTransferDetails} promoCode={clientPromoCode} paymentCharges={clientPaymentCharges} token={user.token} currentTime={currentTime} onUpdated={updated => { setClientOrders(prev => prev.map(item => item.id === updated.id ? updated : item)); if (updated.status === 'Cancelled') setClientTab('cancelled-orders') }} onPaymentSuccess={showPaymentSuccess}/>)}</div> : <div className="empty-state"><div className="empty-icon"><Sparkles/></div><h3>No orders in this list.</h3><p>Orders awaiting approval are in the In progress tab. Cancelled orders are in the Cancelled orders tab.</p></div>}
        </div>}
        {clientTab === 'in-progress-orders' && <section className="dash-panel client-orders-panel in-progress-client-orders-panel">
          <div className="panel-heading"><div><span className="eyebrow">AWAITING REVIEW</span><h2>Orders in progress</h2><p>These orders are awaiting the agency’s approval. Their status will update here.</p></div><span className="count-pill">{inProgressClientOrders.length} in progress</span></div>
          {inProgressClientOrders.length ? <div className="client-payment-list">{inProgressClientOrders.map(order => <ClientPaymentOrder key={order.id} order={order} profileOrders={clientOrders} razorpayKeyId={razorpayKeyId} cashfreeEnabled={cashfreeEnabled} cashfreeEnvironment={cashfreeEnvironment} bankTransferDetails={bankTransferDetails} promoCode={clientPromoCode} paymentCharges={clientPaymentCharges} token={user.token} currentTime={currentTime} onUpdated={updated => { setClientOrders(prev => prev.map(item => item.id === updated.id ? updated : item)); if (updated.status === 'Cancelled') setClientTab('cancelled-orders') }} onPaymentSuccess={showPaymentSuccess}/>)}</div> : <div className="empty-state"><div className="empty-icon"><Package size={19}/></div><h3>No orders in progress.</h3><p>Orders awaiting approval will appear here. Approved and rejected orders are listed under Orders &amp; payments.</p></div>}
        </section>}
        {clientTab === 'cancelled-orders' && <section className="dash-panel client-orders-panel cancelled-client-orders-panel">
          <div className="panel-heading"><div><span className="eyebrow">ORDER CANCELLATIONS</span><h2>Cancelled orders</h2><p>Review cancelled orders and their payment or refund updates.</p></div><span className="count-pill">{cancelledClientOrders.length} cancelled</span></div>
          {cancelledClientOrders.length ? <div className="client-payment-list">{cancelledClientOrders.map(order => <ClientPaymentOrder key={order.id} order={order} profileOrders={clientOrders} razorpayKeyId={razorpayKeyId} cashfreeEnabled={cashfreeEnabled} cashfreeEnvironment={cashfreeEnvironment} bankTransferDetails={bankTransferDetails} promoCode={clientPromoCode} paymentCharges={clientPaymentCharges} token={user.token} currentTime={currentTime} onUpdated={updated => setClientOrders(prev => prev.map(item => item.id === updated.id ? updated : item))} onPaymentSuccess={showPaymentSuccess}/>)}</div> : <div className="empty-state"><div className="empty-icon"><Package size={19}/></div><h3>No cancelled orders.</h3><p>Orders you cancel before approval will appear here with their payment and refund status.</p></div>}
        </section>}
        {clientTab === 'failed-transactions' && <ClientTransactionsTab orders={clientOrders} kind="failed"/>}
        {clientTab === 'refunds' && <ClientTransactionsTab orders={clientOrders} kind="refunds"/>}
        {clientTab === 'statements' && <section className="dash-panel client-statement-panel"><div className="panel-heading"><div><span className="eyebrow">ACCOUNT RECORDS</span><h2>Statements</h2><p>Download or email a date-range statement to your registered email.</p></div><Package size={22}/></div>{user?.profile && <StatementDownload profile={user.profile} orders={clientOrders} token={user.token}/>}</section>}
        {clientTab === 'messages' && <CommunicationsPanel token={user.token} role="client" profile={user?.profile}/>}
        {clientTab === 'profile' && (user?.profile ? <div className="dash-panel client-profile-panel"><div className="panel-heading"><div><span className="eyebrow">YOUR ACCOUNT</span><h2>Profile details</h2></div><div className="panel-heading-actions"><button type="button" className="button outline latest-pdf-button" disabled={!user.profile.orderIds?.length} onClick={() => downloadProtectedPdf(`${API}/client/profile/latest-ledger`, user.token).catch(error => setClientOrderNotice(error.message))}>Download latest order &amp; profile PDF <ArrowDown size={14}/></button><Package size={22}/></div></div><ClientProfileDetails profile={user.profile} token={user.token} onViewDocument={setPreviewDocument} onSaved={profile => setUser(current => ({ ...current, profile, email: profile.email, name: profile.ownerName || profile.shopName }))}/><div className="account-delete-box"><div><strong>Delete your profile</strong><p>Your profile, submitted documents, and active orders will be moved to the agency admin’s recovery bin for 30 days.</p></div><button className="button danger" type="button" disabled={deletingProfile || clientOrders.some(order => Date.parse(order.paymentEditLockedUntil || '') > Date.now())} onClick={deleteClientProfile}>{deletingProfile ? <LoadingAction label="Deleting profile…"/> : 'Delete my profile'}</button></div></div> : <div className="dash-panel"><div className="panel-heading"><div><span className="eyebrow">YOUR WORKSPACE</span><h2>Shop profile</h2></div><Package size={22}/></div><div className="empty-state"><div className="empty-icon"><Sparkles/></div><h3>No registered profile linked yet.</h3><p>Submit an order request with your shop details, then sign in with its email, phone, or GST number to manage your profile.</p><button className="text-button underline" onClick={() => go('orders')}>Create an order <ArrowRight size={14}/></button></div></div>)}
        </div>
      </main>}

      {page === 'admin' && <main className="inner-page dashboard">
        <div className="dash-head"><div><div className="eyebrow"><span className="live-dot"/> ADMIN PANEL</div><h1 className="inner-title">Order<br /><em>requests.</em></h1><p className="inner-lede">Review shop details, medicines, and uploaded documents.</p>{user?.lastLoginAt && <p className="client-last-login">Last login <time dateTime={user.lastLoginAt}>{formatTimestamp(user.lastLoginAt)} IST</time></p>}</div><div className="dashboard-head-tools"><button type="button" className="button outline dashboard-back-button" onClick={() => adminTab === 'overview' ? go('home') : setAdminTab('overview')}><ArrowLeft size={15}/>{adminTab === 'overview' ? 'Back to home' : 'Back to overview'}</button><DashboardClock/><button className="button outline" onClick={logout}>Sign out</button></div></div>
        <DashboardTabBar tabs={adminDashboardTabs} active={adminTab} idPrefix="admin-dashboard" label="Admin dashboard sections" onChange={tab => { setAdminTab(tab); setExternalPortal(tab === 'courier' || tab === 'eway' ? tab : null) }}/>
        <div className="dashboard-tab-panel" id="admin-dashboard-panel" role="tabpanel" tabIndex={0} aria-labelledby={`admin-dashboard-${adminTab}-tab`}>
        {adminTab === 'overview' && <section className="admin-overview-tab"><div className="stats-grid profile-stats"><article><span>CUSTOMER PROFILES</span><strong>{profiles.length.toString().padStart(2,'0')}</strong><small>Unique GST numbers</small></article><article><span>AWAITING APPROVAL</span><strong>{orders.filter(o => ['Pending approval', 'In progress'].includes(o.status) && !o.approvedAt).length.toString().padStart(2,'0')}</strong><small>Orders need your review</small></article></div><PaymentSummary orders={orders} title="Overall payment totals" className="admin-payment-overview"/><AdminOverviewCharts orders={orders}/></section>}
        {adminTab === 'notices' && <AdminNotices token={user.token}/>}
        {adminTab === 'orders' && <section className="dash-panel admin-orders-tab"><div className="panel-heading"><div><span className="eyebrow">ORDER REGISTER</span><h2>All orders</h2><p>Review order status, items, dues, and cancellation eligibility.</p></div><span className="count-pill">{orders.length} orders</span></div>{orderNotice && <div className="admin-notice" role="alert">{orderNotice}</div>}<div className="profile-search-toolbar"><label className="profile-search-field"><span>Search orders</span><input type="search" value={adminOrderSearch} onChange={event => setAdminOrderSearch(event.target.value)} placeholder="Order number, shop, medicine, email, or mobile"/></label><small>{visibleAdminOrders.length} of {orders.length} orders</small></div>{visibleAdminOrders.length ? <div className="admin-global-orders">{visibleAdminOrders.map(order => { const cancelDisabledReason = getOrderCancellationDisabledReason(order, currentTime); const balance = order.status === 'Cancelled' ? 0 : Math.max(0, Number(order.amountDue || 0) - Number(order.amountPaid || 0)); return <article className="admin-global-order" key={order.id}><div className="admin-global-order-heading"><div><strong>{order.id}</strong><span>{order.shopName} · {order.gstNumber}</span></div><span className={`order-status-badge status-${String(order.status).toLowerCase().replace(/[^a-z]+/g, '-')}`}>{order.status}</span><small>{formatTimestamp(order.date)}</small><button type="button" className="button outline compact-cancel" disabled={updatingOrder === order.id || Boolean(cancelDisabledReason)} title={cancelDisabledReason || undefined} onClick={() => cancelAdminOrder(order.id)}>{updatingOrder === order.id ? <LoadingAction label="Cancelling order…"/> : 'Cancel order'}</button>{cancelDisabledReason && <small className="cancel-order-locked-note">{cancelDisabledReason}</small>}</div><div className="admin-global-order-items">{(order.items || []).map((item, index) => <span key={`${order.id}-item-${index}`}>{item.name} · {item.quantity}</span>)}</div><div className="admin-global-order-balance"><span>Total {formatMoney(order.amountDue)}</span><span>Paid {formatMoney(order.amountPaid)}</span><strong>Outstanding {formatMoney(balance)}</strong></div></article>})}</div> : <div className="profile-search-empty">No orders match that search.</div>}</section>}
        {adminTab === 'sales' && <SalesAnalysis orders={orders} profiles={profiles}/>}
        {adminTab === 'bank' && <BankTransferSettings token={user.token}/>}
        {adminTab === 'charges' && <PaymentChargeSettings token={user.token}/>}
        {adminTab === 'promo' && <PromoCodeSettings token={user.token}/>}
        {adminTab === 'communications' && <CommunicationsPanel token={user.token} role="admin" profiles={profiles}/>}
        {adminTab === 'email' && <EmailDeliverySettings token={user.token}/>}
        {adminTab === 'access' && <AdminAccessSettings token={user.token}/>}
        {adminTab === 'settings' && <><HomeSliderSettings token={user.token}/><OrderIntakeSettings token={user.token} onUpdated={setOrderIntakeSettings}/><DueReminderSettings token={user.token}/></>}
        {adminTab === 'courier' && <AdminExternalPortalPanel portalKey="courier" onOpen={() => setExternalPortal('courier')}/>}
        {adminTab === 'eway' && <AdminExternalPortalPanel portalKey="eway" onOpen={() => setExternalPortal('eway')}/>}
        {adminTab === 'profiles' && <div className="dash-panel"><div className="panel-heading"><div><span className="eyebrow">GST-MATCHED PROFILES</span><h2>Customers and orders</h2></div><div className="admin-profile-header-actions"><button className="button outline archive-button" disabled={!profiles.some(hasProfileDocuments) || downloadingArchive === 'all'} onClick={() => downloadProfileDocuments()}>{downloadingArchive === 'all' ? <LoadingAction loading label="Preparing archive…"/> : <>Download all documents (.RAR) <ArrowDown size={15}/></>}</button><span className="count-pill">{orders.length} orders</span></div></div>
          {orderNotice && <div className="admin-notice" role="alert">{orderNotice}</div>}
          {!!profiles.length && <div className="profile-search-toolbar">
            <label className="profile-search-field"><span>Search client records</span><input type="search" value={profileSearch} onChange={event => setProfileSearch(event.target.value)} placeholder="Mobile number, email, or GST number" /></label>
            <small>{visibleProfiles.length} of {profiles.length} client{profiles.length === 1 ? '' : 's'}</small>
          </div>}
          {profiles.length ? <div className="profiles-list">{visibleProfiles.map(profile => <section className="profile-card" key={profile.id}>
            <details className="admin-customer-details" onToggle={event => { if (event.currentTarget.open) setClientProfileTabs(current => ({ ...current, [profile.id]: current[profile.id] || 'overview' })) }}>
              <summary className="admin-customer-summary">
                <ProfileAvatar profile={profile} token={user.token}/>
                <div className="admin-customer-overview"><strong>{profile.shopName}</strong><span>GST: {profile.gstNumber} · {profile.orderIds.length} order{profile.orderIds.length === 1 ? '' : 's'}</span><small>IndiaMART customer: {profile.indiaMartCustomer === false ? 'No' : 'Yes'}</small><small>Outstanding: {formatMoney(orders.filter(order => order.profileId === profile.id && order.status !== 'Cancelled').reduce((sum, order) => sum + Math.max(0, Number(order.amountDue || 0) - Number(order.amountPaid || 0)), 0))}</small>{profile.accessBlocked && <small className="client-access-flag is-blocked">Client portal blocked · 603</small>}</div>
                <span className="admin-profile-expand"><span className="profile-expand-closed">View profile</span><span className="profile-expand-open">Hide profile</span><ChevronDown size={15}/></span>
              </summary>
              <div className="admin-customer-expanded">
            <div className="profile-heading">
              <ProfileAvatar profile={profile} token={user.token} alt={`${profile.shopName} owner`}/>
              <div className="profile-info">
                <strong>{profile.shopName}</strong>
                <span>GST: {profile.gstNumber} · {profile.orderIds.length} order{profile.orderIds.length === 1 ? '' : 's'}</span>
                <span>IndiaMART customer: {profile.indiaMartCustomer === false ? 'No' : 'Yes'} · fixed at registration</span>
                {profile.gstVerifiedAt && <span className="gst-verified-badge">GST details verified · {new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' }).format(new Date(profile.gstVerifiedAt))}</span>}
                {profile.businessType === 'Sole proprietorship' && <span>Owner: {profile.ownerName}</span>}
                {profile.businessType === 'Partnership' && <span>Partners: {profile.partnerOne} and {profile.partnerTwo}</span>}
                <span>{profile.email} · {profile.mobile}</span>
                <small>{profile.shopAddress} · {profile.pincode || 'PIN not recorded'}, {profile.city || ''}{profile.state ? `, ${profile.state}` : ''}{profile.country ? `, ${profile.country}` : ''} · Drug license: {profile.drugLicenseNumber} · Expires: {profile.drugLicenseExpiresAt || 'Not recorded'}</small>
                {profile.profileFrozen && <span className="profile-license-status" role="status">Profile frozen · {profile.drugLicenseExpiryMissing ? 'expiry date missing' : 'drug license expired'}</span>}
                {clientProfileTabs[profile.id] === 'profile' && <DocumentLinks attachments={profile.attachments} profileId={profile.id} token={user.token} onView={setPreviewDocument}/>}
              </div>
            </div>
            <div className={`admin-client-access-panel${profile.accessBlocked ? ' is-blocked' : ''}`}>
              <div><strong>{profile.accessBlocked ? 'Client portal access is blocked' : 'Client portal access is active'}</strong><small>{profile.accessBlocked ? 'The client cannot sign in or use portal services. Sign-in displays access denied, error code 603.' : 'Block this profile to prevent the client from signing in or using portal services.'}</small></div>
              <button type="button" className={`button ${profile.accessBlocked ? 'outline' : 'danger'}`} disabled={updatingClientAccess === profile.id} onClick={() => updateClientAccess(profile)}>{updatingClientAccess === profile.id ? <LoadingAction loading label="Updating access…"/> : profile.accessBlocked ? 'Unblock client' : 'Block client'}</button>
            </div>
            <DashboardTabBar tabs={adminClientTabs} active={clientProfileTabs[profile.id] || 'overview'} idPrefix={`admin-client-${profile.id}`} label={`${profile.shopName} sections`} onChange={tab => setClientProfileTabs(current => ({ ...current, [profile.id]: tab }))}/>
            {clientProfileTabs[profile.id] !== 'orders' && clientProfileTabs[profile.id] !== 'dues' && clientProfileTabs[profile.id] !== 'statements' && clientProfileTabs[profile.id] !== 'profile' && <>
              <PaymentSummary orders={orders.filter(order => order.profileId === profile.id)} title="This client's totals across all orders" className="profile-payment-overview"/>
              <div className="admin-client-overview-note"><strong>Account overview</strong><span>{orders.filter(order => order.profileId === profile.id).length} orders · {profile.orderIds?.length || 0} linked order records</span></div>
            </>}
            {clientProfileTabs[profile.id] === 'profile' && <>
              <div className="profile-admin-actions"><span>{orders.some(order => order.profileId === profile.id && Date.parse(order.paymentEditLockedUntil || '') > Date.now()) ? 'A fully paid order is locked for 24 hours; this profile cannot be moved to trash during that period.' : 'Profile and its active orders can be recovered from the trash bin for 30 days.'}</span><button className="button danger" type="button" disabled={trashAction === profile.id || orders.some(order => order.profileId === profile.id && Date.parse(order.paymentEditLockedUntil || '') > Date.now())} onClick={() => deleteAdminProfile(profile)}>{trashAction === profile.id ? <LoadingAction label="Moving profile to trash…"/> : 'Delete profile and orders'}</button></div>
              <div className="profile-archive-action"><button type="button" className="button outline latest-pdf-button" disabled={!profile.orderIds?.length} onClick={() => downloadProtectedPdf(`${API}/admin/profiles/${encodeURIComponent(profile.id)}/latest-ledger`, user.token).catch(error => setOrderNotice(error.message))}>Download latest order &amp; profile PDF <ArrowDown size={14}/></button><button className="button outline archive-button" disabled={!hasProfileDocuments(profile) || downloadingArchive === profile.id} onClick={() => downloadProfileDocuments(profile)}>{downloadingArchive === profile.id ? <LoadingAction loading label="Preparing archive…"/> : <>Download profile documents (.RAR) <ArrowDown size={15}/></>}</button></div>
              <details className="admin-profile-edit"><summary>Edit customer profile and photo</summary><ProfileEditor profile={profile} token={user.token} admin onViewDocument={setPreviewDocument} onSaved={updatedProfile => setProfiles(prev => prev.map(item => item.id === updatedProfile.id ? updatedProfile : item))}/></details>
            </>}
            {clientProfileTabs[profile.id] === 'statements' && <StatementDownload profile={profile} orders={orders.filter(order => order.profileId === profile.id)} token={user.token} admin/>}
            {clientProfileTabs[profile.id] === 'dues' && <section className="admin-client-dues"><PaymentSummary orders={orders.filter(order => order.profileId === profile.id)} title="Client dues and payments" className="profile-payment-overview"/>{orders.filter(order => order.profileId === profile.id).map(order => <article className="admin-client-due-row" key={`due-${order.id}`}><div><strong>{order.id}</strong><span>{order.status} · {formatTimestamp(order.date)}</span><small>Total {formatMoney(order.amountDue)} · Paid {formatMoney(order.amountPaid)} · Outstanding {formatMoney(order.status === 'Cancelled' ? 0 : Math.max(0, Number(order.amountDue || 0) - Number(order.amountPaid || 0)))}</small></div><AdminPaymentControls order={order} token={user.token} onUpdated={updated => setOrders(prev => prev.map(item => item.id === updated.id ? updated : item))}/></article>)}</section>}
            {clientProfileTabs[profile.id] === 'orders' && <>
            <div className="profile-order-search">
              <label className="profile-search-field"><span>Search this client’s orders</span><input type="search" value={profileOrderSearch[profile.id] || ''} onChange={event => setProfileOrderSearch(current => ({ ...current, [profile.id]: event.target.value }))} placeholder="Order number, shop, or medicine name" /></label>
              <small>{visibleOrdersForProfile(profile.id).length} matching order{visibleOrdersForProfile(profile.id).length === 1 ? '' : 's'}</small>
            </div>
            <div className="profile-orders">{visibleOrdersForProfile(profile.id).map(order => {
              const paymentLocked = Number.isFinite(Date.parse(order.paymentEditLockedUntil || '')) && Date.parse(order.paymentEditLockedUntil) > Date.now()
              return <article className="profile-order" key={order.id}>
                <div className="profile-order-heading"><span className="order-title"><strong>{order.id}</strong><DueAgeIndicator order={order}/></span><small>{formatTimestamp(order.date)}</small><button type="button" className="button danger compact-danger order-trash-action" disabled={updatingOrder === order.id || paymentLocked} onClick={() => deleteAdminOrder(order.id)}>{updatingOrder === order.id ? <LoadingAction label="Moving to trash…"/> : 'Move to trash'}</button></div>
                <div className="profile-order-details">
                  <span>{order.shopName} · {order.businessType}</span>
                  <span>IndiaMART customer: {order.indiaMartCustomer === false ? 'No' : 'Yes'}</span>
                  {order.businessType === 'Sole proprietorship' && <span>Owner: {order.ownerName}</span>}
                  {order.businessType === 'Partnership' && <span>Partners: {order.partnerOne} and {order.partnerTwo}</span>}
                  <span>{order.email} · {order.mobile}</span>
                  <span>{order.shopAddress}</span>
                  <span>{[order.pincode, order.city, order.state, order.country].filter(Boolean).join(', ')}</span>
                  <span>GST: {order.gstNumber} · Drug license: {order.drugLicenseNumber}</span>
                </div>
                <div className="admin-order-items-table" role="table" aria-label={`Items for order ${order.id}`}><div className="admin-order-items-header" role="row"><span role="columnheader">Medicine</span><span role="columnheader">Quantity / pack</span></div>{order.items?.map((item, index) => <div className="admin-order-item-row" role="row" key={`${order.id}-${index}`}><span role="cell">{item.name}</span><span role="cell">{item.quantity}</span></div>)}</div>
                {order.remarks && <small className="order-remark">Remarks: {order.remarks}</small>}
                <div className="profile-order-footer">
                  <div className="profile-order-admin-actions approval-actions">
                    {['Pending approval', 'In progress'].includes(order.status) && !order.approvedAt ? <label className="order-review-control"><span className="sr-only">Review order {order.id}</span><select aria-label={`Review order ${order.id}`} defaultValue="" disabled={updatingOrder === order.id || paymentLocked} onChange={event => { const decision = event.target.value; event.target.value = ''; if (decision) updateOrderStatus(order.id, decision) }}><option value="" disabled>Review order</option><option value="Approved">Approve</option><option value="Rejected">Reject</option></select></label> : <span className={`order-status-badge status-${String(order.status).toLowerCase().replace(/[^a-z]+/g, '-')}`}>{order.status}</span>}
                  </div>
                </div>
              </article>
            })}{!visibleOrdersForProfile(profile.id).length && <p className="profile-search-empty">No orders match this search.</p>}</div>
            </>}
              </div>
            </details>
          </section>)}</div> : <div className="empty-state"><div className="empty-icon"><Sparkles/></div><h3>No order requests yet.</h3><p>Submitted shop orders will appear here.</p></div>}
          {profiles.length > 0 && visibleProfiles.length === 0 && <div className="profile-search-empty">No client records match that mobile number, email, or GST.</div>}
        </div>}
        {adminTab === 'trash' && <section className="dash-panel trash-bin-panel">
          <div className="panel-heading"><div><span className="eyebrow">30-DAY RECOVERY</span><h2>Trash bin</h2><p>Deleted profiles and orders are permanently removed after 30 days.</p></div><span className="count-pill">{trash.length} items</span></div>
          {orderNotice && <div className="admin-notice" role="status">{orderNotice}</div>}
          <div className="profile-search-toolbar trash-search-toolbar"><label className="profile-search-field"><span>Search deleted records</span><input type="search" value={trashSearch} onChange={event => setTrashSearch(event.target.value)} placeholder="Mobile, email, GST, or order ID" /></label><small>{visibleTrash.length} of {trash.length} records</small></div>
          {visibleTrash.length ? <div className="trash-bin-list">{visibleTrash.map(item => {
            const daysLeft = Math.max(0, Math.ceil((Date.parse(item.expiresAt) - Date.now()) / 86400000))
            return <article className="trash-bin-item" key={item.id}>
              <div className="trash-bin-details"><strong>{item.label}</strong><span>{item.type === 'profile' ? `Customer profile · ${item.orderCount} active order${item.orderCount === 1 ? '' : 's'}` : `Order ${item.orderId || ''}`}{item.reason === 'rejected order' ? ' · Rejected' : ''}</span>{(item.email || item.mobile) && <small>{item.email}{item.email && item.mobile ? ' · ' : ''}{item.mobile ? `Mobile ${item.mobile}` : ''}</small>}<small>Deleted {formatTimestamp(item.deletedAt)} · {daysLeft} day{daysLeft === 1 ? '' : 's'} left · by {item.deletedBy}</small></div>
              <div className="trash-bin-actions"><button type="button" className="button outline compact-danger" disabled={trashAction === item.id} onClick={() => restoreTrashItem(item)}>{trashAction === item.id ? <LoadingAction label="Restoring record…"/> : 'Restore'}</button><button type="button" className="button danger compact-danger" disabled={trashAction === item.id} onClick={() => permanentlyDeleteTrashItem(item)}>Delete permanently</button></div>
            </article>
          })}</div> : trash.length ? <div className="profile-search-empty">No deleted records match that mobile number, email, GST, or order ID.</div> : <div className="empty-state trash-empty-state"><h3>Trash bin is empty.</h3><p>Deleted profiles and orders will appear here for 30 days.</p></div>}
        </section>}
        </div>
      </main>}

      <div className="footer-security-marquee" role="region" aria-label="Website security information"><div className="footer-security-track"><span className="footer-security-message"><ShieldCheck size={16}/> Secure HTTPS connections and role-based access help protect your information.</span><span className="footer-security-message" aria-hidden="true"><ShieldCheck size={16}/> Secure HTTPS connections and role-based access help protect your information.</span></div></div>
      <footer className="footer"><button className="brand" onClick={() => go('home')}><Mark small/><span className="brand-text">GOURI <b>AGENCY</b></span></button><span>Independent by nature. Good by design.</span><div><a href="#contact" onClick={event => { event.preventDefault(); go('contact') }}>Contact us <ArrowUpRight size={12}/></a><span>© {new Date().getFullYear()} Gouri Agency. All rights reserved.</span></div></footer>
      {page === 'home' && <div className="footer-compliance-banner">Wholesale Pharmaceutical Distributor. Valid Wholesale Drug License No: [DL-BD-BDN/DGP/55-SBW] | GSTIN: [19AAFFG2609C1ZR]. Orders are strictly restricted to licensed pharmacies and medical institutions.<div className="footer-site-stats"><span><strong>Visitor count</strong>{siteVisitorCount === null ? 'Loading…' : siteVisitorCount.toLocaleString('en-IN')}</span><span><strong>Website last updated</strong>{formatSiteTimestamp(SITE_BUILD_TIMESTAMP)}</span></div></div>}
      {page === 'admin' && externalPortal && <AdminExternalPortalDialog portalKey={externalPortal} onCancel={() => setExternalPortal(null)} onAgree={() => window.location.assign(ADMIN_EXTERNAL_PORTALS[externalPortal].url)}/>}
      {previewDocument && <DocumentPreview document={previewDocument} onClose={() => setPreviewDocument(null)}/>}
    </div>
    {preloaderVisible && <PagePreloader leaving={preloaderLeaving}/>}
    <ActionToast/>
  </>
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>)
