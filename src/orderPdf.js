import { deflateSync, inflateSync } from 'node:zlib'

const W = 595
const H = 842
const M = 38
const PAGE_BG = [0.98, 0.985, 0.975]
const INK = [0.12, 0.17, 0.15]
const MUTED = [0.40, 0.46, 0.42]
const GREEN = [0.255, 0.36, 0.31]
const SOFT = [0.93, 0.95, 0.92]
const LINE = [0.85, 0.88, 0.84]
const TIME_ZONE = 'Asia/Kolkata'

function safe(value) {
  return String(value ?? '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[₹]/g, 'INR ').replace(/[–—]/g, '-').replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"').replace(/[·•]/g, '-')
    .replace(/[^\x20-\x7E]/g, '?')
}

function escaped(value) { return safe(value).replace(/([\\()])/g, '\\$1') }
function money(value) { return `INR ${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` }
function dateTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '-' : new Intl.DateTimeFormat('en-IN', { timeZone: TIME_ZONE, dateStyle: 'medium', timeStyle: 'short' }).format(date)
}
function wrap(value, max = 64) {
  const words = safe(value).trim().split(/\s+/).filter(Boolean)
  const lines = []
  let line = ''
  for (const word of words) {
    const fragments = word.length > max ? word.match(new RegExp(`.{1,${max}}`, 'g')) : [word]
    for (const fragment of fragments) {
      if (line && `${line} ${fragment}`.length > max) { lines.push(line); line = fragment }
      else line = line ? `${line} ${fragment}` : fragment
    }
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['-']
}

function decodeSignaturePng(upload, deepenInk = true) {
  const encoded = upload?.data?.split(',')[1]
  if (!encoded) return null
  const png = Buffer.from(encoded, 'base64')
  if (png.length < 45 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0
  const imageData = []
  for (let offset = 8; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset)
    if (offset + 12 + length > png.length) return null
    const type = png.toString('ascii', offset + 4, offset + 8)
    const chunk = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4)
      bitDepth = chunk[8]; colorType = chunk[9]; interlace = chunk[12]
    } else if (type === 'IDAT') imageData.push(chunk)
    else if (type === 'IEND') break
    offset += length + 12
  }
  if (!width || !height || width * height > 5_000_000 || bitDepth !== 8 || ![2, 6].includes(colorType) || interlace !== 0 || !imageData.length) return null
  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  const filtered = inflateSync(Buffer.concat(imageData))
  if (filtered.length !== (stride + 1) * height) return null
  const pixels = Buffer.alloc(stride * height)
  const paeth = (a, b, c) => {
    const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c)
    return da <= db && da <= dc ? a : db <= dc ? b : c
  }
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (stride + 1), filter = filtered[rowOffset]
    const row = filtered.subarray(rowOffset + 1, rowOffset + 1 + stride)
    const previous = y ? pixels.subarray((y - 1) * stride, y * stride) : null
    const target = pixels.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? target[x - channels] : 0
      const up = previous ? previous[x] : 0
      const upperLeft = previous && x >= channels ? previous[x - channels] : 0
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? paeth(left, up, upperLeft) : null
      if (predictor === null) return null
      target[x] = (row[x] + predictor) & 255
    }
  }
  const rgb = Buffer.alloc(width * height * 3), alpha = Buffer.alloc(width * height)
  for (let index = 0, pixel = 0; index < pixels.length; index += channels, pixel++) {
    rgb[pixel * 3] = pixels[index]; rgb[pixel * 3 + 1] = pixels[index + 1]; rgb[pixel * 3 + 2] = pixels[index + 2]
    const sourceAlpha = channels === 4 ? pixels[index + 3] : 255
    alpha[pixel] = deepenInk && sourceAlpha > 12
      ? Math.round(Math.pow((sourceAlpha - 12) / 243, 0.65) * 255)
      : deepenInk ? 0 : sourceAlpha
  }
  return { width, height, rgbHex: deflateSync(rgb).toString('hex'), alphaHex: deflateSync(alpha).toString('hex') }
}

