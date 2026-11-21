const PAGE_WIDTH = 595
const PAGE_HEIGHT = 842
const MARGIN = 42
const DAY_MS = 24 * 60 * 60 * 1000
const TIME_ZONE = 'Asia/Kolkata'

function shopDateKey(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).map(part => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function shiftDate(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

function shiftMonth(dateKey, months) {
  const [year, month, day] = dateKey.split('-').map(Number)
  const target = new Date(Date.UTC(year, month - 1 + months, 1))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(day, lastDay))
  return target.toISOString().slice(0, 10)
}

export function getStatementPeriodRange(period, now = new Date()) {
  const today = shopDateKey(now)
  const [year, month] = today.split('-').map(Number)
  if (period === '7d') return { start: shiftDate(today, -6), end: today }
  if (period === '15d') return { start: shiftDate(today, -14), end: today }
  if (period === '1m') return { start: shiftMonth(today, -1), end: today }
  if (period === '6m') return { start: shiftMonth(today, -6), end: today }
  const currentFyStartYear = month >= 4 ? year : year - 1
  if (period === 'current-fy') return { start: `${currentFyStartYear}-04-01`, end: today }
  if (period === 'last-fy') return { start: `${currentFyStartYear - 1}-04-01`, end: `${currentFyStartYear}-03-31` }
  return { start: '', end: '' }
}

function pdfSafe(value) {
  return String(value ?? '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/₹/g, 'INR ').replace(/[–—]/g, '-').replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"').replace(/·/g, '-').replace(/•/g, '-')
    .replace(/[^\x20-\x7E]/g, '?')
}

function escapePdf(value) {
  return pdfSafe(value).replace(/([\\()])/g, '\\$1')
}

function pdfDate(dateKey) {
  const date = new Date(`${dateKey}T12:00:00Z`)
  return new Intl.DateTimeFormat('en-IN', { timeZone: TIME_ZONE, day: '2-digit', month: 'short', year: 'numeric' }).format(date)
}

function pdfTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('en-IN', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: true }).format(date)
}

function pdfDateTime(date) {
  return new Intl.DateTimeFormat('en-IN', { timeZone: TIME_ZONE, dateStyle: 'medium', timeStyle: 'medium' }).format(date)
}

function pdfMoney(value) {
  return `INR ${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function dateKeyFromValue(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : shopDateKey(date)
}

function wrappedLines(value, maxCharacters, maxLines = Infinity) {
  const words = pdfSafe(value).trim().split(/\s+/).filter(Boolean)
  const lines = []
  let line = ''
  for (const word of words) {
    const parts = word.length > maxCharacters ? word.match(new RegExp(`.{1,${maxCharacters}}`, 'g')) : [word]
    for (const part of parts) {
      const next = line ? `${line} ${part}` : part
      if (next.length > maxCharacters && line) { lines.push(line); line = part }
      else line = next
      if (lines.length >= maxLines) break
    }
    if (lines.length >= maxLines) break
  }
  if (line && lines.length < maxLines) lines.push(line)
  const totalWordsText = words.join(' ')
  if (lines.length === maxLines && lines.join(' ').length < totalWordsText.length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/\.{1,3}$/, '')}...`
  }
  return lines
}

function moneyColumn(value) {
  return pdfMoney(value)
}

