const PAGE_WIDTH = 1240
const PAGE_HEIGHT = 1754
const PAGE_BOTTOM = 1630
const PAGE_MARGIN = 78
const encoder = new TextEncoder()

function monthName(month, year) {
  return new Intl.DateTimeFormat('en-IN', { month: 'long', timeZone: 'Asia/Kolkata' }).format(new Date(Date.UTC(year, month - 1, 1, 12)))
}

function localDate(dateKey, options = { day: '2-digit', month: 'short', year: 'numeric' }) {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Intl.DateTimeFormat('en-IN', { ...options, timeZone: 'Asia/Kolkata' }).format(new Date(Date.UTC(year, month - 1, day, 12)))
}

function canvasText(context, value, x, y, maxWidth) {
  const text = String(value || '')
  if (!maxWidth || context.measureText(text).width <= maxWidth) { context.fillText(text, x, y); return }
  let result = text
  while (result.length > 1 && context.measureText(`${result}…`).width > maxWidth) result = result.slice(0, -1)
  context.fillText(`${result.trimEnd()}…`, x, y)
}

function makeCalendarPages({ year, calendar, generatedAt }) {
  const pages = []
  let context
  let pageCanvas
  let cursor
  let pageNumber = 0
  const months = Array.from({ length: 12 }, (_, index) => ({ month: index + 1, holidays: calendar.holidays.filter(item => Number(item.date.slice(5, 7)) === index + 1) }))

  const addPage = () => {
    pageNumber += 1
    pageCanvas = document.createElement('canvas')
    pageCanvas.width = PAGE_WIDTH
    pageCanvas.height = PAGE_HEIGHT
    context = pageCanvas.getContext('2d')
    context.fillStyle = '#f4f6f3'
    context.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT)
    const gradient = context.createLinearGradient(0, 0, PAGE_WIDTH, 250)
    gradient.addColorStop(0, '#21372f')
    gradient.addColorStop(1, '#456455')
    context.fillStyle = gradient
    context.fillRect(0, 0, PAGE_WIDTH, 270)
    context.fillStyle = '#95b46f'
    context.beginPath(); context.arc(PAGE_WIDTH - 130, 64, 13, 0, Math.PI * 2); context.fill()
    context.fillStyle = '#edf3e9'
    context.font = '700 22px Arial, sans-serif'
    context.fillText('GOURI AGENCY', PAGE_MARGIN, 68)
    context.fillStyle = '#d7e1d6'
    context.font = '500 17px Arial, sans-serif'
    context.fillText(`${calendar.region.toUpperCase()}  ·  PUBLIC HOLIDAY CALENDAR`, PAGE_MARGIN, 108)
    context.fillStyle = '#ffffff'
    context.font = '700 55px Arial, sans-serif'
    context.fillText('HOLIDAY CALENDAR', PAGE_MARGIN, 184)
    context.fillStyle = '#dfe9de'
    context.font = '500 29px Arial, sans-serif'
    context.fillText(String(year), PAGE_MARGIN, 229)
    context.textAlign = 'right'
    context.font = '16px Arial, sans-serif'
    context.fillText(`Prepared ${localDate(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(generatedAt))} · IST`, PAGE_WIDTH - PAGE_MARGIN, 225)
    context.textAlign = 'left'
    cursor = 306
    pages.push(pageCanvas)
  }

  const drawMonth = (month, continued = false) => {
    context.fillStyle = '#e5ede2'
    context.beginPath(); context.roundRect(PAGE_MARGIN, cursor, PAGE_WIDTH - PAGE_MARGIN * 2, 48, 10); context.fill()
    context.fillStyle = '#405b4a'
    context.font = '700 21px Arial, sans-serif'
    context.fillText(`${monthName(month, year).toUpperCase()}${continued ? '  ·  CONTINUED' : ''}`, PAGE_MARGIN + 17, cursor + 31)
    cursor += 58
  }

  addPage()
  for (const group of months) {
    if (cursor + 58 > PAGE_BOTTOM) addPage()
    drawMonth(group.month)
    if (!group.holidays.length) {
      context.fillStyle = '#ffffff'
      context.fillRect(PAGE_MARGIN, cursor, PAGE_WIDTH - PAGE_MARGIN * 2, 52)
      context.fillStyle = '#879189'
      context.font = 'italic 18px Arial, sans-serif'
      context.fillText('No holiday listed in this notification.', PAGE_MARGIN + 20, cursor + 33)
      cursor += 56
      continue
    }
    for (let index = 0; index < group.holidays.length; index += 1) {
      const holiday = group.holidays[index]
      const rowHeight = holiday.note ? 82 : 65
      if (cursor + rowHeight > PAGE_BOTTOM) { addPage(); drawMonth(group.month, true) }
      context.fillStyle = index % 2 === 0 ? '#ffffff' : '#fafbf9'
      context.fillRect(PAGE_MARGIN, cursor, PAGE_WIDTH - PAGE_MARGIN * 2, rowHeight)
      context.fillStyle = '#41604e'
      context.font = '30px "Segoe UI Emoji", "Apple Color Emoji", sans-serif'
      context.fillText(holiday.emoji || '📅', PAGE_MARGIN + 18, cursor + 39)
      const nameX = PAGE_MARGIN + 76
      context.fillStyle = '#25342c'
      context.font = '600 19px Arial, sans-serif'
      canvasText(context, holiday.name, nameX, cursor + 27, PAGE_WIDTH - PAGE_MARGIN * 2 - 310)
      context.fillStyle = '#768179'
      context.font = '15px Arial, sans-serif'
      context.fillText(holiday.category, nameX, cursor + 49)
      if (holiday.note) {
        context.fillStyle = '#9a7040'
        context.font = '13px Arial, sans-serif'
        canvasText(context, holiday.note, nameX, cursor + 69, PAGE_WIDTH - PAGE_MARGIN * 2 - 310)
      }
      const dayName = localDate(holiday.date, { weekday: 'short' })
      context.textAlign = 'right'
      context.fillStyle = '#33493b'
      context.font = '700 18px Arial, sans-serif'
      context.fillText(`${localDate(holiday.date)} · ${dayName}`, PAGE_WIDTH - PAGE_MARGIN - 18, cursor + 35)
      context.textAlign = 'left'
      context.strokeStyle = '#e8ece6'
      context.lineWidth = 1
      context.beginPath(); context.moveTo(PAGE_MARGIN, cursor + rowHeight); context.lineTo(PAGE_WIDTH - PAGE_MARGIN, cursor + rowHeight); context.stroke()
      cursor += rowHeight
    }
  }

  pages.forEach((canvas, index) => {
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#637068'
    ctx.font = '13px Arial, sans-serif'
    canvasText(ctx, `${calendar.notification}  ·  ${calendar.region}`, PAGE_MARGIN, PAGE_HEIGHT - 72, PAGE_WIDTH - PAGE_MARGIN * 2)
    canvasText(ctx, calendar.coverageNote || 'Dates may be amended by the relevant state government. Confirm current notices before planning.', PAGE_MARGIN, PAGE_HEIGHT - 48, PAGE_WIDTH - PAGE_MARGIN * 2 - 170)
    ctx.textAlign = 'right'
    ctx.fillText(`Page ${index + 1} of ${pages.length}`, PAGE_WIDTH - PAGE_MARGIN, PAGE_HEIGHT - 48)
    ctx.textAlign = 'left'
    ctx.fillStyle = '#42604e'
    ctx.font = '700 13px Arial, sans-serif'
    const sourceLine = calendar.attribution
      ? 'Data: IndiaDigital (CC BY 4.0). Primary source: Reserve Bank of India Holiday Matrix.'
      : `Source: ${calendar.sourceLabel || calendar.notification}`
    canvasText(ctx, sourceLine, PAGE_MARGIN, PAGE_HEIGHT - 25, PAGE_WIDTH - PAGE_MARGIN * 2)
  })
  return pages
}

function append(parts, chunk) {
  parts.push(chunk)
  return chunk.byteLength
}

async function canvasJpeg(canvas) {
  const blob = await new Promise((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('Could not render the holiday PDF page.')), 'image/jpeg', 0.9))
  return new Uint8Array(await blob.arrayBuffer())
}

export async function createHolidayCalendarPdf({ year, calendar, generatedAt = new Date() }) {
  const pages = makeCalendarPages({ year, calendar, generatedAt })
  const images = await Promise.all(pages.map(canvasJpeg))
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