function decodeJpeg(upload) {
  const encoded = upload?.data?.split(',')[1]
  if (!encoded) return null
  const jpeg = Buffer.from(encoded, 'base64')
  if (jpeg.length < 16 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null
  let offset = 2, width = 0, height = 0, components = 0
  while (offset + 4 <= jpeg.length) {
    if (jpeg[offset] !== 0xff) return null
    while (jpeg[offset] === 0xff) offset++
    const marker = jpeg[offset++]
    if (marker === 0xda || marker === 0xd9) break
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > jpeg.length) return null
    const segmentLength = jpeg.readUInt16BE(offset)
    if (segmentLength < 2 || offset + segmentLength > jpeg.length) return null
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (segmentLength < 8) return null
      height = jpeg.readUInt16BE(offset + 3)
      width = jpeg.readUInt16BE(offset + 5)
      components = jpeg[offset + 7]
      break
    }
    offset += segmentLength
  }
  if (!width || !height || width * height > 20_000_000 || ![1, 3, 4].includes(components)) return null
  return { width, height, components, jpegHex: jpeg.toString('hex') }
}

function decodeProfilePhoto(upload) {
  if (upload?.type === 'image/jpeg') return decodeJpeg(upload)
  if (upload?.type === 'image/png') return decodeSignaturePng(upload, false)
  return null
}