export function createStatementPdf({ profile, orders = [], fromDate, toDate, generatedAt = new Date() }) {
  const allOrders = [...orders]
  const ordersInPeriod = allOrders.filter(order => {
    const date = dateKeyFromValue(order.date)
    return date && date >= fromDate && date <= toDate
  }).sort((a, b) => String(a.date).localeCompare(String(b.date)))
  const paymentsInPeriod = allOrders.flatMap(order => (order.payments || []).flatMap(payment => {
    const activity = []
    const paymentDate = payment.paidAt || payment.reviewedAt || payment.submittedAt
    const paymentDateKey = dateKeyFromValue(paymentDate)
    if (paymentDateKey && paymentDateKey >= fromDate && paymentDateKey <= toDate) activity.push({ order, payment, date: paymentDate, kind: 'payment' })
    for (const refund of payment.refunds || []) {
      if (refund.allocationOrderId && refund.allocationOrderId !== order.id) continue
      const refundDate = refund.processedAt || refund.updatedAt || refund.createdAt
      const refundDateKey = dateKeyFromValue(refundDate)
      if (refundDateKey && refundDateKey >= fromDate && refundDateKey <= toDate) activity.push({ order, payment, refund, date: refundDate, kind: 'refund' })
    }
    return activity
  })).sort((a, b) => String(a.date).localeCompare(String(b.date)))
  const totalDue = allOrders.reduce((sum, order) => sum + (order.status === 'Cancelled' ? 0 : Number(order.amountDue || 0)), 0)
  const totalPaid = allOrders.reduce((sum, order) => sum + Number(order.amountPaid || 0), 0)
  const outstanding = allOrders.reduce((sum, order) => sum + (order.status === 'Cancelled' ? 0 : Math.max(0, Number(order.amountDue || 0) - Number(order.amountPaid || 0))), 0)
  const confirmedPaymentsInPeriod = paymentsInPeriod.reduce((sum, row) => {
    if (row.kind === 'refund') return row.refund.status === 'processed' ? sum - Number(row.refund.amount || 0) : sum
    return ['Paid', 'Verified'].includes(row.payment.status) ? sum + Number(row.payment.amountApplied ?? row.payment.amount ?? 0) : sum
  }, 0)

  const pages = []
  let commands = []
  let cursor = 0
  const color = (r, g, b) => `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)}`
  const fillRect = (x, top, width, height, rgb) => commands.push(`${color(...rgb)} rg ${x} ${PAGE_HEIGHT - top - height} ${width} ${height} re f`)
  const line = (x1, top1, x2, top2, rgb = [0.86, 0.89, 0.86], width = 0.6) => commands.push(`${color(...rgb)} RG ${width} w ${x1} ${PAGE_HEIGHT - top1} m ${x2} ${PAGE_HEIGHT - top2} l S`)
  const text = (x, top, value, size = 9, font = 'F1', rgb = [0.15, 0.21, 0.17]) => {
    commands.push(`${color(...rgb)} rg BT /${font} ${size} Tf 1 0 0 1 ${x} ${PAGE_HEIGHT - top - size} Tm (${escapePdf(value)}) Tj ET`)
  }
  const rightText = (right, top, value, size = 8, font = 'F1', rgb = [0.15, 0.21, 0.17]) => {
    const clean = pdfSafe(value)
    text(right - clean.length * size * 0.48, top, clean, size, font, rgb)
  }
  const paragraph = (value, x, top, maxCharacters, size = 9, lineHeight = 13, font = 'F1', rgb = [0.32, 0.38, 0.33], maxLines = Infinity) => {
    const lines = wrappedLines(value, maxCharacters, maxLines)
    lines.forEach((item, index) => text(x, top + index * lineHeight, item, size, font, rgb))
    return top + lines.length * lineHeight
  }
  const startPage = first => {
    commands = []
    pages.push(commands)
    fillRect(0, 0, PAGE_WIDTH, first ? 108 : 56, [0.13, 0.22, 0.18])
    text(MARGIN, 24, 'GOURI AGENCY  |  WHOLESALE DISTRIBUTION', 9, 'F2', [0.91, 0.95, 0.90])
    text(MARGIN, first ? 47 : 29, first ? 'CLIENT ACCOUNT STATEMENT' : 'ACCOUNT STATEMENT  |  CONTINUED', first ? 21 : 12, 'F2', [1, 1, 1])
    if (first) {
      text(MARGIN, 82, `Period: ${pdfDate(fromDate)} to ${pdfDate(toDate)}`, 9, 'F1', [0.91, 0.95, 0.90])
      rightText(PAGE_WIDTH - MARGIN, 82, `Generated: ${pdfDateTime(generatedAt)} IST`, 7, 'F1', [0.91, 0.95, 0.90])
      cursor = 128
    } else cursor = 77
  }
  const ensureSpace = height => { if (cursor + height > PAGE_HEIGHT - 44) startPage(false) }
  const sectionTitle = title => {
    ensureSpace(28)
    text(MARGIN, cursor, title.toUpperCase(), 9, 'F2', [0.25, 0.36, 0.28])
    line(MARGIN, cursor + 17, PAGE_WIDTH - MARGIN, cursor + 17)
    cursor += 25
  }
  const tableHeader = (top, columns) => {
    fillRect(MARGIN, top, PAGE_WIDTH - MARGIN * 2, 22, [0.93, 0.95, 0.92])
    columns.forEach(column => text(column.x, top + 7, column.label, 7, 'F2', [0.32, 0.39, 0.33]))
  }

  startPage(true)
  text(MARGIN, cursor, profile.shopName || 'Customer account', 15, 'F2', [0.12, 0.19, 0.15])
  cursor += 23
  text(MARGIN, cursor, `GST: ${profile.gstNumber || 'Not provided'}`, 8, 'F1', [0.36, 0.42, 0.37])
  text(310, cursor, `Drug License: ${profile.drugLicenseNumber || 'Not provided'}`, 8, 'F1', [0.36, 0.42, 0.37])
  cursor += 14
  text(MARGIN, cursor, `Drug License Expiry: ${profile.drugLicenseExpiresAt || 'Not recorded'}`, 8, 'F1', [0.36, 0.42, 0.37])
  cursor += 14
  text(MARGIN, cursor, `Contact: ${profile.email || '-'}  |  ${profile.mobile || '-'}`, 8, 'F1', [0.36, 0.42, 0.37])
  cursor += 14
  paragraph(profile.shopAddress || '', MARGIN, cursor, 95, 8, 11, 'F1', [0.36, 0.42, 0.37], 2)
  cursor += 16

  sectionTitle('Current account summary')
  const cardGap = 9
  const cardWidth = (PAGE_WIDTH - MARGIN * 2 - cardGap * 2) / 3
  const cards = [
    ['TOTAL DUES', totalDue, [0.95, 0.96, 0.94]],
    ['TOTAL PAID', totalPaid, [0.95, 0.96, 0.94]],
    ['OUTSTANDING', outstanding, [0.91, 0.95, 0.90]]
  ]
  cards.forEach(([label, amount, rgb], index) => {
    const x = MARGIN + index * (cardWidth + cardGap)
    fillRect(x, cursor, cardWidth, 54, rgb)
    text(x + 11, cursor + 10, label, 7, 'F2', [0.42, 0.49, 0.43])
    text(x + 11, cursor + 27, moneyColumn(amount), 11, 'F2', [0.16, 0.25, 0.18])
  })
  cursor += 70
  paragraph(`For this period: ${ordersInPeriod.length} orders placed; ${pdfMoney(confirmedPaymentsInPeriod)} in payments verified or captured.`, MARGIN, cursor, 100, 8, 12)
  cursor += 22

  sectionTitle(`Orders placed during period (${ordersInPeriod.length})`)
  const orderColumns = [
    { x: MARGIN + 6, label: 'DATE / TIME' }, { x: 103, label: 'ORDER' }, { x: 158, label: 'SHOP / ITEMS' },
    { x: 366, label: 'DUE' }, { x: 425, label: 'PAID' }, { x: 482, label: 'BALANCE' }
  ]
  tableHeader(cursor, orderColumns)
  cursor += 22
  if (!ordersInPeriod.length) {
    text(MARGIN + 6, cursor + 9, 'No orders were placed during this statement period.', 8, 'F1', [0.44, 0.49, 0.45])
    cursor += 30
  } else {
    for (const order of ordersInPeriod) {
      const itemNames = (order.items || []).slice(0, 3).map(item => `${item.name} - ${item.quantity}`).join(', ')
      const moreItems = (order.items || []).length > 3 ? `, +${order.items.length - 3} more` : ''
      const details = `${order.shopName || 'Shop'} - ${itemNames || 'Order items'}${moreItems} - ${order.status || 'Submitted'}`
      const detailLines = wrappedLines(details, 39, 3)
      const rowHeight = Math.max(31, detailLines.length * 10 + 12)
      ensureSpace(rowHeight + 1)
      text(MARGIN + 5, cursor + 5, pdfDate(dateKeyFromValue(order.date)), 6, 'F1')
      text(MARGIN + 5, cursor + 16, `${pdfTime(order.date)} IST`, 6, 'F1', [0.44, 0.49, 0.45])
      text(103, cursor + 8, order.id, 7, 'F2')
      detailLines.forEach((item, index) => text(158, cursor + 6 + index * 10, item, 7, 'F1', [0.30, 0.36, 0.31]))
      rightText(416, cursor + 8, pdfMoney(order.amountDue), 7, 'F1')
      rightText(473, cursor + 8, pdfMoney(order.amountPaid), 7, 'F1')
      rightText(547, cursor + 8, pdfMoney(order.status === 'Cancelled' ? 0 : Math.max(0, Number(order.amountDue || 0) - Number(order.amountPaid || 0))), 7, 'F2')
      cursor += rowHeight
      line(MARGIN, cursor, PAGE_WIDTH - MARGIN, cursor, [0.91, 0.93, 0.91], 0.45)
    }
    cursor += 10
  }

  sectionTitle(`Payment activity and references (${paymentsInPeriod.length})`)
  const paymentColumns = [
    { x: MARGIN + 6, label: 'DATE / TIME' }, { x: 108, label: 'ORDER' }, { x: 163, label: 'PROVIDER / REFERENCE' },
    { x: 437, label: 'AMOUNT' }, { x: 495, label: 'STATUS' }
  ]
  tableHeader(cursor, paymentColumns)
  cursor += 22
  if (!paymentsInPeriod.length) {
    text(MARGIN + 6, cursor + 9, 'No payment activity was recorded during this statement period.', 8, 'F1', [0.44, 0.49, 0.45])
    cursor += 30
  } else {
    for (const row of paymentsInPeriod) {
      const { order, payment, refund, kind, date } = row
      const isRefund = kind === 'refund'
      const carrySummary = (payment.allocations || []).filter(allocation => allocation.role === 'carry-forward').map(allocation => `${allocation.orderId} ${pdfMoney(allocation.amount)}`).join(', ')
      const detail = isRefund
        ? `${payment.originalProvider || payment.provider || 'Payment'} refund - ${refund.id || refund.receipt || 'Reference pending'}`
        : `${payment.provider || 'Payment'} - ${payment.reference || payment.razorpayPaymentId || payment.razorpayOrderId || 'No reference'}${payment.allocationKind === 'carry-forward' ? ` · Credit from ${payment.sourceOrderId || 'earlier order'}` : carrySummary ? ` · Carried to ${carrySummary}` : ''}`
      const detailLines = wrappedLines(detail, 47, 2)
      const rowHeight = Math.max(30, detailLines.length * 10 + 11)
      ensureSpace(rowHeight + 1)
      text(MARGIN + 5, cursor + 5, pdfDate(dateKeyFromValue(date)), 6, 'F1')
      text(MARGIN + 5, cursor + 16, `${pdfTime(date)} IST`, 6, 'F1', [0.44, 0.49, 0.45])
      text(108, cursor + 8, order.id, 7, 'F2')
      detailLines.forEach((item, index) => text(163, cursor + 6 + index * 10, item, 7, 'F1', isRefund ? [0.52, 0.35, 0.31] : [0.30, 0.36, 0.31]))
      const amount = isRefund && refund.status === 'processed' ? -Number(refund.amount || 0) : isRefund ? Number(refund.amount || 0) : Number(payment.amountApplied ?? payment.amount ?? 0)
      rightText(484, cursor + 8, amount < 0 ? `-INR ${Math.abs(amount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : pdfMoney(amount), 7, 'F1')
      const status = isRefund ? `Refund ${refund.status === 'manual_review' ? 'agency review' : refund.status || 'pending'}` : payment.status || 'Unknown'
      const statusColor = isRefund && refund.status === 'processed' ? [0.24, 0.43, 0.28] : isRefund && refund.status === 'failed' ? [0.60, 0.25, 0.20] : [0.32, 0.39, 0.33]
      text(495, cursor + 8, status, 6.5, 'F2', statusColor)
      cursor += rowHeight
      line(MARGIN, cursor, PAGE_WIDTH - MARGIN, cursor, [0.91, 0.93, 0.91], 0.45)
    }
    cursor += 10
  }

  ensureSpace(40)
  cursor = paragraph('Statement notes: All timestamps are shown in India Standard Time (IST). Total dues and paid amounts show the current saved values for this client. Order rows are filtered by order date; payment and refund activity is filtered by the recorded transaction date. Processed refunds are shown as negative amounts; pending or failed refund requests remain listed with their status.', MARGIN, cursor, 104, 7, 10, 'F1', [0.43, 0.48, 0.44], 4) + 8
  ensureSpace(36)
  fillRect(MARGIN, cursor, PAGE_WIDTH - MARGIN * 2, 30, [0.93, 0.96, 0.92])
  text(MARGIN + 12, cursor + 10, 'This statement is digitally generated and is valid without a handwritten signature.', 8, 'F2', [0.22, 0.34, 0.25])

  pages.forEach((page, index) => {
    page.push(`0.84 0.87 0.84 RG 0.5 w ${MARGIN} 34 m ${PAGE_WIDTH - MARGIN} 34 l S`)
    page.push(`0.45 0.50 0.46 rg BT /F1 7 Tf 1 0 0 1 ${MARGIN} 20 Tm (Gouri Agency - Account statement) Tj ET`)
    page.push(`0.45 0.50 0.46 rg BT /F1 7 Tf 1 0 0 1 ${PAGE_WIDTH - MARGIN - 65} 20 Tm (Page ${index + 1} of ${pages.length}) Tj ET`)
  })

  const objects = new Map()
  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>')
  objects.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  objects.set(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')
  const pageObjectIds = []
  let nextObjectId = 5
  for (const page of pages) {
    const pageId = nextObjectId++
    const contentId = nextObjectId++
    pageObjectIds.push(pageId)
    const stream = page.join('\n')
    objects.set(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`)
    objects.set(contentId, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  }
  objects.set(2, `<< /Type /Pages /Kids [${pageObjectIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageObjectIds.length} >>`)
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (let id = 1; id < nextObjectId; id++) {
    offsets[id] = pdf.length
    pdf += `${id} 0 obj\n${objects.get(id)}\nendobj\n`
  }
  const xrefOffset = pdf.length
  pdf += `xref\n0 ${nextObjectId}\n0000000000 65535 f \n`
  for (let id = 1; id < nextObjectId; id++) pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${nextObjectId} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
  return new Blob([pdf], { type: 'application/pdf' })
}
