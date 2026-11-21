const PAGE_WIDTH = 1240
const PAGE_HEIGHT = 1754
const MARGIN = 92
const encoder = new TextEncoder()

function formatTimestamp(value) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'Date not recorded'
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata', timeZoneName: 'short'
  }).format(date)
}

function wrapText(context, text, maxWidth) {
  const lines = []
  for (const paragraph of String(text || '').replace(/\r/g, '').split('\n')) {
    if (!paragraph.trim()) { lines.push(''); continue }
    let line = ''
    for (const word of paragraph.trim().split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word
      if (context.measureText(candidate).width <= maxWidth || !line) {
        line = candidate
        continue
      }
      lines.push(line)
      line = word
    }
    if (line) lines.push(line)
  }
  return lines
}

function drawPage({ notice, pageNumber, pagesTotal, bodyLines, generatedAt }) {
  const canvas = document.createElement('canvas')
  canvas.width = PAGE_WIDTH
  canvas.height = PAGE_HEIGHT
  const context = canvas.getContext('2d')
  context.fillStyle = '#f4f6f3'
  context.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT)

  const header = context.createLinearGradient(0, 0, PAGE_WIDTH, 260)
  header.addColorStop(0, '#20352e')
  header.addColorStop(1, '#4b6857')
  context.fillStyle = header
  context.fillRect(0, 0, PAGE_WIDTH, 300)
  context.fillStyle = '#dbe6d9'
  context.font = '700 24px Arial, sans-serif'
  context.fillText('GOURI AGENCY', MARGIN, 68)
  context.textAlign = 'right'
  context.font = '500 16px Arial, sans-serif'
  context.fillText('OFFICIAL NOTICE', PAGE_WIDTH - MARGIN, 67)
  context.textAlign = 'left'
  context.fillStyle = notice.priority === 'high' ? '#ffd6d1' : '#d4e3d0'
  context.font = '700 14px Arial, sans-serif'
  context.fillText(notice.priority === 'high' ? 'IMPORTANT NOTICE' : 'INFORMATION', MARGIN, 119)
  context.fillStyle = '#ffffff'
  context.font = '700 43px Arial, sans-serif'
  let titleLines = wrapText(context, notice.title, PAGE_WIDTH - MARGIN * 2)
  if (titleLines.length > 2) titleLines = [...titleLines.slice(0, 1), `${titleLines[1].slice(0, 45).trimEnd()}…`]
  titleLines.forEach((line, index) => context.fillText(line, MARGIN, 181 + index * 55))
  context.fillStyle = '#dbe4dc'
  context.font = '16px Arial, sans-serif'
  context.fillText(`Published ${formatTimestamp(notice.createdAt)}`, MARGIN, 264)

  let cursor = 374
  const bodyX = MARGIN + 32
  const bodyWidth = PAGE_WIDTH - MARGIN * 2 - 64
  context.fillStyle = '#415e4e'
  context.beginPath()
  context.roundRect(MARGIN, 336, PAGE_WIDTH - MARGIN * 2, PAGE_HEIGHT - 486, 16)
  context.fill()
  context.fillStyle = '#ffffff'
  context.font = '22px Arial, sans-serif'
  for (const line of bodyLines) {
    if (!line) { cursor += 20; continue }
    context.fillText(line, bodyX, cursor, bodyWidth)
    cursor += 36
  }

  context.fillStyle = '#748078'
  context.font = '14px Arial, sans-serif'
  context.fillText(`Generated ${formatTimestamp(generatedAt)} · Digital notice`, MARGIN, PAGE_HEIGHT - 75)
  context.textAlign = 'right'
  context.fillText(`Page ${pageNumber} of ${pagesTotal}`, PAGE_WIDTH - MARGIN, PAGE_HEIGHT - 75)
  context.textAlign = 'left'
  context.fillStyle = '#415c50'
  context.font = '700 13px Arial, sans-serif'
  context.fillText('GOURI AGENCY  ·  BENACHITY, DURGAPUR-13', MARGIN, PAGE_HEIGHT - 46)
  return canvas
}

async function canvasJpeg(canvas) {
  const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Could not render notice PDF.')), 'image/jpeg', 0.92))
  return new Uint8Array(await blob.arrayBuffer())
}

function append(parts, chunk) {
  parts.push(chunk)
  return chunk.byteLength
}

export async function createNoticePdf(notice, generatedAt = new Date()) {
  if (!notice || typeof notice.title !== 'string' || typeof notice.body !== 'string') throw new Error('This notice cannot be downloaded.')
  const measureCanvas = document.createElement('canvas')
  const context = measureCanvas.getContext('2d')
  context.font = '22px Arial, sans-serif'
  const bodyLines = wrapText(context, notice.body, PAGE_WIDTH - MARGIN * 2 - 64)
  const linesPerPage = 29
  const groups = []
  for (let index = 0; index < bodyLines.length; index += linesPerPage) groups.push(bodyLines.slice(index, index + linesPerPage))
  if (!groups.length) groups.push([''])
  const canvases = groups.map((bodyGroup, index) => drawPage({ notice, pageNumber: index + 1, pagesTotal: groups.length, bodyLines: bodyGroup, generatedAt }))
  const images = await Promise.all(canvases.map(canvasJpeg))
  const pageIds = images.map((_, index) => 3 + index * 3)
  const objects = [
    { id: 1, data: [encoder.encode('<< /Type /Catalog /Pages 2 0 R >>')] },
    { id: 2, data: [encoder.encode(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`)] }
  ]
  images.forEach((image, index) => {
    const pageId = pageIds[index]
    const imageId = pageId + 1
    const contentId = pageId + 2
    objects.push({ id: pageId, data: [encoder.encode(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`)] })
    objects.push({ id: imageId, data: [encoder.encode(`<< /Type /XObject /Subtype /Image /Width ${PAGE_WIDTH} /Height ${PAGE_HEIGHT} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.byteLength} >>\nstream\n`), image, encoder.encode('\nendstream')] })
    const content = encoder.encode('q\n595 0 0 842 0 0 cm\n/Im0 Do\nQ')
    objects.push({ id: contentId, data: [encoder.encode(`<< /Length ${content.byteLength} >>\nstream\n`), content, encoder.encode('\nendstream')] })
  })
  const parts = []
  let length = append(parts, encoder.encode('%PDF-1.4\n'))
  const offsets = []
  for (const object of objects.sort((a, b) => a.id - b.id)) {
    offsets[object.id] = length
    length += append(parts, encoder.encode(`${object.id} 0 obj\n`))
    for (const chunk of object.data) length += append(parts, chunk)
    length += append(parts, encoder.encode('\nendobj\n'))
  }
  const xrefOffset = length
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let id = 1; id <= objects.length; id += 1) xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
  append(parts, encoder.encode(xref))
  return new Blob(parts, { type: 'application/pdf' })
}