function documentBlob(pages, { signatureImage = null, profilePhotoImage = null } = {}) {
  const objects = new Map()
  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>')
  objects.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  objects.set(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')
  const ids = []
  let next = 5
  const imageResources = []
  const addPngImage = (name, image) => {
    if (!image) return
    const imageId = next++
    const maskId = next++
    objects.set(imageId, `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter [/ASCIIHexDecode /FlateDecode] /SMask ${maskId} 0 R /Length ${image.rgbHex.length + 1} >>\nstream\n${image.rgbHex}>\nendstream`)
    objects.set(maskId, `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter [/ASCIIHexDecode /FlateDecode] /Length ${image.alphaHex.length + 1} >>\nstream\n${image.alphaHex}>\nendstream`)
    imageResources.push(`/${name} ${imageId} 0 R`)
  }
  const addJpegImage = (name, image) => {
    if (!image) return
    const imageId = next++
    const colorSpace = image.components === 1 ? '/DeviceGray' : image.components === 4 ? '/DeviceCMYK' : '/DeviceRGB'
    const decode = image.components === 4 ? ' /Decode [1 0 1 0 1 0 1 0]' : ''
    objects.set(imageId, `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter [/ASCIIHexDecode /DCTDecode]${decode} /Length ${image.jpegHex.length + 1} >>\nstream\n${image.jpegHex}>\nendstream`)
    imageResources.push(`/${name} ${imageId} 0 R`)
  }
  addPngImage('ClientSignature', signatureImage)
  if (profilePhotoImage?.jpegHex) addJpegImage('ProfilePhoto', profilePhotoImage)
  else addPngImage('ProfilePhoto', profilePhotoImage)
  pages.forEach((commands, index) => {
    const pageId = next++, streamId = next++
    ids.push(pageId)
    const footer = `0.85 0.88 0.84 RG 0.5 w ${M} 35 m ${W - M} 35 l S\n0.40 0.46 0.42 rg BT /F1 7 Tf 1 0 0 1 ${M} 20 Tm (Digitally generated - no handwritten signature required) Tj ET\n0.40 0.46 0.42 rg BT /F1 7 Tf 1 0 0 1 ${W - M - 112} 20 Tm (Page ${index + 1} of ${pages.length}) Tj ET`
    const content = `${commands.join('\n')}\n${footer}`
    const imageResource = imageResources.length ? ` /XObject << ${imageResources.join(' ')} >>` : ''
    objects.set(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${imageResource} >> /Contents ${streamId} 0 R >>`)
    objects.set(streamId, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  })
  objects.set(2, `<< /Type /Pages /Kids [${ids.map(id => `${id} 0 R`).join(' ')}] /Count ${ids.length} >>`)
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (let id = 1; id < next; id++) { offsets[id] = pdf.length; pdf += `${id} 0 obj\n${objects.get(id)}\nendobj\n` }
  const xref = pdf.length
  pdf += `xref\n0 ${next}\n0000000000 65535 f \n`
  for (let id = 1; id < next; id++) pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${next} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return new Blob([pdf], { type: 'application/pdf' })
}

export function createOrderLedgerPdf({ profile, currentOrder, orders = [], generatedAt = new Date() }) {
  const signatureUpload = currentOrder?.attachments?.signature || profile?.attachments?.signature
  const signatureImage = decodeSignaturePng(signatureUpload)
  if (signatureUpload?.data && !signatureImage) throw new Error('Could not embed the saved client signature in the order PDF.')
  const profilePhotoUpload = currentOrder?.attachments?.profilePhoto || profile?.attachments?.ownerPhoto || profile?.attachments?.profilePhoto
  const profilePhotoImage = decodeProfilePhoto(profilePhotoUpload)
  const pages = []
  let page = []
  let y = 0
  const rgb = color => color.map(value => value.toFixed(3)).join(' ')
  const fill = (x, top, width, height, color) => page.push(`${rgb(color)} rg ${x} ${H - top - height} ${width} ${height} re f`)
  const rule = (x1, top, x2, color = LINE, width = 0.55) => page.push(`${rgb(color)} RG ${width} w ${x1} ${H - top} m ${x2} ${H - top} l S`)
  const text = (x, top, value, size = 8.5, font = 'F1', color = INK) => page.push(`${rgb(color)} rg BT /${font} ${size} Tf 1 0 0 1 ${x} ${H - top - size} Tm (${escaped(value)}) Tj ET`)
  const right = (x, top, value, size = 8, font = 'F1', color = INK) => text(x - safe(value).length * size * 0.49, top, value, size, font, color)
  const drawSignature = (x, top, width, height) => {
    if (!signatureImage) return
    const scale = Math.min(width / signatureImage.width, height / signatureImage.height)
    const imageWidth = signatureImage.width * scale
    const imageHeight = signatureImage.height * scale
    const imageX = x + (width - imageWidth) / 2
    const imageTop = top + (height - imageHeight) / 2
    page.push(`q ${imageWidth} 0 0 ${imageHeight} ${imageX} ${H - imageTop - imageHeight} cm /ClientSignature Do Q`)
  }
  const drawProfilePhoto = (x, top, size) => {
    if (!profilePhotoImage) return
    const scale = Math.min(size / profilePhotoImage.width, size / profilePhotoImage.height)
    const imageWidth = profilePhotoImage.width * scale
    const imageHeight = profilePhotoImage.height * scale
    const imageX = x + (size - imageWidth) / 2
    const imageTop = top + (size - imageHeight) / 2
    page.push(`q ${imageWidth} 0 0 ${imageHeight} ${imageX} ${H - imageTop - imageHeight} cm /ProfilePhoto Do Q`)
  }
  const addPage = continuation => {
    page = []
    pages.push(page)
    fill(0, 0, W, continuation ? 63 : 103, GREEN)
    text(M, 20, 'GOURI AGENCY  |  WHOLESALE PHARMACEUTICAL DISTRIBUTION', 8, 'F2', [0.91, 0.95, 0.91])
    text(M, continuation ? 39 : 43, continuation ? 'CUSTOMER PROFILE LEDGER  |  CONTINUED' : 'ORDER RECEIPT & PROFILE LEDGER', continuation ? 15 : 14, 'F2', [1, 1, 1])
    if (!continuation) {
      text(M, 76, `Generated ${dateTime(generatedAt)} IST`, 8, 'F1', [0.91, 0.95, 0.91])
      if (profilePhotoImage) {
        fill(370, 37, 46, 46, SOFT)
        drawProfilePhoto(371, 38, 44)
        page.push(`${rgb([0.85, 0.88, 0.84])} RG 0.5 w 370 ${H - 83} 46 46 re S`)
        text(370, 86, 'PROFILE PHOTO', 5.2, 'F2', [0.91, 0.95, 0.91])
      }
      fill(429, 14, 128, 76, [0.97, 0.98, 0.96])
      text(440, 25, 'ORDER ID', 7, 'F2', MUTED)
      text(440, 39, currentOrder?.id || '-', 14, 'F2', GREEN)
      text(440, 64, String(currentOrder?.status || 'Submitted').toUpperCase(), 7, 'F2', GREEN)
      y = 119
    } else y = 78
  }
  const section = title => {
    if (y + 27 > H - 54) addPage(true)
    text(M, y, title.toUpperCase(), 8.5, 'F2', GREEN)
    rule(M, y + 17, W - M)
    y += 24
  }
  const field = (label, value, x, top, width = 255, height = 28) => {
    text(x, top, label.toUpperCase(), 6.5, 'F2', MUTED)
    const lines = wrap(value || '-', Math.max(24, Math.floor(width / 5.1))).slice(0, 2)
    lines.forEach((line, index) => text(x, top + 10 + index * 9, line, 8, 'F1', INK))
    rule(x, top + height - 2, x + width, [0.90, 0.92, 0.89], 0.35)
  }

  addPage(false)
  section('Customer profile & regulatory details')
  field(profile.businessType === 'Partnership' ? 'Business / partners' : 'Proprietor', profile.businessType === 'Partnership' ? `${profile.shopName} - ${profile.partnerOne} / ${profile.partnerTwo}` : `${profile.ownerName || currentOrder?.ownerName || '-'} - ${profile.shopName}`, M, y, 250)
  field('GSTIN', profile.gstNumber, 315, y, 242)
  y += 31
  field('Drug license number', profile.drugLicenseNumber, M, y, 250)
  field('Drug license expiry date', profile.drugLicenseExpiresAt || 'Not recorded', 315, y, 242)
  y += 31
  field('Registered phone', profile.mobile, M, y, 250)
  field('Official email', profile.email, 315, y, 242)
  y += 31
  field('Profile ID', profile.id || '-', M, y, 250)
  y += 31
  field('Registered shop address', profile.shopAddress, M, y, W - M * 2, 36)
  y += 39
  field('PIN code / city / state / country', [profile.pincode, profile.city, profile.state, profile.country].filter(Boolean).join(', ') || '-', M, y, W - M * 2, 30)
  y += 33

  section(`Current order ${currentOrder?.id || ''}  |  ${dateTime(currentOrder?.date)}`)
  text(M + 5, y, 'MEDICINE / PRODUCT', 6.5, 'F2', MUTED)
  right(W - M - 5, y, 'QUANTITY / PACK', 6.5, 'F2', MUTED)
  y += 17
  rule(M, y - 3, W - M, GREEN, 0.8)
  for (const [index, item] of (currentOrder?.items || []).entries()) {
    const itemLines = wrap(item.name, 65).slice(0, 2)
    const quantityLines = wrap(item.quantity, 22).slice(0, 3)
    itemLines.forEach((line, lineIndex) => text(M + 5, y + lineIndex * 10, line, 8, 'F1', INK))
    quantityLines.forEach((line, lineIndex) => right(W - M - 5, y + lineIndex * 9, line, 7.5, 'F2', INK))
    y += Math.max(23, itemLines.length * 10 + 9, quantityLines.length * 9 + 9)
    rule(M, y - 3, W - M, LINE, 0.4)
    if (index < (currentOrder?.items || []).length - 1 && y > H - 105) { addPage(true); section(`Current order ${currentOrder?.id || ''}  |  continued`) }
  }
  if (!(currentOrder?.items || []).length) { text(M + 5, y, 'No medicine lines were recorded.', 8, 'F1', MUTED); y += 22 }
  if (currentOrder?.remarks) {
    y += 3
    text(M + 5, y, 'CLIENT REMARKS', 6.5, 'F2', MUTED)
    wrap(currentOrder.remarks, 90).slice(0, 2).forEach((line, index) => text(M + 5, y + 10 + index * 9, line, 7.5, 'F1', INK))
    y += 29
  }
  y += 4
  const due = Number(currentOrder?.amountDue || 0)
  const paid = Number(currentOrder?.amountPaid || 0)
  const balance = Math.max(0, due - paid)
  const cards = [['CURRENT ORDER DUE', due], ['CURRENT ORDER PAID', paid], ['CURRENT ORDER BALANCE', balance]]
  const cardGap = 8, cardW = (W - M * 2 - cardGap * 2) / 3
  cards.forEach(([label, amount], index) => {
    const x = M + index * (cardW + cardGap)
    fill(x, y, cardW, 43, SOFT)
    text(x + 8, y + 8, label, 6.4, 'F2', MUTED)
    text(x + 8, y + 23, money(amount), 10, 'F2', INK)
  })
  y += 55

  section('Pre-order declaration & acknowledgment (Gouri Agency)')
  const declaration = "I/We hereby declare that before placing this wholesale order for medicinal products, I/we are fully aware of and agree to Gouri Agency's strict protocols maintained to ensure the safety, efficacy, and integrity of the pharmaceutical supply chain. Accordingly, I/we understand that all goods once sold are strictly non-returnable and non-refundable, and that Gouri Agency does not accept returns, offer replacements, or issue credit notes for expired stock or post-delivery breakage. As an exception, if I/we receive a damaged shipment, a product with a broken manufacturer seal, or an incorrect item, I/we agree to report the issue within 24 hours of delivery along with clear photographic or video proof, understanding that upon claim verification, a replacement will be processed within 15 business days strictly subject to the physical return of the affected item in its original packaging."
  for (const line of wrap(declaration, 111)) {
    if (y + 10 > H - 62) { addPage(true); section('Pre-order declaration & acknowledgment (continued)') }
    text(M, y, line, 7.3, 'F1', MUTED)
    y += 9.5
  }
  y += 5
  if (y + 20 > H - 62) { addPage(true); section('Pre-order acknowledgment (continued)') }
  page.push(`${rgb(GREEN)} RG 0.8 w ${M} ${H - y - 10} 10 10 re S`)
  if (currentOrder?.declarationAccepted === true) page.push(`${rgb(GREEN)} RG 1.2 w ${M + 2} ${H - y - 6} m ${M + 4.3} ${H - y - 8.2} l ${M + 8.2} ${H - y - 2.2} l S`)
  text(M + 16, y, 'I/We have read, understood, and agree to the above terms prior to placing this medicine order.', 7.2, 'F2', INK)
  y += 21
  if (y + 82 > H - 62) { addPage(true); section('Buyer acknowledgment & signature (continued)') }
  const buyerName = profile.shopName || currentOrder?.shopName || '-'
  const currentOrderBusinessType = currentOrder?.businessType || profile.businessType
  const signatory = currentOrder?.authorizedSignatoryName || (currentOrderBusinessType === 'Partnership'
    ? [currentOrder?.partnerOne || profile.partnerOne, currentOrder?.partnerTwo || profile.partnerTwo].filter(Boolean).join(' / ')
    : profile.ownerName || currentOrder?.ownerName || '-')
  text(M, y, 'BUYER / PHARMACY NAME', 6.2, 'F2', MUTED)
  wrap(buyerName, 30).slice(0, 2).forEach((line, index) => text(M, y + 11 + index * 9, line, 7.5, 'F2', INK))
  rule(M, y + 59, 204)
  text(216, y, 'AUTHORIZED SIGNATORY', 6.2, 'F2', MUTED)
  if (signatureImage) drawSignature(216, y + 8, 181, 27)
  wrap(signatory, 31).slice(0, 2).forEach((line, index) => text(216, y + 37 + index * 8, line, 7.2, 'F2', INK))
  rule(216, y + 59, 397)
  text(413, y, 'DATE', 6.2, 'F2', MUTED)
  text(413, y + 11, dateTime(currentOrder?.date), 7.4, 'F1', INK)
  rule(413, y + 59, W - M)
  text(216, y + 63, signatureImage ? 'CLIENT SIGNATURE (EXTRACTED BLACK INK)' : 'NO CLIENT SIGNATURE ON FILE', 5.8, 'F2', signatureImage ? GREEN : MUTED)
  y += 76

  section(`Customer account order history (${orders.length} orders)`)
  const headers = [M + 4, 110, 199, 384, 442, 501]
  ;[['ORDER', headers[0]], ['DATE / STATUS', headers[1]], ['ITEMS', headers[2]], ['DUE', headers[3]], ['PAID', headers[4]], ['BALANCE', headers[5]]].forEach(([label, x]) => text(x, y, label, 6.3, 'F2', MUTED))
  y += 14
  rule(M, y, W - M, GREEN, 0.8)
  y += 5
  const ledgerOrders = [...orders].sort((a, b) => String(b.date).localeCompare(String(a.date)))
  for (const order of ledgerOrders) {
    const items = wrap((order.items || []).map(item => `${item.name} - ${item.quantity}`).join(', ') || '-', 41).slice(0, 3)
    const rowH = Math.max(25, items.length * 9 + 9)
    if (y + rowH > H - 54) { addPage(true); section(`Customer account order history (${orders.length} orders)  |  continued`); y += 4 }
    text(headers[0], y + 4, order.id, 7, 'F2', order.id === currentOrder?.id ? GREEN : INK)
    const date = dateTime(order.date)
    wrap(`${date} / ${order.status || 'Submitted'}`, 23).slice(0, 2).forEach((line, index) => text(headers[1], y + 3 + index * 9, line, 6.3, 'F1', MUTED))
    items.forEach((line, index) => text(headers[2], y + 3 + index * 9, line, 6.4, 'F1', INK))
    right(435, y + 4, money(order.amountDue), 6.4, 'F1', INK)
    right(493, y + 4, money(order.amountPaid), 6.4, 'F1', INK)
    right(W - M - 4, y + 4, money(order.status === 'Cancelled' ? 0 : Math.max(0, Number(order.amountDue || 0) - Number(order.amountPaid || 0))), 6.4, 'F2', INK)
    y += rowH
    rule(M, y, W - M, LINE, 0.35)
  }
  const totalDue = orders.reduce((sum, order) => sum + (order.status === 'Cancelled' ? 0 : Number(order.amountDue || 0)), 0)
  const totalPaid = orders.reduce((sum, order) => sum + Number(order.amountPaid || 0), 0)
  const outstanding = orders.reduce((sum, order) => sum + (order.status === 'Cancelled' ? 0 : Math.max(0, Number(order.amountDue || 0) - Number(order.amountPaid || 0))), 0)
  y += 12
  if (y + 62 > H - 54) addPage(true)
  fill(M, y, W - M * 2, 54, [0.91, 0.94, 0.90])
  text(M + 11, y + 8, 'CUMULATIVE CUSTOMER ACCOUNT SUMMARY', 7, 'F2', GREEN)
  text(M + 11, y + 25, `Total orders: ${orders.length}`, 8, 'F1', INK)
  text(M + 150, y + 25, `Total billed: ${money(totalDue)}`, 8, 'F1', INK)
  text(M + 315, y + 25, `Total paid: ${money(totalPaid)}`, 8, 'F1', INK)
  text(M + 11, y + 40, `NET OUTSTANDING BALANCE: ${money(outstanding)}`, 9, 'F2', INK)
  text(M + 315, y + 40, `Documents on profile: ${['ownerPhoto', 'gstCopy', 'drugLicense', 'signature'].filter(key => profile.attachments?.[key]).length}`, 7.5, 'F1', MUTED)
  return documentBlob(pages, { signatureImage, profilePhotoImage })
}

export function createPaymentReceiptPdf({ profile, order, payment, generatedAt = new Date() }) {
  const page = []
  const rgb = color => color.map(value => value.toFixed(3)).join(' ')
  const fill = (x, top, width, height, color) => page.push(`${rgb(color)} rg ${x} ${H - top - height} ${width} ${height} re f`)
  const rule = (top, color = LINE) => page.push(`${rgb(color)} RG 0.6 w ${M} ${H - top} m ${W - M} ${H - top} l S`)
  const text = (x, top, value, size = 9, font = 'F1', color = INK) => page.push(`${rgb(color)} rg BT /${font} ${size} Tf 1 0 0 1 ${x} ${H - top - size} Tm (${escaped(value)}) Tj ET`)
  const field = (label, value, top) => {
    text(M, top, label.toUpperCase(), 7, 'F2', MUTED)
    wrap(value || '-', 75).slice(0, 2).forEach((line, index) => text(M, top + 13 + index * 11, line, 9, 'F1', INK))
    rule(top + 38, [0.90, 0.92, 0.89])
  }
  fill(0, 0, W, 130, GREEN)
  text(M, 25, 'GOURI AGENCY  |  PAYMENT CONFIRMATION', 8, 'F2', [0.91, 0.95, 0.91])
  text(M, 50, 'PAYMENT RECEIPT', 23, 'F2', [1, 1, 1])
  text(M, 88, 'Digitally generated receipt for a payment recorded against the customer account.', 8, 'F1', [0.91, 0.95, 0.91])
  fill(426, 153, 131, 75, SOFT)
  text(438, 165, 'RECEIPT REFERENCE', 6.5, 'F2', MUTED)
  text(438, 181, payment.id || '-', 11, 'F2', GREEN)
  text(M, 153, profile.shopName || order.shopName || 'Customer', 14, 'F2', INK)
  text(M, 176, `GSTIN: ${profile.gstNumber || order.gstNumber || '-'}`, 8, 'F1', MUTED)
  text(M, 191, `Drug license: ${profile.drugLicenseNumber || order.drugLicenseNumber || '-'}  |  Expires: ${profile.drugLicenseExpiresAt || order.drugLicenseExpiresAt || 'Not recorded'}`, 8, 'F1', MUTED)
  text(M, 206, `${profile.email || order.email || '-'}  |  ${profile.mobile || order.mobile || '-'}`, 8, 'F1', MUTED)
  text(M, 230, 'PAYMENT DETAILS', 8.5, 'F2', GREEN)
  rule(248, GREEN)
  field('Order number', order.id, 264)
  field('Payment date and time (IST)', dateTime(payment.paidAt || payment.reviewedAt || payment.submittedAt), 309)
  field('Payment method', payment.provider || 'Payment', 354)
  field('Transaction / bank reference', payment.reference || payment.razorpayPaymentId || payment.razorpayOrderId || '-', 399)
  field('Payment status', payment.status === 'Paid' ? 'Captured' : payment.status, 444)
  const due = Number(order.amountDue || 0), paid = Number(order.amountPaid || 0)
  fill(M, 510, W - M * 2, 103, [0.95, 0.965, 0.94])
  text(M + 14, 526, 'AMOUNT RECEIVED', 7, 'F2', MUTED)
  text(M + 14, 544, money(payment.amount), 19, 'F2', GREEN)
  rule(575, [0.82, 0.86, 0.81])
  text(M + 14, 589, `Order billed: ${money(due)}`, 8, 'F1', INK)
  text(M + 190, 589, `Total paid: ${money(paid)}`, 8, 'F1', INK)
  text(M + 365, 589, `Balance: ${money(Math.max(0, due - paid))}`, 8, 'F2', INK)
  text(M, 645, `Generated ${dateTime(generatedAt)} IST`, 8, 'F1', MUTED)
  text(M, 668, 'This receipt confirms the payment recorded above. It is not a tax invoice.', 8, 'F1', MUTED)
  return documentBlob([page])
}
